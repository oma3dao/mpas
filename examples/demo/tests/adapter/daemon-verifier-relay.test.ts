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
  type RelayDeliveryResponse,
  type RelayNotificationConnection,
  type RelayPollResponse,
  type ActionRelayWebSocket,
  type DeliveryEnvelope,
  type Did,
} from "@oma3/mpas";
import * as adapterApi from "../../src/adapter/adapter-api-server.js";
import { startDaemon } from "../../src/adapter/daemon.js";
import type {
  VerifierRelayClient,
  VerifierRelayState,
  VerifierRelayStateStore,
} from "../../src/adapter/verifier-relay-worker.js";

/** Deterministic clock pinned inside the fixture validity window. */
const FIXTURE_NOW = Date.parse("2026-06-05T19:00:00.000Z");

const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
const relayUrl = "https://relay.example";

describe("Credential Adapter hosted-Verifier integration", () => {
  it.each(["matched", "drift", "legacy", "unavailable"] as const)("warns only for real startup drift (%s)", async status => {
    const workspace = await mkdtemp(join(tmpdir(), "mpas-daemon-surface-"));
    const configDir = join(workspace, "config");
    await mkdir(configDir);
    const config = JSON.parse(await readFile(join(fixtures, "configs", "policy-fixtures", "github-auto-approve.json"), "utf8"));
    config.plugin.path = join(fixtures, "plugins", "github-mirror-plugin.json");
    await writeFile(join(configDir, "github.json"), JSON.stringify(config));
    const report: adapterApi.ToolSurfaceDrift = { status, missingTools: ["get_teams"], unknownTools: [],
      ungovernedTools: ["a"], schemaDrift: status === "drift" };
    const probe = vi.spyOn(adapterApi, "inspectTargetSurface").mockResolvedValue(report);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
    try {
      daemon = await startDaemon({ configDir, credentialDir: join(workspace, "credentials"),
        adapterKeyPath: join(fixtures, "test-keys", "adapter.json"),
        journalPath: join(workspace, "journal.jsonl"), port: 0, trustContext: null,
        confirmPluginUse: async () => true,
      });
      const warnings = warn.mock.calls.map(call => String(call[0])).filter(message => message.includes('"event":"tool_surface_drift"'));
      expect(warnings).toHaveLength(status === "drift" ? 1 : 0);
      if (status !== "drift") expect(info).toHaveBeenCalledWith(expect.stringContaining('"event":"tool_surface_diagnostic"'));
      const health = await daemon.app.inject({ method: "GET", url: "/mpas/v1/health" });
      expect(health.json().loadedConfigs[0].toolSurfaceDrift).toEqual(report);
    } finally {
      await daemon?.app.close();
      probe.mockRestore(); warn.mockRestore(); info.mockRestore();
    }
  });

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
      now: FIXTURE_NOW,
      trustContext: null,
      confirmPluginUse: async () => true,
      verifierRelayUrl: relayUrl,
      verifierRelayClient: client,
      verifierRelayStateStore: stateStore,
      verifierRelayEventSink: (event) => events.push(event.event),
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

class MemoryStateStore implements VerifierRelayStateStore {
  state?: VerifierRelayState;

  async load(identity: { relayUrl: string; verifierDid: Did }): Promise<VerifierRelayState> {
    return {
      version: "1",
      type: "MpasVerifierRelayState",
      relayUrl: identity.relayUrl,
      verifierDid: identity.verifierDid,
      responses: {},
    };
  }

  async save(state: VerifierRelayState): Promise<void> {
    this.state = structuredClone(state);
  }
}

class FakeSocket implements ActionRelayWebSocket {
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

class FakeCoordinationClient implements VerifierRelayClient {
  readonly socket = new FakeSocket();
  readonly submissions: DeliveryEnvelope<ActionResponse>[] = [];

  constructor(private readonly delivery: DeliveryEnvelope<ActionRequest>) {}

  async pollDeliveries(options: { cursor?: string } = {}): Promise<RelayPollResponse> {
    return options.cursor
      ? {
          version: "1",
          type: "RelayPollResponse",
          deliveries: [],
          nextCursor: options.cursor,
        }
      : {
          version: "1",
          type: "RelayPollResponse",
          deliveries: [this.delivery as unknown as DeliveryEnvelope],
          nextCursor: "cursor-1",
        };
  }

  async submitActionResponse(
    envelope: DeliveryEnvelope<ActionResponse>,
  ): Promise<RelayDeliveryResponse> {
    this.submissions.push(structuredClone(envelope));
    return { version: "1", type: "RelayDeliveryResponse", accepted: true };
  }

  async connectWorkNotifications(input: {
    onWorkAvailable: () => void | Promise<void>;
  }): Promise<RelayNotificationConnection> {
    void input;
    return {
      socket: this.socket,
      relayUrl,
      audience: relayUrl,
      did: this.delivery.recipients[0]!,
    };
  }
}
