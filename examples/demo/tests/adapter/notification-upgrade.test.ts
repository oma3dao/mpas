import { createServer } from "node:http";
import { WebSocket } from "ws";
import { describe, it, expect, vi } from "vitest";
import { ActionRelayClient, CoordinationServiceClient, guardNotificationSocket, notificationSocketError, type ActionRelayWebSocket } from "@oma3/mpas";

describe("real ws upgrade failures", () => {
  for (const Client of [ActionRelayClient, CoordinationServiceClient]) {
    it.each([500, 502, 503, 504])(`${Client.name} survives HTTP %s before the consumer subscribes`, async status => {
      const server = createServer();
      server.on("upgrade", (_request, socket) => {
        socket.end(`HTTP/1.1 ${status} Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as { port: number };
      let socket: ActionRelayWebSocket | undefined;
      try {
        const client = new Client({
          url: `http://127.0.0.1:${address.port}`, participantDid: "did:jwk:test",
          webSocketFactory: async ({ url }) => {
            socket = guardNotificationSocket(new WebSocket(url) as unknown as ActionRelayWebSocket);
            // Model a factory/consumer that yields through the entire failed upgrade.
            await vi.waitFor(() => expect(socket?.readyState).toBe(3));
            return socket;
          },
        });
        vi.spyOn(client, "createNotificationSession").mockResolvedValue({
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          websocketUrl: `ws://127.0.0.1:${address.port}`, ticket: "test-ticket",
        } as never);
        const result = await client.connectWorkNotifications({ onWorkAvailable: () => {} });
        expect(result.socket.readyState).toBe(3);
        expect(notificationSocketError(result.socket)?.message).toBe(`WebSocket upgrade failed: Unexpected server response: ${status}`);
      } finally {
        socket?.close();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    });
  }
});
