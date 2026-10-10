import type { ActionRelayWebSocket } from "@oma3/mpas";

/** Local compatibility shim: keep the published SDK dependency unchanged. */
export function notificationSocketState(socket: ActionRelayWebSocket): number | undefined {
  return (socket as ActionRelayWebSocket & { readonly readyState?: number }).readyState;
}

// Retain failures that occur before a consumer subscribes to socket termination.
const notificationFailures = new WeakMap<ActionRelayWebSocket, Error>();
const guardedSockets = new WeakSet<ActionRelayWebSocket>();

/** Install immediately after construction, before yielding a server-side socket. */
export function guardNotificationSocket<T extends ActionRelayWebSocket>(socket: T): T {
  if (guardedSockets.has(socket)) return socket;
  guardedSockets.add(socket);
  socket.addEventListener("error", (event) => {
    const value = event as { message?: unknown; error?: { message?: unknown } } | null;
    const message = value?.message ?? value?.error?.message;
    const status = typeof message === "string"
      ? /Unexpected server response: (\d{3})\b/.exec(message)?.[1]
      : undefined;
    // Never copy URLs, tickets, headers, or arbitrary server text into logs.
    notificationFailures.set(socket, new Error(status
      ? `WebSocket upgrade failed: Unexpected server response: ${status}`
      : "WebSocket notification connection failed."));
  });
  return socket;
}

/** Sanitized failure retained by the synchronous notification guard. */
export function notificationSocketError(socket: ActionRelayWebSocket): Error | undefined {
  return notificationFailures.get(socket);
}

