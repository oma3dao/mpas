import type { DispatchPrepareResult, DispatchSession, McpDispatchResult } from "./mcp-stdio.js";

export interface McpHttpTarget {
  type: "mcp.http";
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Prepare an HTTP dispatch session. Unlike stdio, the fetch-based client folds
 * connection establishment into transmission, so there is no separable pre-ledger
 * connect step; the ledger write occurs immediately before the request is sent.
 * Connection-level failures therefore surface at transmit time and are classified
 * conservatively as `indeterminate` (outcome unconfirmed) per the no-rollback rule.
 */
export async function prepareMcpHttp(target: McpHttpTarget, credential: string): Promise<DispatchPrepareResult> {
  const session: DispatchSession = {
    transmit: (toolName, args) => transmitMcpHttp(target, toolName, args, credential),
    close: () => {},
  };
  return { ok: true, session };
}

async function transmitMcpHttp(
  target: McpHttpTarget,
  toolName: string,
  args: object,
  credential: string,
): Promise<McpDispatchResult> {
  const timeoutMs = target.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(target.url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...injectCredential(target.headers ?? {}, credential),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: toolName,
          arguments: args,
        },
      }),
    });
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        ok: false,
        error: {
          kind: "McpDispatchError",
          code: "DISPATCH_TIMEOUT",
          message: `MCP HTTP dispatch timed out after ${timeoutMs} ms.`,
        },
      };
    }

    // Transport failure after the ledger write: the outcome is unconfirmed.
    return {
      ok: false,
      error: {
        kind: "McpDispatchError",
        code: "DISPATCH_TIMEOUT",
        message: `MCP HTTP transport error: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  } finally {
    clearTimeout(timer);
  }

  const json = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (!response.ok || json.error) {
    return {
      ok: false,
      error: {
        kind: "McpDispatchError",
        code: "INVALID_RESPONSE",
        message: json.error?.message ?? `MCP HTTP server returned ${response.status}.`,
      },
    };
  }

  return {
    ok: true,
    result: json.result,
  };
}

function injectCredential(headers: Record<string, string>, credential: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, value.replaceAll(/{{credential:[^}]+}}/g, credential)]),
  );
}
