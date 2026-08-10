import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { withInitializeProtocolVersion } from "./mcp-protocol-version.js";
import { errorMessage, McpClientSession, type DispatchPrepareResult } from "./mcp-stdio.js";

export interface McpHttpTarget {
  type: "mcp.http";
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  auth?: {
    type: "oauth2";
    scopes?: string[];
  };
}

/**
 * Connect and initialize the HTTP MCP target before the ledger write. A later
 * transport failure during tools/call remains indeterminate.
 */
export async function prepareMcpHttp(
  target: McpHttpTarget,
  credential: string | undefined,
  protocolVersion: string,
  authProvider?: OAuthClientProvider,
): Promise<DispatchPrepareResult> {
  const timeoutMs = target.timeoutMs ?? 30_000;
  const transport = new VersionedStreamableHttpClientTransport(
    new URL(target.url),
    {
      ...(authProvider ? { authProvider } : {}),
      requestInit: {
        headers: credential ? injectCredential(target.headers ?? {}, credential) : target.headers,
      },
    },
    protocolVersion,
  );
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

class VersionedStreamableHttpClientTransport extends StreamableHTTPClientTransport {
  constructor(
    url: URL,
    options: ConstructorParameters<typeof StreamableHTTPClientTransport>[1],
    private readonly initializationProtocolVersion: string,
  ) {
    super(url, options);
  }

  override send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return super.send(
      withInitializeProtocolVersion(message, this.initializationProtocolVersion),
      options,
    );
  }
}

function injectCredential(headers: Record<string, string>, credential: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, value.replaceAll(/{{credential:[^}]+}}/g, credential)]),
  );
}
