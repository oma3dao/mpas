import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import { ActionRelayClient, CoordinationServiceClient, guardNotificationSocket, notificationSocketError } from "../../src/index.js";

class Socket extends EventEmitter {
  readyState = 0;
  addEventListener(type: string, fn: (event: unknown) => void) { this.on(type, fn); }
  close() { this.readyState = 3; this.emit("close"); }
}

describe("notification handshake guards", () => {
  for (const Client of [ActionRelayClient, CoordinationServiceClient]) {
    for (const status of [500, 502, 503, 504]) {
      it(`${Client.name} guards early HTTP ${status} before returning to its caller`, async () => {
        let socket!: Socket;
        const client = new Client({
          url: "https://example.test", participantDid: "did:jwk:test",
          webSocketFactory: () => {
            socket = new Socket();
            queueMicrotask(() => {
              socket.emit("error", new Error(`Unexpected server response: ${status} secret-ticket`));
              socket.close();
            });
            return socket;
          },
        });
        vi.spyOn(client, "createNotificationSession").mockResolvedValue({
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          websocketUrl: "wss://example.test", ticket: "secret-ticket",
        } as never);
        const connection = await client.connectWorkNotifications({ onWorkAvailable: () => {} });
        expect(connection.socket.readyState).toBe(3);
        expect(notificationSocketError(socket)?.message).toBe(`WebSocket upgrade failed: Unexpected server response: ${status}`);
      });
    }
  }
  it("guards inside an asynchronous factory before it yields", async () => {
    const socket = guardNotificationSocket(new Socket());
    expect(() => socket.emit("error", new Error("sensitive URL and Authorization"))).not.toThrow();
    expect(notificationSocketError(socket)?.message).toBe("WebSocket notification connection failed.");
  });
});
