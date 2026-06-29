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

describe("bridge to adapter integration", () => {
  it("returns execution results from a mock Credential Adapter", async () => {
    const plugin = await readJson<MpasApplicationPlugin>(join(fixturesDir, "plugins", "github-repo.json"));
    const executed = await readJson<AdapterResponse>(join(fixturesDir, "responses", "adapter-response-executed.json"));
    let submittedPackage: ActionPackage | undefined;
    const adapter = await startMockServer(async (request, response) => {
      expect(request.url).toBe("/mpas/v1/action");
      submittedPackage = (JSON.parse(await readRequestBody(request)) as { actionPackage: ActionPackage }).actionPackage;
      sendJson(response, executed);
    });

    try {
      const bridge = new ProposerBridge({
        plugin,
        applicationDid: plugin.applicationDid,
        adapterUrl: adapter.url,
        agentKey: join(fixturesDir, "keys", "proposer.json"),
      });
      const result = await bridge.handleToolCall("create_issue", {
        owner: "oma3dao",
        repo: "test",
        title: "Hello",
      });

      expect(result.content).toEqual([{ type: "text", text: "Created issue #123" }]);
      expect(submittedPackage?.executionPayload).toEqual({
        name: "create_issue",
        arguments: {
          owner: "oma3dao",
          repo: "test",
          title: "Hello",
        },
      });
    } finally {
      await adapter.close();
    }
  });

  it("submits pending actions to coordination when adapter requires approvals", async () => {
    const plugin = await readJson<MpasApplicationPlugin>(join(fixturesDir, "plugins", "github-repo.json"));
    const needsApprovals = await readJson<AdapterResponse>(
      join(fixturesDir, "responses", "adapter-response-needs-approvals.json"),
    );
    let coordinationBody: { actionPackage: ActionPackage; authorizationRequirements: unknown } | undefined;
    const adapter = await startMockServer((_request, response) => {
      sendJson(response, needsApprovals);
    });
    const coordination = await startMockServer(async (request, response) => {
      expect(request.url).toBe("/mpas/v1/coordination/action");
      coordinationBody = JSON.parse(await readRequestBody(request)) as {
        actionPackage: ActionPackage;
        authorizationRequirements: unknown;
      };
      sendJson(response, coordinationActionResponse(coordinationBody.actionPackage));
    });

    try {
      const bridge = new ProposerBridge({
        plugin,
        applicationDid: plugin.applicationDid,
        adapterUrl: adapter.url,
        agentKey: join(fixturesDir, "keys", "proposer.json"),
        approvalStrategy: "coordinate",
        coordinationUrl: coordination.url,
      });
      const result = await bridge.handleToolCall("merge_pull_request", {
        owner: "oma3dao",
        repo: "app-registry",
        pullNumber: 42,
        baseRef: "main",
        expectedHeadSha: "abc123def456",
        mergeMethod: "squash",
      });

      expect(result.structuredContent).toMatchObject({
        status: "pending",
        coordinationActionRef: coordinationBody ? coordinationActionRef(coordinationBody.actionPackage) : undefined,
      });
      expect(coordinationBody?.actionPackage.executionPayload.name).toBe("merge_pull_request");
      expect(coordinationBody?.authorizationRequirements).toEqual(
        (needsApprovals as Extract<AdapterResponse, { result: "additionalApprovalsRequired" }>).authorizationRequirements,
      );
    } finally {
      await adapter.close();
      await coordination.close();
    }
  });
});

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
