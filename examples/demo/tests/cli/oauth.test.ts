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
      applicationDid: request.applicationDid,
      resourceUrl: request.resourceUrl,
      operatorCommand: oauthLoginCommand(request),
    })),
    status: vi.fn(async (request) => ({
      status: "authorized" as const,
      applicationDid: request.applicationDid,
      issuer: "https://auth.example",
      resource: "https://mcp.example/tools",
      clientMode: "cimd" as const,
      scopes: ["mcp:tools"],
      refreshable: true,
      reauthorizationRequired: false,
    })),
    logout: vi.fn(async (request) => ({
      status: "logged_out" as const,
      applicationDid: request.applicationDid,
      localCredentialsDeleted: true,
      remoteRevocation: "unavailable" as const,
    })),
  };
}

const applicationDid = "did:web:netlify.example";
const resourceUrl = "https://mcp.netlify.com/mcp";
const resolveOAuthDeployment = vi.fn(async (_configDir: string, selectedDid: string) => ({
  applicationDid: selectedDid,
  resourceUrl,
}));

describe("OAuth operator CLI", () => {
  it("requires an Application DID selector", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const result = await runCli(["oauth", "status"], { stdout, stderr });
    expect(result.exitCode).toBe(2);
    expect(stderr.text).toContain("--application-did <did>");
  });

  it("delegates operator login and honors print-only mode", async () => {
    const oauthOperator = service();
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const result = await runCli([
      "oauth", "login", "--application-did", applicationDid, "--no-browser",
    ], { stdout, stderr }, { oauthOperator, resolveOAuthDeployment });

    expect(result.exitCode).toBe(0);
    expect(oauthOperator.login).toHaveBeenCalledWith({
      applicationDid,
      resourceUrl,
      openBrowser: false,
    });
    expect(JSON.parse(stdout.text)).toMatchObject({ status: "oauth_login_required" });
  });

  it.each(["status", "logout"] as const)("delegates oauth %s", async (command) => {
    const oauthOperator = service();
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const result = await runCli([
      "oauth", command, "--application-did", applicationDid,
    ], { stdout, stderr }, { oauthOperator, resolveOAuthDeployment });
    expect(result.exitCode).toBe(0);
    expect(oauthOperator[command]).toHaveBeenCalledWith({ applicationDid, resourceUrl });
    expect(JSON.parse(stdout.text)).not.toHaveProperty("accessToken");
  });

  it("shell-quotes the exact operator command", () => {
    expect(oauthLoginCommand({ applicationDid, resourceUrl }))
      .toBe(`mpas oauth login --application-did '${applicationDid}'`);
  });
});
