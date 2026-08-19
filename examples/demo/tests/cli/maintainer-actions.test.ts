import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/index.js";
import { createSignerToolClient, signerToolNames, type SignerToolClient, type SignerToolName } from "../../src/cli/signer-tools.js";

const demoRoot = fileURLToPath(new URL("../../", import.meta.url));
const execFileAsync = promisify(execFile);
let signerBuildDir: string | undefined;
let signerEntryPromise: Promise<string> | undefined;

function compiledSignerEntry(): Promise<string> {
  signerEntryPromise ??= (async () => {
    signerBuildDir = await mkdtemp(join(demoRoot, ".signer-test-build-"));
    await execFileAsync(
      process.execPath,
      [join(demoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json", "--outDir", signerBuildDir],
      { cwd: demoRoot },
    );
    return join(signerBuildDir, "signer-server", "index.js");
  })();
  return signerEntryPromise;
}

beforeAll(async () => { await compiledSignerEntry(); }, 15_000);

afterAll(async () => {
  await signerEntryPromise;
  if (signerBuildDir) await rm(signerBuildDir, { recursive: true, force: true });
});

class MemoryWriter {
  text = "";
  write(chunk: string | Uint8Array): boolean {
    this.text += chunk.toString();
    return true;
  }
}

class FakeSignerClient implements SignerToolClient {
  calls: Array<{ name: SignerToolName; args: Record<string, unknown> }> = [];
  connected = false;
  closed = false;

  constructor(
    private readonly responses: Partial<Record<SignerToolName, CallToolResult>> = {},
    private readonly tools: string[] = [...signerToolNames],
  ) {}

  async connect() { this.connected = true; }
  async listTools() { return this.tools; }
  async callTool(name: SignerToolName, args: Record<string, unknown>) {
    this.calls.push({ name, args });
    return this.responses[name] ?? result({ ok: true, tool: name });
  }
  async close() { this.closed = true; }
}

function result(structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: "ok" }], structuredContent };
}

function reviewResult(actionId: string): CallToolResult {
  return result({
    approvalRequest: {
      actionRef: {
        actionId: { value: actionId },
        actionEnvelopeHash: { alg: "sha-256", value: `hash-${actionId}` },
      },
    },
    reviewSet: { actionEnvelope: { actionId: { value: actionId } }, executionPayload: { name: "delete_branch" } },
  });
}

function decisionResult(actionId: string, decision: "approve" | "reject"): CallToolResult {
  return result({ approval: { actionEnvelopeHash: { alg: "sha-256", value: `hash-${actionId}` }, decision } });
}

function io() {
  return { stdout: new MemoryWriter(), stderr: new MemoryWriter() };
}

