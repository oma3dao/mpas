import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError as SdkMcpError } from "@modelcontextprotocol/sdk/types.js";

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

export interface McpDispatchError {
  ok: false;
  error: {
    kind: "McpDispatchError";
    code: "PROCESS_EXITED" | "INVALID_RESPONSE" | "DISPATCH_TIMEOUT" | "TRANSPORT_ERROR";
    message: string;
  };
}

export type McpDispatchResult = McpResult | McpDispatchError;

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
  close(): Promise<void>;
}

export type DispatchPrepareResult = { ok: true; session: DispatchSession } | { ok: false; error: DispatchPrepareError };

export class McpClientSession implements DispatchSession {
  constructor(
    private readonly client: Client,
    private readonly timeoutMs: number,
    private readonly connectionFailureCode: "PROCESS_EXITED" | "TRANSPORT_ERROR",
  ) {}

  async transmit(toolName: string, args: object): Promise<McpDispatchResult> {
    try {
      const result = await this.client.callTool(
        { name: toolName, arguments: args as Record<string, unknown> },
        undefined,
        { timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs },
      );
      return { ok: true, result };
    } catch (error) {
      if (error instanceof SdkMcpError && error.code === ErrorCode.RequestTimeout) {
        return {
          ok: false,
          error: {
            kind: "McpDispatchError",
            code: "DISPATCH_TIMEOUT",
            message: `MCP dispatch timed out after ${this.timeoutMs} ms.`,
          },
        };
      }
      if (error instanceof SdkMcpError && error.code !== ErrorCode.ConnectionClosed) {
        return {
          ok: false,
          error: {
            kind: "McpDispatchError",
            code: "INVALID_RESPONSE",
            message: error.message,
          },
        };
      }
      return {
        ok: false,
        error: {
          kind: "McpDispatchError",
          code: this.connectionFailureCode,
          message:
            this.connectionFailureCode === "PROCESS_EXITED"
              ? "MCP stdio process exited before responding."
              : `MCP transport failed after dispatch: ${errorMessage(error)}`,
        },
      };
    }
  }

  async close(): Promise<void> {
    // Cleanup must not replace a definitive tools/call result or disturb the
    // action lifecycle if a transport fails while closing.
    await this.client.close().catch(() => {});
  }
}

/**
 * Launch and initialize the stdio MCP target before the ledger write. Spawn or
 * initialization failures are stateless preparation errors.
 */
export async function prepareMcpStdio(target: McpStdioTarget, credential: string): Promise<DispatchPrepareResult> {
  const timeoutMs = target.timeoutMs ?? 30_000;
  const transport = new StdioClientTransport({
    command: target.command,
    args: target.args ?? [],
    env: {
      ...definedProcessEnvironment(),
      ...injectCredential(target.env ?? {}, credential),
    },
    stderr: "inherit",
  });
  const client = new Client(
    { name: "mpas-credential-adapter", version: "1.0.0" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport, { timeout: timeoutMs, maxTotalTimeout: timeoutMs });
  } catch (error) {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    return {
      ok: false,
      error: {
        code: "TARGET_UNAVAILABLE",
        message: `MCP stdio target could not be launched and initialized: ${errorMessage(error)}`,
      },
    };
  }
  return { ok: true, session: new McpClientSession(client, timeoutMs, "PROCESS_EXITED") };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function definedProcessEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function injectCredential(env: Record<string, string>, credential: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, value.replaceAll(/{{credential:[^}]+}}/g, credential)]),
  );
}
