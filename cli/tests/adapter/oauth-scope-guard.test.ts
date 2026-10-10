import { describe, expect, it, vi } from "vitest";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { guardOAuthScopes } from "../../src/adapter/oauth-scope-guard.js";

const provider = { tokens: async () => ({ access_token: "secret", token_type: "Bearer", scope: "read" }) } as OAuthClientProvider;

describe("unattended OAuth scope guard", () => {
  it.each([401, 403])("blocks wider scope at HTTP %i before SDK authentication", async (status) => {
    const trace = vi.fn();
    const send = guardOAuthScopes(async () => new Response(null, {
      status, headers: { "WWW-Authenticate": 'Bearer scope="read admin"' },
    }), provider, ["read"], "mpas oauth login --application example", trace);
    await expect(send("https://example.test/mcp")).rejects.toMatchObject({ code: "OAUTH_SCOPE_CHANGE_REQUIRED" });
    expect(trace).toHaveBeenCalledOnce();
    expect(JSON.stringify(trace.mock.calls)).not.toContain("secret");
  });

  it("leaves ordinary invalid-token responses to the existing refresh lifecycle", async () => {
    const response = new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' } });
    const send = guardOAuthScopes(async () => response, provider, ["read"], "mpas oauth login");
    expect(await send("https://example.test/mcp")).toBe(response);
  });

  it("requires operator review even when insufficient_scope omits scope", async () => {
    const send = guardOAuthScopes(async () => new Response(null, {
      status: 403, headers: { "WWW-Authenticate": 'Bearer error="insufficient_scope"' },
    }), provider, [], "mpas oauth login");
    await expect(send("https://example.test/mcp")).rejects.toMatchObject({
      code: "OAUTH_SCOPE_CHANGE_REQUIRED", challenge: { grantedScopes: ["read"], requestedScopes: [] },
    });
  });
});
