import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

export interface McpStdioTarget {
  type: "mcp.stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface McpResult {
  ok: true;
  result: unknown;
}

export interface McpError {
  ok: false;
  error: {
    kind: "McpDispatchError";
    code: "PROCESS_EXITED" | "INVALID_RESPONSE" | "DISPATCH_TIMEOUT";
    message: string;
  };
}

export type McpDispatchResult = McpResult | McpError;

/**
 * Result of preparing a dispatch target (launch / connect). Per the Core Action
 * Lifecycle (addition A), preparation happens BEFORE the ledger write, so a
 * preparation failure is a stateless rejection: nothing is recorded, no receipt
 * is issued, and an identical resubmission simply retries.
 */
export interface DispatchPrepareError {
  code: "TARGET_UNAVAILABLE";
  message: string;
}

export interface DispatchSession {
  /** Transmit the request and await the outcome. Called AFTER the ledger write. */
  transmit(toolName: string, args: object): Promise<McpDispatchResult>;
  close(): void;
}

export type DispatchPrepareResult = { ok: true; session: DispatchSession } | { ok: false; error: DispatchPrepareError };

interface PendingRequest {
  timer: NodeJS.Timeout;
  resolve: (result: McpDispatchResult) => void;
}

class McpStdioSession implements DispatchSession {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private exited = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly lines: Interface,
    private readonly timeoutMs: number,
  ) {
    this.lines.on("line", (line) => this.handleLine(line));
    this.child.on("exit", () => {
      this.exited = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.resolve(processExited());
      }
      this.pending.clear();
    });
  }

  transmit(toolName: string, args: object): Promise<McpDispatchResult> {
    if (this.exited) {
      return Promise.resolve(processExited());
    }

    const id = this.nextId;
    this.nextId += 1;
    const request = {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    };

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          ok: false,
          error: {
            kind: "McpDispatchError",
            code: "DISPATCH_TIMEOUT",
            message: `MCP stdio dispatch timed out after ${this.timeoutMs} ms.`,
          },
        });
        this.close();
      }, this.timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  close(): void {
    this.lines.close();
    this.child.kill();
  }

  private handleLine(line: string): void {
    let response: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      response = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
    } catch {
      return;
    }

    if (typeof response.id !== "number") {
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }

    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error) {
      pending.resolve({
        ok: false,
        error: {
          kind: "McpDispatchError",
          code: "INVALID_RESPONSE",
          message: response.error.message ?? "MCP stdio server returned an error.",
        },
      });
      return;
    }

    pending.resolve({ ok: true, result: response.result });
  }
}

/**
 * Launch the stdio target and wait until the process has spawned. Spawn failures
 * (e.g. command not found) are returned as a stateless preparation error.
 */
export async function prepareMcpStdio(target: McpStdioTarget, credential: string): Promise<DispatchPrepareResult> {
  const timeoutMs = target.timeoutMs ?? 30_000;
  const child = spawn(target.command, target.args ?? [], {
    env: {
      ...process.env,
      ...injectCredential(target.env ?? {}, credential),
    },
  });

  const launch = await new Promise<{ ok: true } | { ok: false; message: string }>((resolve) => {
    const onSpawn = () => {
      cleanup();
      resolve({ ok: true });
    };
    const onError = (error: Error) => {
      cleanup();
      resolve({ ok: false, message: error.message });
    };
    const cleanup = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });

  if (!launch.ok) {
    child.kill();
    return {
      ok: false,
      error: { code: "TARGET_UNAVAILABLE", message: `MCP stdio target could not be launched: ${launch.message}` },
    };
  }

  const lines = createInterface({ input: child.stdout });
  return { ok: true, session: new McpStdioSession(child, lines, timeoutMs) };
}

function processExited(): McpError {
  return {
    ok: false,
    error: {
      kind: "McpDispatchError",
      code: "PROCESS_EXITED",
      message: "MCP stdio process exited before responding.",
    },
  };
}

function injectCredential(env: Record<string, string>, credential: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, value.replaceAll(/{{credential:[^}]+}}/g, credential)]),
  );
}
