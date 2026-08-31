import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  ActionEndpointClient,
  ActionEndpointClientError,
  ActionRelayClient,
  CoordinationServiceClient,
  buildDeliveryEnvelope,
  parseActionRequestEnvelope,
  type ActionRequest,
  type ActionResponse,
  type CoordinationWebSocket,
  type Did,
} from "../../src/index.js";

const proposer = "did:jwk:proposer" as Did;
const verifier = "did:jwk:verifier" as Did;
const maintainer = "did:jwk:maintainer" as Did;
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("routing clients", () => {
  it("submits the same canonical Action envelope and parses ActionResponse", async () => {
    let submitted: unknown;
    const server = await mockServer(async (request, response) => {
      expect(request.url).toBe("/mpas/v1/verifier/action");
      submitted = JSON.parse(await body(request));
      json(response, actionResponse());
    });
    const client = new ActionEndpointClient({ url: server.url });
    const envelope = buildDeliveryEnvelope({ sender: proposer, recipients: [verifier], payload: actionRequest() });

    await expect(client.submitActionRequest(envelope)).resolves.toEqual(actionResponse());
    expect(submitted).toMatchObject({ type: "DeliveryEnvelope", payload: { type: "ActionRequest" } });
  });

  it("submits only an enveloped Action through the Action Relay client", async () => {
    let submitted: unknown;
    const server = await mockServer(async (request, response) => {
      expect(request.url).toBe("/mpas/v1/verifier/action");
      submitted = JSON.parse(await body(request));
      json(response, actionResponse());
    });
    const client = new ActionRelayClient({ url: server.url, participantDid: proposer });
    const envelope = buildDeliveryEnvelope({ sender: proposer, recipients: [verifier], payload: actionRequest() });

    await expect(client.submitAction(envelope)).resolves.toEqual(actionResponse());
    expect(submitted).toMatchObject({ type: "DeliveryEnvelope", sender: proposer });
  });

  it("keeps Action Relay submission failures in the relay error surface", async () => {
    const malformed = await mockServer((_request, response) => {
      response.statusCode = 200;
      response.end("not JSON");
    });
    const unavailable = await mockServer((_request, response) => {
      response.statusCode = 503;
      json(response, {
        version: "1",
        type: "MpasHttpError",
        error: { code: "timeout", message: "Timed out.", retryable: true },
      });
    });
    const envelope = buildDeliveryEnvelope({ sender: proposer, recipients: [verifier], payload: actionRequest() });

    await expect(new ActionRelayClient({
      url: malformed.url,
      participantDid: proposer,
    }).submitAction(envelope)).rejects.toMatchObject({ name: "ActionRelayResponseError" });
    await expect(new ActionRelayClient({
      url: unavailable.url,
      participantDid: proposer,
    }).submitAction(envelope)).rejects.toMatchObject({ name: "ActionRelayUnavailableError" });
  });

  it("reports a malformed Action endpoint response as a response error", async () => {
    const server = await mockServer((_request, response) => {
      response.statusCode = 200;
      response.end("not JSON");
    });
    const client = new ActionEndpointClient({ url: server.url });

    await expect(client.submitActionRequest(actionRequest())).rejects.toMatchObject({
      name: "ActionEndpointClientError",
      status: 200,
    } satisfies Partial<ActionEndpointClientError>);
  });

  it("polls and returns Verifier deliveries through the Action Relay client", async () => {
    const requestEnvelope = buildDeliveryEnvelope({ sender: proposer, recipients: [verifier], payload: actionRequest() });
    let delivered: unknown;
    const server = await mockServer(async (request, response) => {
      if (request.url === "/mpas/v1/relay/poll") {
        json(response, { version: "1", type: "RelayPollResponse", deliveries: [requestEnvelope] });
      } else {
        expect(request.url).toBe("/mpas/v1/relay/delivery");
        delivered = JSON.parse(await body(request));
        json(response, { version: "1", type: "RelayDeliveryResponse", accepted: true });
      }
    });
    const client = new ActionRelayClient({ url: server.url, participantDid: verifier });
    const page = await client.pollDeliveries();
    const incoming = parseActionRequestEnvelope(page.deliveries[0]);
    const responseEnvelope = buildDeliveryEnvelope({
      sender: verifier,
      recipients: [proposer, maintainer],
      payload: approvalResponse(),
    });
    await client.submitActionResponse(responseEnvelope);

    expect(incoming.payload.type).toBe("ActionRequest");
    expect(delivered).toMatchObject({
      sender: verifier,
      recipients: [proposer, maintainer],
      payload: { type: "ActionResponse" },
    });
    await expect(client.submitActionResponse({
      ...responseEnvelope,
      sender: maintainer,
    })).rejects.toMatchObject({ name: "ActionRelayResponseError" });
  });

  it("binds notification callbacks to the session-provided socket without payload delivery", async () => {
    const socket = new FakeSocket();
    const server = await mockServer((_request, response) => {
      json(response, {
        version: "1",
        type: "CoordinationSessionResponse",
        websocketUrl: "wss://coordination.example.com/mpas/v1/coordination/ws",
        ticket: "ticket",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    });
    const received: string[] = [];
    const client = new CoordinationServiceClient({
      url: server.url,
      participantDid: verifier,
      webSocketFactory: ({ url, ticket, headers }) => {
        expect(url).toBe("wss://coordination.example.com/mpas/v1/coordination/ws");
        expect(ticket).toBe("ticket");
        expect(headers.Authorization).toBe("Bearer ticket");
        return socket;
      },
    });

    const context = await client.connectWorkNotifications({
      onWorkAvailable: (notification) => received.push(notification.type),
    });
    socket.emit("message", { data: JSON.stringify({ version: "1", type: "CoordinationWorkAvailable" }) });
    await Promise.resolve();
    await Promise.resolve();
    expect(received).toEqual(["CoordinationWorkAvailable"]);
    expect(context.coordinationUrl).toBe(server.url);
  });

  it("keeps relay notification sessions on relay message types and paths", async () => {
    const socket = new FakeSocket();
    const server = await mockServer((request, response) => {
      expect(request.url).toBe("/mpas/v1/relay/session");
      json(response, {
        version: "1",
        type: "RelaySessionResponse",
        websocketUrl: "wss://relay.example.com/mpas/v1/relay/ws",
        ticket: "relay-ticket",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    });
    const received: string[] = [];
    const client = new ActionRelayClient({
      url: server.url,
      participantDid: verifier,
      webSocketFactory: ({ url, headers }) => {
        expect(url).toBe("wss://relay.example.com/mpas/v1/relay/ws");
        expect(headers.Authorization).toBe("Bearer relay-ticket");
        return socket;
      },
    });

    const context = await client.connectWorkNotifications({
      onWorkAvailable: (notification) => received.push(notification.type),
    });
    socket.emit("message", { data: JSON.stringify({ version: "1", type: "RelayWorkAvailable" }) });
    await Promise.resolve();
    await Promise.resolve();
    expect(received).toEqual(["RelayWorkAvailable"]);
    expect(context.relayUrl).toBe(server.url);
  });

  it("polls workflow work after a coordination notification without a relay cursor", async () => {
    const socket = new FakeSocket();
    const accepted = Promise.withResolvers<void>();
    const server = await mockServer((request, response) => {
      if (request.url === "/mpas/v1/coordination/session") {
        json(response, {
          version: "1",
          type: "CoordinationSessionResponse",
          websocketUrl: "wss://coordination.example.com/mpas/v1/coordination/ws",
          ticket: "ticket",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      } else {
        json(response, {
          version: "1",
          type: "CoordinationPollResponse",
          approvalRequests: [],
          actionUpdates: [],
        });
      }
    });
    const client = new CoordinationServiceClient({
      url: server.url,
      participantDid: verifier,
      webSocketFactory: () => socket,
    });
    const context = await client.connectNotificationsAndPoll({
      onPage: () => accepted.resolve(),
    });

    socket.emit("message", { data: JSON.stringify({ version: "1", type: "CoordinationWorkAvailable" }) });
    await accepted.promise;
    await Promise.resolve();
    expect(context.did).toBe(verifier);
  });
});

class FakeSocket implements CoordinationWebSocket {
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  close(): void {}
  addEventListener(type: "message" | "close" | "error", listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function actionRequest(): ActionRequest {
  return {
    version: "1",
    type: "ActionRequest",
    idempotencyKey: "request-1",
    actionPackage: {
      version: "1",
      type: "ActionPackage",
      executionPayload: {},
      actionEnvelope: {
        version: "1",
        type: "ActionEnvelope",
        proposer: { did: proposer },
        target: { applicationDid: verifier },
        executionProfile: { id: "did:web:profiles.example" },
        executionPayloadHash: { alg: "sha-256", value: "payload" },
        actionId: { value: "urn:uuid:11111111-1111-4111-8111-111111111111" },
        createdAt: "2026-08-25T12:00:00.000Z",
        expiresAt: "2026-08-25T13:00:00.000Z",
      },
      approvalBundle: { version: "1", type: "ApprovalBundle", actionEnvelopeHash: { alg: "sha-256", value: "envelope" }, approvals: [] },
    },
  };
}

function actionResponse(): ActionResponse {
  return { version: "1", type: "ActionResponse", verifier: { did: verifier }, actionEnvelopeHash: { alg: "sha-256", value: "envelope" }, result: "executed" };
}

function approvalResponse(): ActionResponse {
  return {
    version: "1",
    type: "ActionResponse",
    verifier: { did: verifier },
    actionEnvelopeHash: { alg: "sha-256", value: "envelope" },
    result: "additionalApprovalsRequired",
    authorizationRequirements: {
      version: "1",
      type: "AuthorizationRequirements",
      actionEnvelopeHash: { alg: "sha-256", value: "envelope" },
      result: "additionalApprovalsRequired",
      verifier: { did: verifier },
      approvalRequirements: {
        anyOf: [{ type: "threshold", threshold: 1, eligibleSigners: [maintainer] }],
      },
    },
  };
}

async function mockServer(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = createServer((request, response) => void Promise.resolve(handler(request, response)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  const value = {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
  servers.push(value);
  return value;
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, value: unknown): void {
  response.setHeader("content-type", "application/mpas+json");
  response.end(JSON.stringify(value));
}
