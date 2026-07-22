import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { McpToolDefinition, UpstreamInfo } from "./types.js";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

interface InitializeResult {
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  serverInfo?: {
    name?: string;
    version?: string;
  };
}

interface ToolsListResult {
  tools?: McpToolDefinition[];
  nextCursor?: string;
}

export class UpstreamSpawnError extends Error {
  readonly exitCode = 2;
}

export class HandshakeError extends Error {
  readonly exitCode = 3;
}

export class ToolsListError extends Error {
  readonly exitCode = 4;
}

export async function discoverUpstream(command: string, args: string[]): Promise<UpstreamInfo> {
  process.stderr.write(`Spawning upstream: ${[command, ...args].join(" ")}\n`);

  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  const pending = new Map<number, {
    resolve: (value: JsonRpcResponse) => void;
    reject: (error: Error) => void;
  }>();

  let spawnSettled = false;
  child.once("spawn", () => {
    spawnSettled = true;
  });
  child.once("error", (error) => {
    for (const waiter of pending.values()) {
      waiter.reject(new UpstreamSpawnError(`Failed to spawn: ${command}: ${error.message}`));
    }
    pending.clear();
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let response: JsonRpcResponse;
    try {
      response = JSON.parse(line) as JsonRpcResponse;
    } catch (error) {
      for (const waiter of pending.values()) {
        waiter.reject(new HandshakeError(`Invalid JSON from upstream: ${errorMessage(error)}`));
      }
      pending.clear();
      return;
    }

    if (typeof response.id !== "number") {
      return;
    }

    const waiter = pending.get(response.id);
    if (!waiter) {
      return;
    }
    pending.delete(response.id);
    waiter.resolve(response);
  });

  child.once("exit", (code, signal) => {
    const message = spawnSettled
      ? `Upstream exited with code ${code ?? `signal ${signal ?? "unknown"}`}`
      : `Failed to spawn: ${command}`;
    const error = spawnSettled ? new HandshakeError(message) : new UpstreamSpawnError(message);
    for (const waiter of pending.values()) {
      waiter.reject(error);
    }
    pending.clear();
  });

  try {
    const initialize = await request(child, pending, 1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mpas-bridge-generator", version: "1.0.0" },
    }, 10_000, HandshakeError);

    if (initialize.error) {
      throw new HandshakeError(`initialize failed: ${initialize.error.message ?? "JSON-RPC error"}`);
    }
    const initResult = initialize.result as InitializeResult | undefined;
    if (!initResult?.serverInfo?.name) {
      throw new HandshakeError("Malformed response to initialize");
    }

    writeMessage(child, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    process.stderr.write(`MCP handshake complete: ${initResult.serverInfo.name} ${initResult.serverInfo.version ?? ""}\n`);

    const tools: McpToolDefinition[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let requestId = 2;
    do {
      const toolsList = await request(
        child,
        pending,
        requestId++,
        "tools/list",
        cursor === undefined ? undefined : { cursor },
        10_000,
        ToolsListError,
      );
      if (toolsList.error) {
        throw new ToolsListError(`tools/list failed: ${toolsList.error.message ?? "JSON-RPC error"}`);
      }
      const toolsResult = toolsList.result as ToolsListResult | undefined;
      if (!Array.isArray(toolsResult?.tools)) {
        throw new ToolsListError("Malformed response to tools/list");
      }
      tools.push(...toolsResult.tools.map(validateTool));

      const nextCursor = toolsResult.nextCursor;
      if (nextCursor !== undefined && typeof nextCursor !== "string") {
        throw new ToolsListError("Malformed nextCursor in response to tools/list");
      }
      if (nextCursor !== undefined) {
        if (seenCursors.has(nextCursor)) {
          throw new ToolsListError(`Repeated tools/list cursor: ${nextCursor}`);
        }
        seenCursors.add(nextCursor);
      }
      cursor = nextCursor;
    } while (cursor !== undefined);

    if (tools.length === 0) {
      throw new ToolsListError("Upstream reported zero tools");
    }

    const toolNames = new Set<string>();
    for (const tool of tools) {
      if (toolNames.has(tool.name)) {
        throw new ToolsListError(`Upstream reported duplicate tool name: ${tool.name}`);
      }
      toolNames.add(tool.name);
    }
    process.stderr.write(`Discovered ${tools.length} tools: ${tools.map((tool) => tool.name).join(", ")}\n`);

    return {
      command,
      args,
      serverName: initResult.serverInfo.name,
      serverVersion: initResult.serverInfo.version,
      protocolVersion: initResult.protocolVersion,
      tools,
    };
  } finally {
    await terminate(child);
  }
}

async function request(
  child: ChildProcessWithoutNullStreams,
  pending: Map<number, { resolve: (value: JsonRpcResponse) => void; reject: (error: Error) => void }>,
  id: number,
  method: string,
  params: unknown,
  timeoutMs: number,
  ErrorClass: new (message: string) => Error,
): Promise<JsonRpcResponse> {
  const response = new Promise<JsonRpcResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new ErrorClass(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
  });

  writeMessage(child, {
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });

  return response;
}

function writeMessage(child: ChildProcessWithoutNullStreams, message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function validateTool(value: unknown): McpToolDefinition {
  if (!isRecord(value) || typeof value.name !== "string" || !isRecord(value.inputSchema)) {
    throw new ToolsListError("Malformed tool definition from upstream");
  }

  return value as McpToolDefinition;
}

async function terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
