import { describe, expect, it, vi } from "vitest";
import {
  createOAuthFetchPolicy,
  OAuthFetchPolicyError,
} from "../../src/adapter/oauth-fetch-policy.js";

describe("OAuth fetch policy", () => {
  it("rejects non-HTTPS origins before making a request", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const policy = createOAuthFetchPolicy({ fetch: fetchFn });

    await expect(policy("http://example.com/.well-known/oauth-protected-resource"))
      .rejects.toBeInstanceOf(OAuthFetchPolicyError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("allows HTTP loopback only when explicitly enabled for local fixtures", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const policy = createOAuthFetchPolicy({ fetch: fetchFn, testOnlyAllowHttpLoopback: true });

    await expect(policy("http://127.0.0.1:49152/mcp")).resolves.toMatchObject({ status: 200 });
  });

  it("uses manual redirect handling and rejects redirect responses", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: "https://attacker.invalid/metadata" },
    }));
    const policy = createOAuthFetchPolicy({ fetch: fetchFn });

    await expect(policy("https://oauth.example/.well-known/oauth-authorization-server"))
      .rejects.toBeInstanceOf(OAuthFetchPolicyError);
    expect(fetchFn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ redirect: "manual" }));
  });

  it("combines a caller abort signal with the policy timeout", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const policy = createOAuthFetchPolicy({ fetch: fetchFn });
    const signal = AbortSignal.timeout(5_000);

    await expect(policy("https://oauth.example/metadata", { signal })).resolves.toMatchObject({ status: 200 });
    expect(fetchFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("aborts requests that exceed the configured timeout", async () => {
    const fetchFn = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const policy = createOAuthFetchPolicy({ fetch: fetchFn, timeoutMs: 5 });

    await expect(policy("https://oauth.example/metadata"))
      .rejects.toThrow("OAuth request timed out");
  });

  it("rejects oversized JSON responses", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ value: "oversized" }), {
      headers: { "content-type": "application/json" },
    }));
    const policy = createOAuthFetchPolicy({ fetch: fetchFn, maxJsonResponseBytes: 8 });

    await expect(policy("https://oauth.example/metadata"))
      .rejects.toThrow("OAuth JSON response exceeds the size limit");
  });

  it("allows Bearer authorization only on the exact configured MCP resource", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const policy = createOAuthFetchPolicy({
      fetch: fetchFn,
      bearerTokenResourceUrl: "https://mcp.example/tenant/tools",
    });
    const init = { headers: { authorization: "Bearer fixture-token" } };

    await expect(policy("https://mcp.example/tenant/tools", init)).resolves.toMatchObject({ status: 200 });
    await expect(policy("https://mcp.example/tenant/other", init))
      .rejects.toThrow("Bearer authorization is restricted to the exact MCP resource URL");
    await expect(policy("https://other.example/tenant/tools", init))
      .rejects.toThrow("Bearer authorization is restricted to the exact MCP resource URL");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not enforce a size limit on non-JSON responses", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(64), {
      headers: { "content-type": "text/plain" },
    }));
    const policy = createOAuthFetchPolicy({ fetch: fetchFn, maxJsonResponseBytes: 8 });

    await expect(policy("https://oauth.example/authorize")).resolves.toMatchObject({ status: 200 });
  });

  it("rejects JSON responses whose Content-Length exceeds the size limit", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", {
      headers: { "content-type": "application/json", "content-length": "4096" },
    }));
    const policy = createOAuthFetchPolicy({ fetch: fetchFn, maxJsonResponseBytes: 8 });

    await expect(policy("https://oauth.example/metadata"))
      .rejects.toThrow("OAuth JSON response exceeds the size limit");
  });

  it("rethrows non-timeout fetch failures", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new Error("socket hang up"));
    const policy = createOAuthFetchPolicy({ fetch: fetchFn });

    await expect(policy("https://oauth.example/metadata")).rejects.toThrow("socket hang up");
  });

  it("does not confuse OAuth client authentication with MCP Bearer authorization", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const policy = createOAuthFetchPolicy({ fetch: fetchFn });

    await expect(policy("https://oauth.example/token", {
      headers: { authorization: "Basic client-credentials" },
    })).resolves.toMatchObject({ status: 200 });
  });
});
