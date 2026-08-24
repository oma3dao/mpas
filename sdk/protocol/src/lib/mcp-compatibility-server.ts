import type { ProposerBridge } from "./bridge-runtime.js";

/** Conventional MCP protocol versions accepted by the compatibility adapter. */
export const MCP_COMPATIBILITY_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export const MCP_COMPATIBILITY_DEFAULT_PROTOCOL_VERSION = MCP_COMPATIBILITY_PROTOCOL_VERSIONS[0];

export interface MpasCompatibilityServerOptions {
  bridge: ProposerBridge;
  serverInfo: { name: string; version: string };
  instructions?: string;
  onerror?: (error: Error) => void;
}

type JsonRpcId = string | number;
type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

export type CompatibilityJsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: Record<string, unknown> }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string; data?: unknown } };

/** Conventional MCP initialize/tools adapter for clients without MCP Tasks. */
export class MpasCompatibilityServer {
  private readonly bridge: ProposerBridge;
  private readonly serverInfo: { name: string; version: string };
  private readonly instructions?: string;
  private readonly reportError: (error: Error) => void;
  private initialized = false;
  private initializedNotificationReceived = false;

  constructor(options: MpasCompatibilityServerOptions) {
    this.bridge = options.bridge;
    this.serverInfo = options.serverInfo;
    this.instructions = options.instructions;
    this.reportError = options.onerror ?? (() => undefined);
  }

  async handleMessage(message: unknown): Promise<CompatibilityJsonRpcResponse | undefined> {
    if (isNotification(message)) {
      if (message.method === "notifications/initialized" && this.initialized) {
        this.initializedNotificationReceived = true;
      }
      return undefined;
    }
    if (!isRequest(message)) return undefined;

    try {
      const result = await this.dispatch(message.method, message.params ?? {});
      return { jsonrpc: "2.0", id: message.id, result };
    } catch (error) {
      const protocol = protocolError(error);
      if (protocol.code === -32603) this.reportError(asError(error));
      return { jsonrpc: "2.0", id: message.id, error: protocol };
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method === "initialize") {
      if (this.initialized) throw rpcError(-32600, "Server is already initialized");
      const requestedVersion = params.protocolVersion;
      if (typeof requestedVersion !== "string" || requestedVersion.length === 0) {
        throw rpcError(-32602, "initialize requires protocolVersion");
      }
      const protocolVersion = isCompatibilityProtocolVersion(requestedVersion)
        ? requestedVersion
        : MCP_COMPATIBILITY_DEFAULT_PROTOCOL_VERSION;
      this.initialized = true;
      return {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: this.serverInfo,
        ...(this.instructions !== undefined ? { instructions: this.instructions } : {}),
      };
    }

    if (!this.initialized) {
      if (method === "ping") return {};
      throw rpcError(-32002, "Server is not initialized");
    }

    switch (method) {
      case "ping":
        return {};
      case "tools/list":
        return { tools: this.bridge.getCompatibilityToolDefinitions() };
      case "tools/call": {
        const name = params.name;
        if (typeof name !== "string" || name.length === 0) {
          throw rpcError(-32602, "Tool name is required.");
        }
        const args = params.arguments;
        if (args !== undefined && !isObject(args)) {
          throw rpcError(-32602, "Tool arguments must be an object.");
        }
        return this.bridge.handleCompatibilityToolCall(name, (args ?? {}) as object);
      }
      default:
        throw rpcError(-32601, "Method not found");
    }
  }

  /** Exposed for conformance tests and diagnostics only. */
  get state(): { initialized: boolean; initializedNotificationReceived: boolean } {
    return {
      initialized: this.initialized,
      initializedNotificationReceived: this.initializedNotificationReceived,
    };
  }
}

function isCompatibilityProtocolVersion(
  value: string,
): value is (typeof MCP_COMPATIBILITY_PROTOCOL_VERSIONS)[number] {
  return (MCP_COMPATIBILITY_PROTOCOL_VERSIONS as readonly string[]).includes(value);
}

interface RpcError extends Error {
  code: number;
  data?: unknown;
}

function rpcError(code: number, message: string, data?: unknown): RpcError {
  return Object.assign(new Error(message), { code, ...(data !== undefined ? { data } : {}) });
}

function protocolError(error: unknown): { code: number; message: string; data?: unknown } {
  if (isRpcError(error)) return error;
  return { code: -32603, message: "Internal error" };
}

function isRpcError(value: unknown): value is RpcError {
  return value instanceof Error && typeof (value as Partial<RpcError>).code === "number";
}

function isRequest(value: unknown): value is JsonRpcRequest {
  return (
    isObject(value) &&
    value.jsonrpc === "2.0" &&
    (typeof value.id === "string" || typeof value.id === "number") &&
    typeof value.method === "string" &&
    (value.params === undefined || isObject(value.params))
  );
}

function isNotification(value: unknown): value is { jsonrpc: "2.0"; method: string; params?: Record<string, unknown> } {
  return (
    isObject(value) &&
    value.jsonrpc === "2.0" &&
    value.id === undefined &&
    typeof value.method === "string" &&
    (value.params === undefined || isObject(value.params))
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
