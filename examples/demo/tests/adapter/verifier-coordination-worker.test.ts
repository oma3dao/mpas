import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  CoordinationUnavailableError,
  MpasAuthError,
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
import {
  FileVerifierCoordinationStateStore,
  VerifierCoordinationWorker,
  type VerifierCoordinationClient,
  type VerifierCoordinationState,
  type VerifierCoordinationStateStore,
} from "../../src/adapter/verifier-coordination-worker.js";
import { computeJsonHash } from "../../src/core/verification.js";

const fixtures = fileURLToPath(new URL("../fixtures/core/", import.meta.url));
const coordinationUrl = "https://coordination.example";
const verifier = "did:jwk:verifier" as Did;
const maintainer = "did:jwk:maintainer" as Did;

describe("VerifierCoordinationWorker", () => {
  it("persists its cursor and response cache in a private state file", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "mpas-verifier-state-")), "state.json");
    const store = new FileVerifierCoordinationStateStore(path);
    const state = await store.load({ coordinationUrl, verifierDid: verifier });
    state.cursor = "cursor-7";

    await store.save(state);

    await expect(store.load({ coordinationUrl, verifierDid: verifier })).resolves.toMatchObject({
      coordinationUrl,
      verifierDid: verifier,
      cursor: "cursor-7",
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("polls an addressed Action, returns its response to the Proposer, and advances the cursor", async () => {
    const requestEnvelope = await actionRequestEnvelope();
    const store = new MemoryStateStore();
    const client = new FakeCoordinationClient(requestEnvelope);
    const processAction = vi.fn(async () => actionResponse(requestEnvelope));
    const worker = await createWorker(client, store, processAction);

    await worker.pollNow();

    expect(processAction).toHaveBeenCalledOnce();
    expect(client.submissions).toHaveLength(1);
    expect(client.submissions[0]).toMatchObject({
      sender: verifier,
      recipients: [requestEnvelope.sender],
      payload: {
        type: "ActionResponse",
        verifier: { did: verifier },
      },
    });
    expect(worker.getCursor()).toBe("cursor-1");
    expect(store.state?.responses).toEqual({});
  });

  it("persists and reuses the exact response when delivery submission must be retried", async () => {
    const requestEnvelope = await actionRequestEnvelope();
    const store = new MemoryStateStore();
    const client = new FakeCoordinationClient(requestEnvelope);
    client.submitFailures.push(new CoordinationUnavailableError("temporary outage"));
    const processAction = vi.fn(async () => actionResponse(requestEnvelope));
    const worker = await createWorker(client, store, processAction);

    await expect(worker.pollNow()).rejects.toBeInstanceOf(CoordinationUnavailableError);
    const cachedEnvelope = Object.values(store.state?.responses ?? {})[0]?.envelope;
    expect(cachedEnvelope).toBeDefined();
    expect(worker.getCursor()).toBeUndefined();

    await worker.pollNow();

    expect(processAction).toHaveBeenCalledOnce();
    expect(client.submissions).toEqual([cachedEnvelope]);
    expect(worker.getCursor()).toBe("cursor-1");
  });

  it("does not cache or deliver a pending response and retries the same delivery", async () => {
    const requestEnvelope = await actionRequestEnvelope();
    const store = new MemoryStateStore();
    const client = new FakeCoordinationClient(requestEnvelope);
    const terminal = actionResponse(requestEnvelope);
    const { error: _error, ...pendingBase } = terminal;
    const processAction = vi.fn()
      .mockResolvedValueOnce({ ...pendingBase, result: "pending" as const })
      .mockResolvedValueOnce(terminal);
    const worker = await createWorker(client, store, processAction);

    await expect(worker.pollNow()).rejects.toBeInstanceOf(CoordinationUnavailableError);
    expect(store.state?.responses ?? {}).toEqual({});
    expect(client.submissions).toEqual([]);
    expect(worker.getCursor()).toBeUndefined();

    await worker.pollNow();

    expect(processAction).toHaveBeenCalledTimes(2);
    expect(client.submissions).toHaveLength(1);
    expect(worker.getCursor()).toBe("cursor-1");
  });

  it("addresses a requirements response to the Proposer and eligible Maintainers", async () => {
    const requestEnvelope = await actionRequestEnvelope();
    const client = new FakeCoordinationClient(requestEnvelope);
    const response = actionResponse(requestEnvelope);
    response.result = "additionalApprovalsRequired";
    response.authorizationRequirements = {
      version: "1",
      type: "AuthorizationRequirements",
      verifier: { did: verifier },
      actionEnvelopeHash: response.actionEnvelopeHash!,
      result: "additionalApprovalsRequired",
      approvalRequirements: {
        anyOf: [{ type: "threshold", threshold: 1, eligibleSigners: [maintainer] }],
      },
    };
    const worker = await createWorker(client, new MemoryStateStore(), async () => response);

    await worker.pollNow();

    expect(client.submissions[0]?.recipients).toEqual([requestEnvelope.sender, maintainer]);
  });

  it("fails closed without advancing the cursor for an unsupported delivery payload", async () => {
    const requestEnvelope = await actionRequestEnvelope();
    const unsupported = {
      ...requestEnvelope,
      payload: { version: "1", type: "FutureDeliveryType" },
    } as unknown as DeliveryEnvelope<ActionRequest>;
    const client = new FakeCoordinationClient(unsupported);
    const events: string[] = [];
    const worker = await VerifierCoordinationWorker.create({
      coordinationUrl,
      verifierDid: verifier,
      client,
      stateStore: new MemoryStateStore(),
      processAction: vi.fn(),
      fallbackPollIntervalMs: 10,
      reconnectInitialMs: 1,
      reconnectMaxMs: 2,
      onEvent: (event) => events.push(event.event),
    });

    worker.start();
    await vi.waitFor(() => expect(worker.getStatus()).toBe("fatal"));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(worker.getCursor()).toBeUndefined();
    expect(client.submissions).toEqual([]);
    expect(client.pollCount).toBe(1);
    expect(events).toContain("fatal_error");
    await worker.stop();
  });

  it("polls on connection and again after a payload-free work notification", async () => {
    const store = new MemoryStateStore();
    const client = new FakeCoordinationClient();
    const processAction = vi.fn();
    const worker = await createWorker(client, store, processAction);

    worker.start();
    await vi.waitFor(() => expect(client.pollCount).toBe(1));
    await client.notify();
    await vi.waitFor(() => expect(client.pollCount).toBe(2));
    await worker.stop();

    expect(client.connectCount).toBe(1);
    expect(client.socket.close).toHaveBeenCalled();
    expect(processAction).not.toHaveBeenCalled();
  });

  it("reconnects and retries the same delivery after a transient processing failure", async () => {
    const requestEnvelope = await actionRequestEnvelope();
    const client = new FakeCoordinationClient(requestEnvelope);
    const processAction = vi.fn()
      .mockRejectedValueOnce(new CoordinationUnavailableError("temporary adapter failure"))
      .mockResolvedValueOnce(actionResponse(requestEnvelope));
    const worker = await createWorker(client, new MemoryStateStore(), processAction);

    worker.start();
    await vi.waitFor(() => expect(worker.getCursor()).toBe("cursor-1"));

    expect(worker.getStatus()).toBe("connected");
    expect(client.connectCount).toBe(2);
    expect(client.sockets[0]?.close).toHaveBeenCalled();
    expect(processAction).toHaveBeenCalledTimes(2);
    expect(client.submissions).toHaveLength(1);
    await worker.stop();
  });

  it("stops rather than reconnecting after an authentication rejection", async () => {
    const store = new MemoryStateStore();
    const client = new FakeCoordinationClient();
    client.connectError = new MpasAuthError(403, "permission_denied", "not authorized");
    const worker = await createWorker(client, store, vi.fn(), 10);

    worker.start();
    await vi.waitFor(() => expect(worker.getStatus()).toBe("fatal"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(client.pollCount).toBe(0);
    await worker.stop();

    expect(client.connectCount).toBe(1);
  });
});

class MemoryStateStore implements VerifierCoordinationStateStore {
  state?: VerifierCoordinationState;

  async load(identity: { coordinationUrl: string; verifierDid: Did }): Promise<VerifierCoordinationState> {
    return this.state ?? {
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
  readonly sockets: FakeSocket[] = [];
  readonly submissions: DeliveryEnvelope<ActionResponse>[] = [];
  readonly submitFailures: Error[] = [];
  pollCount = 0;
  connectCount = 0;
  connectError?: Error;
  private onWorkAvailable?: () => void | Promise<void>;

  constructor(private readonly delivery?: DeliveryEnvelope<ActionRequest>) {}

  get socket(): FakeSocket {
    const socket = this.sockets.at(-1);
    if (!socket) throw new Error("No notification socket has been opened.");
    return socket;
  }

  async pollWork(options: { cursor?: string } = {}): Promise<CoordinationPollResponse> {
    this.pollCount += 1;
    if (this.delivery && options.cursor === undefined) {
      return {
        version: "1",
        type: "CoordinationPollResponse",
        approvalRequests: [],
        actionUpdates: [],
        deliveries: [this.delivery as unknown as DeliveryEnvelope],
        nextCursor: "cursor-1",
      };
    }
    return {
      version: "1",
      type: "CoordinationPollResponse",
      approvalRequests: [],
      actionUpdates: [],
      deliveries: [],
      ...(options.cursor ? { nextCursor: options.cursor } : {}),
    };
  }

  async submitActionResponseDelivery(
    envelope: DeliveryEnvelope<ActionResponse>,
  ): Promise<CoordinationDeliveryResponse> {
    const failure = this.submitFailures.shift();
    if (failure) throw failure;
    this.submissions.push(structuredClone(envelope));
    return {
      version: "1",
      type: "CoordinationDeliveryResponse",
      accepted: true,
      createdAt: "2026-08-28T12:00:00.000Z",
    };
  }

  async connectWorkNotifications(input: {
    onWorkAvailable: () => void | Promise<void>;
  }): Promise<CoordinationNotificationConnection> {
    this.connectCount += 1;
    if (this.connectError) throw this.connectError;
    this.onWorkAvailable = input.onWorkAvailable;
    const socket = new FakeSocket();
    this.sockets.push(socket);
    return {
      socket,
      coordinationUrl,
      audience: coordinationUrl,
      did: verifier,
    };
  }

  async notify(): Promise<void> {
    await this.onWorkAvailable?.();
  }
}

async function createWorker(
  client: VerifierCoordinationClient,
  stateStore: VerifierCoordinationStateStore,
  processAction: (envelope: DeliveryEnvelope<ActionRequest>) => Promise<ActionResponse>,
  fallbackPollIntervalMs = 60_000,
): Promise<VerifierCoordinationWorker> {
  return VerifierCoordinationWorker.create({
    coordinationUrl,
    verifierDid: verifier,
    client,
    stateStore,
    processAction,
    fallbackPollIntervalMs,
    reconnectInitialMs: 1,
    reconnectMaxMs: 2,
  });
}

async function actionRequestEnvelope(): Promise<DeliveryEnvelope<ActionRequest>> {
  const actionPackage = JSON.parse(
    await readFile(`${fixtures}/insufficient-approvals.json`, "utf8"),
  ) as ActionPackage;
  return buildDeliveryEnvelope({
    sender: actionPackage.actionEnvelope.proposer.did,
    recipients: [verifier],
    payload: {
      version: "1",
      type: "ActionRequest",
      actionPackage,
    },
  });
}

function actionResponse(envelope: DeliveryEnvelope<ActionRequest>): ActionResponse {
  return {
    version: "1",
    type: "ActionResponse",
    verifier: { did: verifier },
    actionEnvelopeHash: computeJsonHash(envelope.payload.actionPackage.actionEnvelope),
    result: "rejected",
    createdAt: "2026-08-28T12:00:00.000Z",
    error: { code: "TEST_REJECTION", message: "Rejected by test Verifier." },
  };
}
