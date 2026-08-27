import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import type { Did } from "../core/types.js";
import { WebSocket, WebSocketServer } from "ws";

interface TicketRecord {
  did: Did;
  expiresAt: number;
  consumed: boolean;
}

export class CoordinationNotificationHub {
  private readonly tickets = new Map<string, TicketRecord>();
  private readonly connections = new Map<Did, Set<WebSocket>>();
  private readonly webSocketServer = new WebSocketServer({ noServer: true });

  constructor(
    server: Server,
    private readonly hasOutstandingWork: (did: Did) => boolean,
    private readonly now: () => Date = () => new Date(),
  ) {
    server.on("upgrade", (request, socket, head) => {
      if (new URL(request.url ?? "/", "http://localhost").pathname !== "/mpas/v1/coordination/ws") {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.handleUpgrade(request.headers.authorization, request, socket, head);
    });
  }

  issue(did: Did, websocketUrl: string, lifetimeMs = 5 * 60_000): {
    websocketUrl: string;
    ticket: string;
    expiresAt: string;
  } {
    for (const [hash, record] of this.tickets) {
      if (record.expiresAt <= this.now().getTime() || record.consumed) this.tickets.delete(hash);
    }
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = this.now().getTime() + Math.min(lifetimeMs, 5 * 60_000);
    this.tickets.set(hashTicket(ticket), { did, expiresAt, consumed: false });
    return { websocketUrl, ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  notify(dids: Iterable<Did>): void {
    const frame = JSON.stringify({ version: "1", type: "CoordinationWorkAvailable" });
    for (const did of new Set(dids)) {
      for (const socket of this.connections.get(did) ?? []) {
        if (socket.readyState === WebSocket.OPEN) socket.send(frame);
      }
    }
  }

  close(): Promise<void> {
    for (const sockets of this.connections.values()) {
      for (const socket of sockets) socket.close(1001, "service shutdown");
    }
    return new Promise((resolve, reject) => {
      this.webSocketServer.close((error) => error ? reject(error) : resolve());
    });
  }

  private handleUpgrade(
    authorization: string | undefined,
    request: Parameters<WebSocketServer["handleUpgrade"]>[0],
    socket: Duplex,
    head: Buffer,
  ): void {
    const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
    const record = token ? this.tickets.get(hashTicket(token)) : undefined;
    if (!record || record.consumed || record.expiresAt <= this.now().getTime()) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    record.consumed = true;
    this.tickets.delete(hashTicket(token!));
    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => this.bind(record.did, webSocket));
  }

  private bind(did: Did, socket: WebSocket): void {
    const sockets = this.connections.get(did) ?? new Set<WebSocket>();
    sockets.add(socket);
    this.connections.set(did, sockets);
    const remove = () => {
      sockets.delete(socket);
      if (sockets.size === 0) this.connections.delete(did);
    };
    socket.on("close", remove);
    socket.on("error", remove);
    if (this.hasOutstandingWork(did)) this.notify([did]);
  }
}

function hashTicket(ticket: string): string {
  return createHash("sha256").update(ticket).digest("base64url");
}
