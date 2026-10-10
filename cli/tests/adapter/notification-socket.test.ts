import { EventEmitter } from "node:events";
import { describe, it, expect } from "vitest";
import { guardNotificationSocket, notificationSocketError } from "../../src/adapter/notification-socket.js";

class Socket extends EventEmitter {
  addEventListener(type: string, fn: (event: unknown) => void) { this.on(type, fn); }
  close() { this.emit("close"); }
}

describe("adapter-local notification guard", () => {
  it.each(["sensitive URL and Authorization", "Unexpected server response: 500 secret-ticket"])("contains early errors and retains only sanitized diagnostics", message => {
    const socket = guardNotificationSocket(new Socket());
    expect(guardNotificationSocket(socket)).toBe(socket);
    expect(socket.listenerCount("error")).toBe(1);
    expect(() => socket.emit("error", new Error(message))).not.toThrow();
    expect(notificationSocketError(socket)?.message).toBe(message.startsWith("Unexpected")
      ? "WebSocket upgrade failed: Unexpected server response: 500"
      : "WebSocket notification connection failed.");
  });
});
