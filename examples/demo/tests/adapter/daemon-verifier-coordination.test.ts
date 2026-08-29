import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  buildDeliveryEnvelope,
  type ActionPackage,
  type ActionRequest,
  type ActionResponse,
  type CoordinationDeliveryResponse,
  type CoordinationNotificationConnection,
  type CoordinationPollResponse,
  type CoordinationWebSocket,
  type DeliveryEnvelope,
  type Did,
} from "@oma3/mpas";
import { startDaemon } from "../../src/adapter/daemon.js";
import type {
  VerifierCoordinationClient,
  VerifierCoordinationState,
  VerifierCoordinationStateStore,
} from "../../src/adapter/verifier-coordination-worker.js";

const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
const coordinationUrl = "https://coordination.example";

describe("Credential Adapter hosted-Verifier integration", () => {
  it("polls, processes through Fastify, journals, and delivers the Verifier response", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "mpas-daemon-verifier-"));
    const configDir = join(workspace, "config");
    const credentialDir = join(workspace, "credentials");
    await mkdir(configDir, { recursive: true });
    await mkdir(credentialDir, { recursive: true });

    const config = JSON.parse(await readFile(
      join(fixtures, "configs", "policy-fixtures", "github-auto-approve.json"),
      "utf8",
    )) as Record<string, unknown>;
    config.plugin = {
      ...(config.plugin as Record<string, unknown>),
      path: join(fixtures, "plugins", "github-mirror-plugin.json"),
    };
    await writeFile(join(configDir, "github-auto-approve.json"), `${JSON.stringify(config, null, 2)}\n`);
    const credentialPath = join(credentialDir, "github-mirror-token.json");
    await writeFile(credentialPath, `${JSON.stringify({ value: "ghp_test" })}\n`, { mode: 0o600 });
    await chmod(credentialPath, 0o600);

    const adapterKeyPath = join(fixtures, "test-keys", "adapter.json");
    const adapterKey = JSON.parse(await readFile(adapterKeyPath, "utf8")) as { did: Did };
    const actionPackage = JSON.parse(await readFile(
      join(fixtures, "core", "valid-no-approval-required.json"),
      "utf8",
    )) as ActionPackage;
    const requestEnvelope = buildDeliveryEnvelope({
      sender: actionPackage.actionEnvelope.proposer.did,
      recipients: [adapterKey.did],
      payload: {
        version: "1",
        type: "ActionRequest",
        actionPackage,
      } satisfies ActionRequest,
    });
    const client = new FakeCoordinationClient(requestEnvelope);
    const stateStore = new MemoryStateStore();
    const journalPath = join(workspace, "dispatch-ledger.jsonl");
    const events: string[] = [];

    const daemon = await startDaemon({
      configDir,
      credentialDir,
      adapterKeyPath,
      journalPath,
      port: 0,
      maxEnvelopeValidityMs: Number.MAX_SAFE_INTEGER,
      trustContext: null,
      confirmPluginUse: async () => true,
      verifierCoordinationUrl: coordinationUrl,
      verifierCoordinationClient: client,
      verifierCoordinationStateStore: stateStore,
      verifierCoordinationEventSink: (event) => events.push(event.event),
    });

    try {
      await vi.waitFor(() => expect(client.submissions).toHaveLength(1));

      expect(client.submissions[0]).toMatchObject({
        sender: adapterKey.did,
        recipients: [actionPackage.actionEnvelope.proposer.did],
        payload: {
          type: "ActionResponse",
          result: "executed",
          executionReceipt: { type: "ExecutionReceipt" },
        },
      });
      expect(stateStore.state?.cursor).toBe("cursor-1");
      expect(events).toContain("connected");
      expect(events).toContain("page_processed");
      const journal = await readFile(journalPath, "utf8");
      expect(journal).toContain('"event":"executing"');
      expect(journal).toContain('"event":"resolved"');
      expect(journal).toContain('"response":{"version":"1","type":"ActionResponse"');
    } finally {
      await daemon.app.close();
    }

    expect(client.socket.close).toHaveBeenCalled();
  });
});

class MemoryStateStore implements VerifierCoordinationStateStore {
  state?: VerifierCoordinationState;

  async load(identity: { coordinationUrl: string; verifierDid: Did }): Promise<VerifierCoordinationState> {
    return {
      version: "1",
      type: "MpasVerifierCoordinationState",
      coordinationUrl: identity.coordinationUrl,
      verifierDid: identity.verifierDid,
      responses: {},
    };
  }

  async save(state: VerifierCoordinationState): Promise<void> {
    this.state = structuredClone(state);
  }
}

class FakeSocket implements CoordinationWebSocket {
  readonly close = vi.fn(() => this.emit("close"));
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: "message" | "close" | "error", listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: "message" | "close" | "error", listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  private emit(type: "message" | "close" | "error"): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type });
  }
}

class FakeCoordinationClient implements VerifierCoordinationClient {
  readonly socket = new FakeSocket();
  readonly submissions: DeliveryEnvelope<ActionResponse>[] = [];

  constructor(private readonly delivery: DeliveryEnvelope<ActionRequest>) {}

  async pollWork(options: { cursor?: string } = {}): Promise<CoordinationPollResponse> {
    return options.cursor
      ? {
          version: "1",
          type: "CoordinationPollResponse",
          approvalRequests: [],
          actionUpdates: [],
          deliveries: [],
          nextCursor: options.cursor,
        }
      : {
          version: "1",
          type: "CoordinationPollResponse",
          approvalRequests: [],
          actionUpdates: [],
          deliveries: [this.delivery as unknown as DeliveryEnvelope],
          nextCursor: "cursor-1",
        };
  }

  async submitActionResponseDelivery(
    envelope: DeliveryEnvelope<ActionResponse>,
  ): Promise<CoordinationDeliveryResponse> {
    this.submissions.push(structuredClone(envelope));
    return { version: "1", type: "CoordinationDeliveryResponse", accepted: true };
  }

  async connectWorkNotifications(input: {
    onWorkAvailable: () => void | Promise<void>;
  }): Promise<CoordinationNotificationConnection> {
    void input;
    return {
      socket: this.socket,
      coordinationUrl,
      audience: coordinationUrl,
      did: this.delivery.recipients[0]!,
    };
  }
}
