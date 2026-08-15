import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server";
import {
  CancelTaskParamsSchema,
  GetTaskParamsSchema,
  MCP_TASKS_EXTENSION_ID,
  MPAS_MCP_PROFILE_EXTENSION_ID,
  MPAS_MCP_PROFILE_VERSION,
  UpdateTaskParamsSchema,
} from "./mcp-tasks-extension.js";
import {
  ProposerBridge,
  TaskNotFoundError,
  UnknownBridgeToolError,
} from "./bridge-runtime.js";

export const MCP_TASKS_PROTOCOL_VERSION = "2026-07-28";

const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

export interface MpasTasksServerOptions {
  bridge: ProposerBridge;
  serverInfo: { name: string; version: string };
  discoveryTtlMs?: number;
  onerror?: (error: Error) => void;
}

type JsonRpcId = string | number;
type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};
type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: Record<string, unknown> }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string; data?: unknown } };

/**
 * Modern MCP 2026 stdio dispatcher for the official Tasks extension.
 *
 * This narrow adapter exists because @modelcontextprotocol/server@2.0.0
 * still reserves tasks/* for the removed 2025 core API and rejects those
 * method names in the 2026 era. Replace it when the official SDK exposes the
 * io.modelcontextprotocol/tasks extension.
 */
export class MpasTasksServer {
  private readonly bridge: ProposerBridge;
  private readonly serverInfo: { name: string; version: string };
  private readonly discoveryTtlMs: number;
  private readonly reportError: (error: Error) => void;
  private transport?: Transport;

  constructor(options: MpasTasksServerOptions) {
    this.bridge = options.bridge;
    this.serverInfo = options.serverInfo;
    this.discoveryTtlMs = options.discoveryTtlMs ?? 3_600_000;
    this.reportError = options.onerror ?? (() => undefined);
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

  /** Testable request dispatcher. Notifications are ignored. */
  async handleMessage(message: unknown): Promise<JsonRpcResponse | undefined> {
    if (!isRequest(message)) return undefined;
    try {
      if (requiresTaskEnvelope(message.method)) {
        assertModernEnvelope(message.params);
      }
      const result = await this.dispatch(message.method, message.params ?? {});
      return { jsonrpc: "2.0", id: message.id, result: this.withServerInfo(result) };
    } catch (error) {
      const protocol = protocolError(error);
      if (protocol.code === -32603) this.reportError(asError(error));
      return { jsonrpc: "2.0", id: message.id, error: protocol };
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (method) {
      case "ping":
        return {};
      case "server/discover":
        return {
          resultType: "complete",
          supportedVersions: [MCP_TASKS_PROTOCOL_VERSION],
          capabilities: {
            tools: {},
            extensions: {
              [MCP_TASKS_EXTENSION_ID]: {},
              [MPAS_MCP_PROFILE_EXTENSION_ID]: {
                version: MPAS_MCP_PROFILE_VERSION,
                disclosure: "transparent",
              },
            },
          },
          ttlMs: this.discoveryTtlMs,
          cacheScope: "public",
        };
      case "tools/list":
        return {
          resultType: "complete",
          tools: this.bridge.getToolDefinitions(),
          ttlMs: this.discoveryTtlMs,
          cacheScope: "public",
        };
      case "tools/call": {
        requireTaskExtensions(params);
        const name = params.name;
        if (typeof name !== "string" || name.length === 0) throw invalidParams("Tool name is required.");
        const args = params.arguments;
        if (args !== undefined && !isObject(args)) throw invalidParams("Tool arguments must be an object.");
        return this.bridge.handleToolCall(name, (args ?? {}) as object);
      }
      case "tasks/get": {
        requireTaskExtensions(params);
        const parsed = GetTaskParamsSchema.safeParse(params);
        if (!parsed.success) throw invalidParams("tasks/get requires a non-empty taskId.");
        return this.bridge.handleTasksGet(parsed.data.taskId);
      }
      case "tasks/update": {
        requireTaskExtensions(params);
        const parsed = UpdateTaskParamsSchema.safeParse(params);
        if (!parsed.success) throw invalidParams("tasks/update requires taskId and inputResponses.");
        return this.bridge.handleTasksUpdate(parsed.data.taskId, parsed.data.inputResponses);
      }
      case "tasks/cancel": {
        requireTaskExtensions(params);
        const parsed = CancelTaskParamsSchema.safeParse(params);
        if (!parsed.success) throw invalidParams("tasks/cancel requires a non-empty taskId.");
        return this.bridge.handleTasksCancel(parsed.data.taskId);
      }
      default:
        throw rpcError(-32601, "Method not found");
    }
  }

  private withServerInfo(result: Record<string, unknown>): Record<string, unknown> {
    const existingMeta = isObject(result._meta) ? result._meta : {};
    return {
      ...result,
      _meta: { ...existingMeta, [SERVER_INFO_META_KEY]: this.serverInfo },
    };
  }
}

function requiresTaskEnvelope(method: string): boolean {
  return method === "tools/call" || method === "tasks/get" || method === "tasks/update" || method === "tasks/cancel";
}

function requireTaskExtensions(params: Record<string, unknown>): void {
  const meta = isObject(params._meta) ? params._meta : {};
  const capabilities = isObject(meta[CLIENT_CAPABILITIES_META_KEY]) ? meta[CLIENT_CAPABILITIES_META_KEY] : {};
  const extensions = isObject(capabilities.extensions) ? capabilities.extensions : {};
  const missing: Record<string, unknown> = {};
  if (!isObject(extensions[MCP_TASKS_EXTENSION_ID])) missing[MCP_TASKS_EXTENSION_ID] = {};
  const mpasProfileExtension = extensions[MPAS_MCP_PROFILE_EXTENSION_ID];
  if (!isObject(mpasProfileExtension) || mpasProfileExtension.version !== MPAS_MCP_PROFILE_VERSION) {
    missing[MPAS_MCP_PROFILE_EXTENSION_ID] = { version: MPAS_MCP_PROFILE_VERSION };
  }
  if (Object.keys(missing).length > 0) {
    throw rpcError(-32003, "Missing required client capability", {
      requiredCapabilities: { extensions: missing },
    });
  }
}

function assertModernEnvelope(params: Record<string, unknown> | undefined): void {
  const meta = isObject(params?._meta) ? params._meta : undefined;
  if (!meta || meta[PROTOCOL_VERSION_META_KEY] !== MCP_TASKS_PROTOCOL_VERSION) {
    throw invalidParams(`Requests must declare ${PROTOCOL_VERSION_META_KEY}=${MCP_TASKS_PROTOCOL_VERSION}.`);
  }
  if (!isObject(meta[CLIENT_CAPABILITIES_META_KEY])) {
    throw invalidParams(`Requests must declare ${CLIENT_CAPABILITIES_META_KEY}.`);
  }
}

function protocolError(error: unknown): { code: number; message: string; data?: unknown } {
  if (isRpcError(error)) return error;
  if (error instanceof TaskNotFoundError) return { code: -32602, message: "Task not found" };
  if (error instanceof UnknownBridgeToolError) return { code: -32602, message: error.message };
  return { code: -32603, message: "Internal error" };
}

function invalidParams(message: string): RpcError {
  return rpcError(-32602, message);
}

interface RpcError extends Error {
  code: number;
  data?: unknown;
}

function rpcError(code: number, message: string, data?: unknown): RpcError {
  return Object.assign(new Error(message), { code, ...(data !== undefined ? { data } : {}) });
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
