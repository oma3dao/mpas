import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startOAuthProtectedMcpFixture } from "../fixtures/oauth-protected-mcp.js";

const spawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn };
});

const { fileOAuthOperatorService } = await import("../../src/adapter/oauth-operator.js");

const applicationDid = "did:web:netlify.example";
const session = "netlify-production";
const credentialHandle = "netlify-oauth-token";

function mockSpawn(outcome: "ok" | "fail" | "error"): void {
  spawn.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => {
      if (outcome === "error") {
        child.emit("error", new Error("spawn xdg-open ENOENT"));
        return;
      }
      child.emit("exit", outcome === "ok" ? 0 : 1);
    });
    return child;
  });
}

describe("OAuth operator openUrl", () => {
  afterEach(() => {
    spawn.mockReset();
  });

  it("opens the authorization URL through the platform browser helper", async () => {
    mockSpawn("ok");
    const fixture = await startOAuthProtectedMcpFixture();
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-openurl-"));
    const service = fileOAuthOperatorService({
      credentialDir,
      testOnlyAllowHttpLoopback: true,
      onAuthorizationUrl: async (url) => {
        const redirect = new URL(url.searchParams.get("redirect_uri")!);
        redirect.searchParams.set("code", "fixture-code");
        redirect.searchParams.set("state", url.searchParams.get("state")!);
        await fetch(redirect);
      },
    });

    try {
      await expect(
        service.login({
          applicationDid,
          resourceUrl: fixture.resourceUrl,
          session,
          credentialHandle,
          scopes: ["mcp:tools"],
          openBrowser: true,
        }),
      ).resolves.toMatchObject({ status: "authorized" });
      expect(spawn).toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it("rejects when the platform browser helper exits non-zero", async () => {
    mockSpawn("fail");
    const fixture = await startOAuthProtectedMcpFixture();
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-openurl-fail-"));
    const service = fileOAuthOperatorService({
      credentialDir,
      testOnlyAllowHttpLoopback: true,
    });

    try {
      await expect(
        service.login({
          applicationDid,
          resourceUrl: fixture.resourceUrl,
          session,
          credentialHandle,
          openBrowser: true,
        }),
      ).rejects.toThrow(/Unable to open OAuth authorization URL/);
    } finally {
      await fixture.close();
    }
  });

  it("rejects when the platform browser helper cannot be spawned", async () => {
    mockSpawn("error");
    const fixture = await startOAuthProtectedMcpFixture();
    const credentialDir = await mkdtemp(join(tmpdir(), "mpas-oauth-openurl-error-"));
    const service = fileOAuthOperatorService({
      credentialDir,
      testOnlyAllowHttpLoopback: true,
    });

    try {
      await expect(
        service.login({
          applicationDid,
          resourceUrl: fixture.resourceUrl,
          session,
          credentialHandle,
          openBrowser: true,
        }),
      ).rejects.toThrow(/spawn xdg-open ENOENT/);
    } finally {
      await fixture.close();
    }
  });
});
