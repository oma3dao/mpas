import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { errorMessage, McpClientSession, type DispatchPrepareResult } from "./mcp-stdio.js";

export interface McpHttpTarget {
  type: "mcp.http";
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Connect and initialize the HTTP MCP target before the ledger write. A later
 * transport failure during tools/call remains indeterminate.
 */
export async function prepareMcpHttp(target: McpHttpTarget, credential: string): Promise<DispatchPrepareResult> {
  const timeoutMs = target.timeoutMs ?? 30_000;
  const transport = new StreamableHTTPClientTransport(new URL(target.url), {
    requestInit: {
      headers: injectCredential(target.headers ?? {}, credential),
    },
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
        message: `MCP HTTP target could not be connected and initialized: ${errorMessage(error)}`,
      },
    };
  }
  return {
    ok: true,
    session: new McpClientSession(client, timeoutMs, "TRANSPORT_ERROR"),
  };
}

function injectCredential(headers: Record<string, string>, credential: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, value.replaceAll(/{{credential:[^}]+}}/g, credential)]),
  );
}
