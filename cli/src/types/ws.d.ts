declare module "ws" {
  import type { IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";

  export class WebSocket {
    static readonly OPEN: number;
    constructor(url: string, options?: { headers?: Record<string, string> });
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    on(event: "open" | "close" | "error" | "message" | "unexpected-response", listener: (...args: any[]) => void): this;
  }

  export class WebSocketServer {
    constructor(options: { noServer: true });
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (socket: WebSocket) => void): void;
    close(callback?: (error?: Error) => void): void;
  }
}
