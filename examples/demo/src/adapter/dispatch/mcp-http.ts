import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { createHardenedFetch } from "../hardened-fetch.js";
import { classifyOAuthPrepareError, oauthLoginCommand } from "../oauth-operator.js";
import { withInitializeProtocolVersion } from "./mcp-protocol-version.js";
import { errorMessage, McpClientSession, type DispatchPrepareResult } from "./mcp-stdio.js";

export interface McpHttpTarget {
  type: "mcp.http";
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  auth?: {
    type: "oauth2";
    session: string;
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
  oauthOperatorCommand?: string,
): Promise<DispatchPrepareResult> {
  const timeoutMs = target.timeoutMs ?? 30_000;
  const transport = new VersionedStreamableHttpClientTransport(
    new URL(target.url),
    {
      ...(authProvider ? { authProvider } : {}),
      // Shares the adapter's connect policy with the OAuth path. The SDK routes every
      // request through this, including the reauthorization it performs on a 401, which
      // is why the hardening cannot live in the OAuth helper alone. No per-attempt
      // deadline is set: a tools/call may legitimately run long, so the caller's own
      // timeout stays the only response bound and retries remain limited to connect
      // failures, where no request bytes were sent.
      fetch: createHardenedFetch({ label: "MCP request" }),
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
    if (authProvider) {
      return {
        ok: false,
        error: classifyOAuthPrepareError(
          error,
          oauthOperatorCommand ?? oauthLoginCommand({
            applicationDid: "unknown",
            resourceUrl: target.url,
            session: target.auth?.session ?? "unknown",
            credentialHandle: "unknown",
          }),
        ),
      };
    }
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
