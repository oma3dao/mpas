import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server";
import {
  MpasCompatibilityServer,
  type CompatibilityJsonRpcResponse,
} from "./mcp-compatibility-server.js";
import { MCP_TASKS_PROTOCOL_VERSION, MpasTasksServer } from "./mcp-tasks-server.js";
import type { ProposerBridge } from "./bridge-runtime.js";

const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";

export type MpasProtocolMode = "tasks" | "compatibility";

export interface MpasProtocolServerOptions {
  bridge: ProposerBridge;
  serverInfo: { name: string; version: string };
  discoveryTtlMs?: number;
  instructions?: string;
  onerror?: (error: Error) => void;
  onmode?: (mode: MpasProtocolMode, selector: string) => void;
}

type ProtocolResponse = CompatibilityJsonRpcResponse | Awaited<ReturnType<MpasTasksServer["handleMessage"]>>;

/**
 * One-transport MCP server that locks to Tasks or conventional compatibility
 * mode from the client's first protocol-defining request.
 */
export class MpasProtocolServer {
  private readonly tasks: MpasTasksServer;
  private readonly compatibility: MpasCompatibilityServer;
  private readonly reportError: (error: Error) => void;
  private readonly reportMode: (mode: MpasProtocolMode, selector: string) => void;
  private transport?: Transport;
  private selectedMode?: MpasProtocolMode;

  constructor(options: MpasProtocolServerOptions) {
    this.reportError = options.onerror ?? (() => undefined);
    this.reportMode = options.onmode ?? (() => undefined);
    this.tasks = new MpasTasksServer({
      bridge: options.bridge,
      serverInfo: options.serverInfo,
      ...(options.discoveryTtlMs !== undefined ? { discoveryTtlMs: options.discoveryTtlMs } : {}),
      onerror: this.reportError,
    });
    this.compatibility = new MpasCompatibilityServer({
      bridge: options.bridge,
      serverInfo: options.serverInfo,
      ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
      onerror: this.reportError,
    });
  }

  get mode(): MpasProtocolMode | undefined {
    return this.selectedMode;
  }

  async connect(transport: Transport): Promise<void> {
    this.transport = transport;
    transport.onmessage = (message) => {
      void this.handleMessage(message).then(
        (response) => {
          if (response) {
            void transport
              .send(response as unknown as JSONRPCMessage, { relatedRequestId: response.id })
              .catch((error) => this.reportError(asError(error)));
          }
        },
        (error) => this.reportError(asError(error)),
      );
    };
    transport.onerror = (error) => this.reportError(error);
    await transport.start();
  }

  async close(): Promise<void> {
    await this.transport?.close();
    this.transport = undefined;
  }

  async handleMessage(message: unknown): Promise<ProtocolResponse | undefined> {
    const method = messageMethod(message);
    if (!method) return undefined;

    if (!this.selectedMode) {
      if (method === "ping") {
        return this.tasks.handleMessage(message);
      }

      const selection = selectMode(message, method);
      if (!selection) {
        return requestError(message, -32601, "Unsupported MCP handshake");
      }
      this.selectedMode = selection.mode;
      this.reportMode(selection.mode, selection.selector);
    }

    if (this.selectedMode === "compatibility") {
      return this.compatibility.handleMessage(message);
    }
    return this.tasks.handleMessage(message);
  }
}

function selectMode(
  message: unknown,
  method: string,
): { mode: MpasProtocolMode; selector: string } | undefined {
  if (method === "initialize") return { mode: "compatibility", selector: "initialize" };
  if (method === "server/discover") return { mode: "tasks", selector: "server/discover" };
  if (method === "tools/list") return { mode: "tasks", selector: "tools/list" };

  const params = isObject(message) && isObject(message.params) ? message.params : undefined;
  const meta = params && isObject(params._meta) ? params._meta : undefined;
  if (meta?.[PROTOCOL_VERSION_META_KEY] === MCP_TASKS_PROTOCOL_VERSION) {
    return { mode: "tasks", selector: "protocol_metadata" };
  }
  return undefined;
}

function requestError(
  message: unknown,
  code: number,
  errorMessage: string,
): CompatibilityJsonRpcResponse | undefined {
  if (!isObject(message) || (typeof message.id !== "string" && typeof message.id !== "number")) {
    return undefined;
  }
  return { jsonrpc: "2.0", id: message.id, error: { code, message: errorMessage } };
}

function messageMethod(message: unknown): string | undefined {
  return isObject(message) && typeof message.method === "string" ? message.method : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
