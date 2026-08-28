import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { buildDeliveryEnvelope, type ActionPackage, type Did } from "@oma3/mpas";
import { createCoordinationApiServer } from "../../src/coordination/coordination-api-server.js";
import { CoordinationStore } from "../../src/coordination/store.js";

const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
const verifier = "did:jwk:verifier" as Did;
const apps = new Set<ReturnType<typeof createCoordinationApiServer>>();

afterEach(async () => {
  await Promise.all([...apps].map((app) => app.close()));
  apps.clear();
});

describe("Coordination WebSocket notification", () => {
  it("uses a one-use DID-bound ticket and notifies immediately when pollable work exists", async () => {
    const pkg = JSON.parse(await readFile(`${fixtures}/core/insufficient-approvals.json`, "utf8")) as ActionPackage;
    const store = new CoordinationStore();
    store.beginRelayedAction(buildDeliveryEnvelope({
      sender: pkg.actionEnvelope.proposer.did,
      recipients: [verifier],
      payload: { version: "1", type: "ActionRequest", actionPackage: pkg },
    }), verifier);
    const app = createCoordinationApiServer({ store, designatedVerifierDid: verifier });
    apps.add(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    const session = await app.inject({
      method: "POST",
      url: "/mpas/v1/coordination/session",
      payload: { version: "1", type: "CoordinationSessionRequest", did: verifier },
    });
    const ticket = session.json().ticket as string;
    const wsUrl = `${address.replace(/^http/, "ws")}/mpas/v1/coordination/ws`;
    const first = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${ticket}` } });
    const frame = await new Promise<string>((resolve, reject) => {
      first.on("message", (data: Buffer) => resolve(data.toString("utf8")));
      first.on("error", reject);
    });
    expect(JSON.parse(frame)).toEqual({ version: "1", type: "CoordinationWorkAvailable" });
    first.close();

    const reconnectSession = await app.inject({
      method: "POST",
      url: "/mpas/v1/coordination/session",
      payload: { version: "1", type: "CoordinationSessionRequest", did: verifier },
    });
    const reconnect = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${reconnectSession.json().ticket as string}` },
    });
    const reconnectFrame = await new Promise<string>((resolve, reject) => {
      reconnect.on("message", (data: Buffer) => resolve(data.toString("utf8")));
      reconnect.on("error", reject);
    });
    expect(JSON.parse(reconnectFrame)).toEqual({ version: "1", type: "CoordinationWorkAvailable" });
    reconnect.close();

    const status = await new Promise<number>((resolve, reject) => {
      const replay = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${ticket}` } });
      replay.on("unexpected-response", (_request: unknown, response: { statusCode: number }) => resolve(response.statusCode));
      replay.on("open", () => reject(new Error("replayed ticket unexpectedly opened")));
      replay.on("error", () => undefined);
    });
    expect(status).toBe(401);
  });

  it("rejects missing, unknown, and expired tickets", async () => {
    let now = new Date("2026-08-26T12:00:00.000Z");
    const app = createCoordinationApiServer({ auth: { now: () => now } });
    apps.add(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const wsUrl = `${address.replace(/^http/, "ws")}/mpas/v1/coordination/ws`;
    const session = await app.inject({
      method: "POST",
      url: "/mpas/v1/coordination/session",
      payload: { version: "1", type: "CoordinationSessionRequest", did: verifier },
    });
    now = new Date("2026-08-26T12:05:01.000Z");

    await expect(upgradeStatus(wsUrl)).resolves.toBe(401);
    await expect(upgradeStatus(wsUrl, "unknown-ticket")).resolves.toBe(401);
    await expect(upgradeStatus(wsUrl, session.json().ticket as string)).resolves.toBe(401);
  });

  it("closes WebSocket upgrades on unknown paths with 404", async () => {
    const app = createCoordinationApiServer();
    apps.add(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    await expect(upgradeStatus(`${address.replace(/^http/, "ws")}/mpas/v1/coordination/not-found`)).resolves.toBe(404);
  });
});

function upgradeStatus(url: string, ticket?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, ticket ? { headers: { Authorization: `Bearer ${ticket}` } } : undefined);
    socket.on("unexpected-response", (_request: unknown, response: { statusCode: number }) => resolve(response.statusCode));
    socket.on("open", () => reject(new Error("invalid ticket unexpectedly opened")));
    socket.on("error", () => undefined);
  });
}
