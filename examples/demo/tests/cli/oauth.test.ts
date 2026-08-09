import { describe, expect, it, vi } from "vitest";
import type { OAuthOperatorService } from "../../src/adapter/oauth-operator.js";
import { oauthLoginCommand } from "../../src/adapter/oauth-operator.js";
import { runCli } from "../../src/cli/index.js";

class MemoryWriter {
  text = "";
  write(chunk: string | Uint8Array): boolean {
    this.text += chunk.toString();
    return true;
  }
}

function service(): OAuthOperatorService {
  return {
    login: vi.fn(async (request) => ({
      status: "oauth_login_required" as const,
      deployment: request.deployment,
      session: request.session,
      operatorCommand: oauthLoginCommand(request),
    })),
    status: vi.fn(async (request) => ({
      status: "authorized" as const,
      deployment: request.deployment,
      session: request.session,
      issuer: "https://auth.example",
      resource: "https://mcp.example/tools",
      clientMode: "cimd" as const,
      scopes: ["mcp:tools"],
      refreshable: true,
      reauthorizationRequired: false,
    })),
    logout: vi.fn(async (request) => ({
      status: "logged_out" as const,
      deployment: request.deployment,
      session: request.session,
      localCredentialsDeleted: true,
      remoteRevocation: "unavailable" as const,
    })),
  };
}

const resolveOAuthDeployment = vi.fn(async (_configDir: string, name: string) => ({
  name,
  applicationDid: "did:web:netlify.example",
  resourceUrl: "https://mcp.netlify.com/mcp",
}));

describe("OAuth operator CLI", () => {
  it("requires deployment and session selectors", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const result = await runCli(["oauth", "status"], { stdout, stderr });
    expect(result.exitCode).toBe(2);
    expect(stderr.text).toContain("--deployment <deployment-name> and --session <session-name>");
  });

  it("delegates operator login and honors print-only mode", async () => {
    const oauthOperator = service();
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const result = await runCli([
      "oauth", "login", "--deployment", "netlify", "--session", "primary", "--no-browser",
    ], { stdout, stderr }, { oauthOperator, resolveOAuthDeployment });

    expect(result.exitCode).toBe(0);
    expect(oauthOperator.login).toHaveBeenCalledWith({
      deployment: "netlify",
      session: "primary",
      openBrowser: false,
    });
    expect(JSON.parse(stdout.text)).toMatchObject({ status: "oauth_login_required" });
  });

  it.each(["status", "logout"] as const)("delegates oauth %s", async (command) => {
    const oauthOperator = service();
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const result = await runCli([
      "oauth", command, "--deployment", "netlify", "--session", "primary",
    ], { stdout, stderr }, { oauthOperator, resolveOAuthDeployment });
    expect(result.exitCode).toBe(0);
    expect(oauthOperator[command]).toHaveBeenCalledWith({ deployment: "netlify", session: "primary" });
    expect(JSON.parse(stdout.text)).not.toHaveProperty("accessToken");
  });

  it("shell-quotes the exact operator command", () => {
    expect(oauthLoginCommand({ deployment: "tenant one", session: "user's session" }))
      .toBe(`mpas oauth login --deployment 'tenant one' --session 'user'"'"'s session'`);
  });

  it("rejects unsafe session aliases before service delegation", async () => {
    const oauthOperator = service();
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const result = await runCli([
      "oauth", "status", "--deployment", "netlify", "--session", "../other-user",
    ], { stdout, stderr }, { oauthOperator, resolveOAuthDeployment });
    expect(result.exitCode).toBe(1);
    expect(stderr.text).toContain("OAuth session name must be 1-64 characters");
    expect(oauthOperator.status).not.toHaveBeenCalled();
  });
});
