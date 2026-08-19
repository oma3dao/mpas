import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/index.js";
import { signerToolNames, type SignerToolClient, type SignerToolName } from "../../src/cli/signer-tools.js";

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
      mpas_review_action: result({ reviewSet: { operation: "delete_branch", digest: "sha256:abc" } }),
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
      mpas_review_action: result({ reviewSet: { actionId: "action-3", digest: "sha256:def" } }),
      [expectedTool]: result({ accepted: true, decision }),
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
    const client = new FakeSignerClient();
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
});
