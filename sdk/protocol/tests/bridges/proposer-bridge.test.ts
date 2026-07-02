import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ProposerBridge, type ActionPackage, type AdapterResponse, type MpasApplicationPlugin } from "../../src/index.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("ProposerBridge", () => {
  it("loads the GitHub plugin and registers 3 tools", async () => {
    const bridge = await buildBridge({ adapterUrl: "http://127.0.0.1:1" });

    expect(bridge.getToolDefinitions().map((tool) => tool.name)).toEqual([
      "create_issue",
      "merge_pull_request",
      "delete_branch",
    ]);
  });

  it("handles a tool call with an executed adapter response", async () => {
    const executed = await readJson<AdapterResponse>(join(fixturesDir, "responses", "adapter-response-executed.json"));
    let submittedPackage: ActionPackage | undefined;
    const adapter = await startMockServer(async (request, response) => {
      submittedPackage = (JSON.parse(await readRequestBody(request)) as { actionPackage: ActionPackage }).actionPackage;
      sendJson(response, executed);
    });

    try {
      const bridge = await buildBridge({ adapterUrl: adapter.url });
      const result = await bridge.handleToolCall("create_issue", {
        owner: "oma3dao",
        repo: "test",
        title: "Hello",
      });

      expect(result.isError).toBeUndefined();
      expect(result.content).toEqual([{ type: "text", text: "Created issue #123" }]);
      expect(submittedPackage?.executionPayload.name).toBe("create_issue");
    } finally {
      await adapter.close();
    }
  });

  it("coordinates pending actions when additional approvals are required", async () => {
    const needsApprovals = await readJson<AdapterResponse>(
      join(fixturesDir, "responses", "adapter-response-needs-approvals.json"),
    );
    let coordinationSubmission: { actionPackage: ActionPackage } | undefined;
    const adapter = await startMockServer((_request, response) => {
      sendJson(response, needsApprovals);
    });
    const coordination = await startMockServer(async (request, response) => {
      expect(request.url).toBe("/mpas/v1/coordination/action");
      coordinationSubmission = JSON.parse(await readRequestBody(request)) as { actionPackage: ActionPackage };
      sendJson(response, coordinationActionResponse(coordinationSubmission.actionPackage));
    });

    try {
      const bridge = await buildBridge({
        adapterUrl: adapter.url,
        coordinationUrl: coordination.url,
        approvalStrategy: "coordinate",
      });
      const result = await bridge.handleToolCall("merge_pull_request", {
        owner: "oma3dao",
        repo: "app-registry",
        pullNumber: 42,
        baseRef: "main",
        expectedHeadSha: "abc123def456",
        mergeMethod: "squash",
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        status: "pending",
        coordinationActionRef: coordinationSubmission ? coordinationActionRef(coordinationSubmission.actionPackage) : undefined,
      });
      expect(coordinationSubmission?.actionPackage.executionPayload.name).toBe("merge_pull_request");
    } finally {
      await adapter.close();
      await coordination.close();
    }
  });

  it("returns validation errors before adapter submission", async () => {
    let submissions = 0;
    const adapter = await startMockServer((_request, response) => {
      submissions += 1;
      sendJson(response, { result: "malformed", error: { code: "UNEXPECTED", message: "Should not be called." } });
    });

    try {
      const bridge = await buildBridge({ adapterUrl: adapter.url });
      const result = await bridge.handleToolCall("create_issue", {
        owner: "oma3dao",
        repo: "test",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({ type: "text" });
      expect(submissions).toBe(0);
    } finally {
      await adapter.close();
    }
  });

  it("waits for coordinated actions to resolve", async () => {
    const needsApprovals = await readJson<AdapterResponse>(
      join(fixturesDir, "responses", "adapter-response-needs-approvals.json"),
    );
    const executed = await readJson<Extract<AdapterResponse, { result: "executed" }>>(
      join(fixturesDir, "responses", "adapter-response-executed.json"),
    );
    let adapterSubmissions = 0;
    let coordinationSubmission: { actionPackage: ActionPackage } | undefined;
    const adapter = await startMockServer((_request, response) => {
      adapterSubmissions += 1;
      sendJson(response, adapterSubmissions === 1 ? needsApprovals : executed);
    });
    const coordination = await startMockServer(async (request, response) => {
      if (request.url === "/mpas/v1/coordination/action") {
        coordinationSubmission = JSON.parse(await readRequestBody(request)) as { actionPackage: ActionPackage };
        sendJson(response, coordinationActionResponse(coordinationSubmission.actionPackage));
        return;
      }
      if (request.url === "/mpas/v1/coordination/poll" && coordinationSubmission) {
        await readRequestBody(request);
        sendJson(response, {
          version: "1",
          type: "CoordinationPollResponse",
          approvalRequests: [],
          actionUpdates: [
            {
              version: "1",
              type: "CoordinationActionUpdate",
              actionRef: coordinationActionRef(coordinationSubmission.actionPackage),
              state: "readyForResubmission",
              progress: {
                required: 1,
                collected: 1,
                pending: [],
              },
              actionPackage: coordinationSubmission.actionPackage,
            },
          ],
        });
        return;
      }
      response.statusCode = 404;
      response.end();
    });

    try {
      const bridge = await buildBridge({
        adapterUrl: adapter.url,
        coordinationUrl: coordination.url,
        approvalStrategy: "wait",
        approvalTimeoutMs: 500,
      });
      const result = await bridge.handleToolCall("merge_pull_request", {
        owner: "oma3dao",
        repo: "app-registry",
        pullNumber: 42,
        baseRef: "main",
        expectedHeadSha: "abc123def456",
        mergeMethod: "squash",
      });

      expect(result.isError).toBeUndefined();
      expect(result.content).toEqual([{ type: "text", text: "Created issue #123" }]);
      expect(adapterSubmissions).toBe(2);
    } finally {
      await adapter.close();
      await coordination.close();
    }
  });
});

async function buildBridge(overrides: {
  adapterUrl: string;
  coordinationUrl?: string;
  approvalStrategy?: "return" | "coordinate" | "wait";
  approvalTimeoutMs?: number;
}): Promise<ProposerBridge> {
  const plugin = await readJson<MpasApplicationPlugin>(join(fixturesDir, "plugins", "github-repo.json"));

  return new ProposerBridge({
    plugin,
    applicationDid: plugin.applicationDid,
    adapterUrl: overrides.adapterUrl,
    agentKey: join(fixturesDir, "keys", "proposer.json"),
    coordinationUrl: overrides.coordinationUrl,
    approvalStrategy: overrides.approvalStrategy,
    approvalTimeoutMs: overrides.approvalTimeoutMs,
  });
}

async function startMockServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : "mock server error");
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock server did not bind to a TCP port.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

function coordinationActionRef(actionPackage: ActionPackage) {
  return {
    version: "1" as const,
    type: "ActionRef" as const,
    actionId: actionPackage.actionEnvelope.actionId,
    actionEnvelopeHash: actionPackage.approvalBundle.actionEnvelopeHash,
  };
}

function coordinationActionResponse(actionPackage: ActionPackage) {
  return {
    version: "1" as const,
    type: "CoordinationActionResponse" as const,
    actionRef: coordinationActionRef(actionPackage),
    state: "awaitingApprovals" as const,
  };
}

function sendJson(response: ServerResponse, body: unknown, statusCode = 200): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}
