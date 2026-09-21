import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  buildDeliveryEnvelope,
  computeJsonHash,
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
import { startDaemon } from "../../src/adapter/daemon.js";
import { DispatchLedger, FileDispatchJournal } from "../../src/adapter/dispatch-ledger.js";
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
  it.each(["executed", "interrupted"])("recovers exact %s responses across daemon restart without retransmission", async mode => {
    const workspace = await mkdtemp(join(realpathSync(tmpdir()), "mpas-daemon-verifier-"));
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
    const targetCalls = join(workspace, "target-calls.jsonl");
    const targetScript = join(workspace, "target.mjs");
    await writeFile(targetScript, `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
createInterface({input:process.stdin}).on("line", line => {
  const message = JSON.parse(line);
  if (message.method !== "initialize" && message.method !== "tools/call") return;
  if (message.method === "tools/call") appendFileSync(${JSON.stringify(targetCalls)}, JSON.stringify({pid:process.pid})+"\\n");
  const result = message.method === "initialize"
    ? {protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"relay-counted-target",version:"1"}}
    : {content:[{type:"text",text:"durable relay target result"}]};
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,result})+"\\n");
});
`);
    config.executionTarget = { type: "mcp.stdio", command: process.execPath, args: [targetScript], timeoutMs: 1000 };
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
    if (mode === "interrupted") {
      const previous = new DispatchLedger(new FileDispatchJournal(journalPath), () => FIXTURE_NOW);
      previous.authorizeDispatch(actionPackage.actionEnvelope.actionId,
        computeJsonHash(actionPackage.actionEnvelope), actionPackage.actionEnvelope.expiresAt);
      previous.close();
    }

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
          result: mode === "executed" ? "executed" : "indeterminate",
          executionReceipt: { type: "ExecutionReceipt" },
        },
      });
      expect(stateStore.state?.cursor).toBe("cursor-1");
      expect(events).toContain("connected");
      expect(events).toContain("page_processed");
    } finally {
      await daemon.app.close();
    }

    expect(client.socket.close).toHaveBeenCalled();
    const reopened = new DispatchLedger(new FileDispatchJournal(journalPath));
    try {
      expect(reopened.recoveryFor(actionPackage.actionEnvelope.actionId,
        computeJsonHash(actionPackage.actionEnvelope))?.response).toEqual(client.submissions[0].payload);
      expect(reopened.check(actionPackage.actionEnvelope.actionId,
        computeJsonHash(actionPackage.actionEnvelope))).toMatchObject({ kind: "reject", code: "REPLAY_DETECTED" });
    } finally { reopened.close(); }

    // A fresh relay cursor/cache must still recover the ledger's exact receipt.
    const secondClient = new FakeCoordinationClient(requestEnvelope);
    const restarted = await startDaemon({ configDir, credentialDir, adapterKeyPath, journalPath,
      port: 0, maxEnvelopeValidityMs: Number.MAX_SAFE_INTEGER, trustContext: null,
      confirmPluginUse: async () => true, verifierRelayUrl: relayUrl, verifierRelayClient: secondClient,
      verifierRelayStateStore: new MemoryStateStore(), verifierRelayEventSink: () => {} });
    try {
      await vi.waitFor(() => expect(secondClient.submissions).toHaveLength(1));
      expect(secondClient.submissions[0].payload).toEqual(client.submissions[0].payload);
      const replay = await restarted.app.inject({ method: "POST", url: "/mpas/v1/action",
        payload: { version: "1", type: "ActionRequest", actionPackage } });
      expect(replay.json()).toMatchObject({ result: "rejected", error: { code: "REPLAY_DETECTED" } });
    } finally { await restarted.app.close(); }
    expect(secondClient.socket.close).toHaveBeenCalled();
    const calls = await readFile(targetCalls, "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return "";
    });
    const records = calls.trim() ? calls.trim().split("\n").map(line => JSON.parse(line) as { pid: number }) : [];
    expect(records).toHaveLength(mode === "executed" ? 1 : 0);
    for (const record of records) expect(() => process.kill(record.pid, 0)).toThrow();
    console.log(JSON.stringify({ case: "daemon restart " + mode, journalPath, targetCalls: records.length,
      exactStoredResponse: secondClient.submissions[0].payload, socketsClosed: true }));
  });

  it.each(["invalid-record", "key-mismatch", "listen-failure"])("%s startup failure closes the actual database", async fault => {
    const workspace = await mkdtemp(join(realpathSync(tmpdir()), "mpas-daemon-failed-start-"));
    const journalPath = join(workspace, "dispatch-ledger.jsonl");
    const initial = new FileDispatchJournal(journalPath);
    if (fault === "invalid-record") initial.insertIfAbsent('{"value":"invalid"}', '{"version":"1","version":"2"}');
    initial.close();
    const key = JSON.parse(await readFile(join(fixtures, "test-keys", "adapter.json"), "utf8"));
    if (fault === "key-mismatch") key.did = "did:jwk:incorrect";
    const adapterKeyPath = join(workspace, "adapter.json");
    await writeFile(adapterKeyPath, JSON.stringify(key), { mode: 0o600 });
    const closed: FileDispatchJournal[] = [];
    const close = FileDispatchJournal.prototype.close;
    const spy = vi.spyOn(FileDispatchJournal.prototype, "close").mockImplementation(function (this: FileDispatchJournal) {
      closed.push(this); close.call(this);
    });
    const occupied = createServer();
    if (fault === "listen-failure") { occupied.listen(0, "127.0.0.1"); await once(occupied, "listening"); }
    try {
      await expect(startDaemon({ configDir: join(fixtures, "configs"), credentialDir: workspace,
        adapterKeyPath, journalPath, trustContext: null, confirmPluginUse: async () => true,
        port: fault === "listen-failure" ? (occupied.address() as { port: number }).port : 0,
        ...(fault === "key-mismatch" ? { verifierRelayUrl: relayUrl } : {}),
      })).rejects.toThrow();
      expect(closed.length).toBeGreaterThan(0);
      for (const store of new Set(closed)) expect(() => store.entries()).toThrow();
    } finally {
      spy.mockRestore();
      if (occupied.listening) await new Promise<void>(resolve => occupied.close(() => resolve()));
    }
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