describe("human Maintainer action CLI", () => {
  it("lists pending actions through mpas_list_pending", async () => {
    const client = new FakeSignerClient({
      mpas_list_pending: result({ approvalRequests: [{ actionRef: { actionId: { value: "action-1" } } }] }),
    });
    const output = io();

    const response = await runCli(["action", "pending"], output, { signerToolClient: client });

    expect(response.exitCode).toBe(0);
    expect(client.calls).toEqual([{ name: "mpas_list_pending", args: {} }]);
    expect(output.stdout.text).toContain("action-1");
    expect(client.closed).toBe(true);
  });

  it("inspects an action without making a decision call", async () => {
    const client = new FakeSignerClient({
      mpas_review_action: reviewResult("action-2"),
    });
    const output = io();

    const response = await runCli(["action", "inspect", "action-2"], output, { signerToolClient: client });

    expect(response.exitCode).toBe(0);
    expect(client.calls).toEqual([{ name: "mpas_review_action", args: { actionId: "action-2" } }]);
    expect(output.stdout.text).toContain("delete_branch");
  });

  it.each([
    ["approve", "mpas_approve"],
    ["reject", "mpas_reject"],
  ] as const)("reviews and submits an explicit %s decision", async (decision, expectedTool) => {
    const client = new FakeSignerClient({
      mpas_review_action: reviewResult("action-3"),
      [expectedTool]: decisionResult("action-3", decision),
    });
    const output = io();

    const response = await runCli(["action", "review", "action-3"], output, {
      signerToolClient: client,
      promptReviewDecision: async () => decision,
    });

    expect(response.exitCode).toBe(0);
    expect(client.calls).toEqual([
      { name: "mpas_review_action", args: { actionId: "action-3" } },
      { name: expectedTool, args: { actionId: "action-3" } },
    ]);
    expect(output.stdout.text).toContain("will submit a signed MPAS decision");
  });

  it("cancels review without calling approve or reject", async () => {
    const client = new FakeSignerClient({ mpas_review_action: reviewResult("action-4") });
    const output = io();

    const response = await runCli(["action", "review", "action-4"], output, {
      signerToolClient: client,
      promptReviewDecision: async () => "cancel",
    });

    expect(response.exitCode).toBe(0);
    expect(client.calls).toEqual([{ name: "mpas_review_action", args: { actionId: "action-4" } }]);
    expect(output.stdout.text).toContain("No decision submitted");
  });

  it("fails closed when the signer server is missing a required tool", async () => {
    const client = new FakeSignerClient({}, signerToolNames.filter((name) => name !== "mpas_reject"));
    const output = io();

    const response = await runCli(["action", "pending"], output, { signerToolClient: client });

    expect(response.exitCode).toBe(1);
    expect(output.stderr.text).toContain("mpas_reject");
    expect(client.calls).toEqual([]);
    expect(client.closed).toBe(true);
  });

  it("requires an Action ID for inspect and review", async () => {
    const output = io();
    const response = await runCli(["action", "review"], output);
    expect(response.exitCode).toBe(2);
    expect(output.stderr.text).toContain("requires <action-id>");
  });

  it.each([
    ["missing structured content", { content: [{ type: "text", text: "looks fine" }] } as CallToolResult],
    ["malformed structured content", result({ reviewSet: "invalid" })],
    ["mismatched approval request", result({
      approvalRequest: { actionRef: { actionId: { value: "other" } } },
      reviewSet: { actionEnvelope: { actionId: { value: "action-5" } } },
    })],
    ["mismatched review set", result({
      approvalRequest: { actionRef: { actionId: { value: "action-5" } } },
      reviewSet: { actionEnvelope: { actionId: { value: "other" } } },
    })],
  ])("fails closed on %s and never prompts or decides", async (_label, response) => {
    const client = new FakeSignerClient({ mpas_review_action: response });
    const prompt = vi.fn(async () => "approve" as const);
    const output = io();

    const cliResult = await runCli(["action", "review", "action-5"], output, {
      signerToolClient: client,
      promptReviewDecision: prompt,
    });

    expect(cliResult.exitCode).toBe(1);
    expect(prompt).not.toHaveBeenCalled();
    expect(client.calls).toEqual([{ name: "mpas_review_action", args: { actionId: "action-5" } }]);
    expect(output.stderr.text).toMatch(/structured content|Action ID mismatch/);
  });

  it("rejects --config without a value before using the default", async () => {
    const client = new FakeSignerClient();
    const output = io();
    const response = await runCli(["action", "pending", "--config"], output, { signerToolClient: client });
    expect(response.exitCode).toBe(2);
    expect(output.stderr.text).toContain("--config requires a value");
    expect(client.connected).toBe(false);
  });

  it("omitting --config retains default behavior", async () => {
    const client = new FakeSignerClient({ mpas_list_pending: result({ approvalRequests: [] }) });
    const response = await runCli(["action", "pending"], io(), { signerToolClient: client });
    expect(response.exitCode).toBe(0);
    expect(client.connected).toBe(true);
  });

  it("returns nonzero for signer tool errors", async () => {
    const client = new FakeSignerClient({
      mpas_list_pending: { isError: true, content: [{ type: "text", text: "signer failed" }] },
    });
    const output = io();
    const response = await runCli(["action", "pending"], output, { signerToolClient: client });
    expect(response.exitCode).toBe(1);
    expect(output.stderr.text).toContain("signer failed");
  });

  it.each(["non-TTY", "EOF", "interruption"])("makes no decision call after %s prompt failure", async (reason) => {
    const client = new FakeSignerClient({ mpas_review_action: reviewResult("action-6") });
    const response = await runCli(["action", "review", "action-6"], io(), {
      signerToolClient: client,
      promptReviewDecision: async () => { throw new Error(reason); },
    });
    expect(response.exitCode).toBe(1);
    expect(client.calls).toEqual([{ name: "mpas_review_action", args: { actionId: "action-6" } }]);
  });

  it("uses the real MCP client against the real stdio signer server", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ version: "1", type: "CoordinationPollResponse", approvalRequests: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const dir = await mkdtemp(join(tmpdir(), "mpas-maintainer-cli-"));
    const configPath = join(dir, "signer.json");
    await writeFile(configPath, JSON.stringify({
      maintainerKey: join(demoRoot, "tests", "fixtures", "test-keys", "maintainer-a.json"),
      coordinationUrl: `http://127.0.0.1:${address.port}`,
    }));
    const client = createSignerToolClient(
      configPath,
      process.stderr,
      await compiledSignerEntry(),
    );
    try {
      const response = await runCli(["action", "pending"], io(), { signerToolClient: client });
      expect(response.exitCode).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("forwards local signer startup diagnostics", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mpas-maintainer-cli-bad-"));
    const configPath = join(dir, "signer.json");
    await writeFile(configPath, JSON.stringify({ maintainerKey: join(dir, "missing-key.json"), coordinationUrl: "http://127.0.0.1:1" }));
    const diagnostics = new MemoryWriter();
    const client = createSignerToolClient(
      configPath,
      diagnostics,
      await compiledSignerEntry(),
    );
    const output = io();
    const response = await runCli(["action", "pending"], output, { signerToolClient: client });
    expect(response.exitCode).toBe(1);
    expect(diagnostics.text).toMatch(/missing-key|ENOENT/);
  });
});
