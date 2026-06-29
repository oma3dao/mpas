import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MaintainerBridge, type Approval, type CoordinationPollResponse, type SignerReviewSet } from "../../src/index.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("MaintainerBridge", () => {
  it("registers 4 maintainer tools", async () => {
    const bridge = new MaintainerBridge({
      maintainerKey: join(fixturesDir, "keys", "maintainer-a.json"),
      coordinationUrl: "http://127.0.0.1:1",
    });

    expect(bridge.getToolDefinitions().map((tool) => tool.name)).toEqual([
      "mpas_list_pending",
      "mpas_review_action",
      "mpas_approve",
      "mpas_reject",
    ]);
  });

  it("lists pending actions from coordination", async () => {
    const pollResponse = await readJson<CoordinationPollResponse>(
      join(fixturesDir, "responses", "coordination-pending-actions.json"),
    );
    const coordination = await startMockCoordination((_request, response) => {
      sendJson(response, pollResponse);
    });

    try {
      const bridge = new MaintainerBridge({
        maintainerKey: join(fixturesDir, "keys", "maintainer-a.json"),
        coordinationUrl: coordination.url,
      });
      const result = await bridge.handleToolCall("mpas_list_pending", {});

      expect(result.structuredContent).toEqual({ approvalRequests: pollResponse.approvalRequests });
    } finally {
      await coordination.close();
    }
  });

  it("returns verified review data", async () => {
    const pollResponse = await readJson<CoordinationPollResponse>(
      join(fixturesDir, "responses", "coordination-pending-actions.json"),
    );
    const reviewSet = pollResponse.approvalRequests[0].signerReviewSet;
    const coordination = await startMockCoordination((_request, response) => {
      sendJson(response, pollResponse);
    });

    try {
      const bridge = new MaintainerBridge({
        maintainerKey: join(fixturesDir, "keys", "maintainer-a.json"),
        coordinationUrl: coordination.url,
      });
      const result = await bridge.handleToolCall("mpas_review_action", {
        actionId: reviewSet.actionEnvelope.actionId.value,
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({ approvalRequest: pollResponse.approvalRequests[0], reviewSet });
    } finally {
      await coordination.close();
    }
  });

  it("builds and submits approvals", async () => {
    const pollResponse = await readJson<CoordinationPollResponse>(
      join(fixturesDir, "responses", "coordination-pending-actions.json"),
    );
    const reviewSet = pollResponse.approvalRequests[0].signerReviewSet;
    let submittedApproval: Approval | undefined;
    let submittedHash: unknown;
    const coordination = await startMockCoordination(async (request, response) => {
      if (request.url === "/mpas/v1/coordination/poll") {
        sendJson(response, pollResponse);
        return;
      }
      if (request.url === "/mpas/v1/coordination/approval") {
        const body = JSON.parse(await readRequestBody(request)) as { actionEnvelopeHash: unknown; approval: Approval };
        submittedApproval = body.approval;
        submittedHash = body.actionEnvelopeHash;
        sendJson(response, { version: "1", type: "CoordinationApprovalSubmissionResponse", accepted: true });
        return;
      }
      response.statusCode = 404;
      response.end();
    });

    try {
      const bridge = new MaintainerBridge({
        maintainerKey: join(fixturesDir, "keys", "maintainer-a.json"),
        coordinationUrl: coordination.url,
      });
      const result = await bridge.handleToolCall("mpas_approve", {
        actionId: reviewSet.actionEnvelope.actionId.value,
      });

      expect(result.isError).toBeUndefined();
      expect(submittedApproval?.decision).toBe("approve");
      expect(submittedHash).toEqual(pollResponse.approvalRequests[0].actionRef.actionEnvelopeHash);
      expect(result.structuredContent).toMatchObject({
        approval: {
          decision: "approve",
        },
      });
    } finally {
      await coordination.close();
    }
  });

  it("rejects tampered review sets before presenting them", async () => {
    const pollResponse = await readJson<CoordinationPollResponse>(
      join(fixturesDir, "responses", "coordination-pending-actions.json"),
    );
    const reviewSet = pollResponse.approvalRequests[0].signerReviewSet;
    const tamperedReviewSet: SignerReviewSet = {
      ...reviewSet,
      executionPayload: {
        ...reviewSet.executionPayload,
        arguments: {
          ...reviewSet.executionPayload.arguments,
          title: "Tampered title",
        },
      },
    };
    const tamperedPollResponse: CoordinationPollResponse = {
      ...pollResponse,
      approvalRequests: [
        {
          ...pollResponse.approvalRequests[0],
          signerReviewSet: tamperedReviewSet,
        },
      ],
    };
    const coordination = await startMockCoordination((_request, response) => {
      sendJson(response, tamperedPollResponse);
    });

    try {
      const bridge = new MaintainerBridge({
        maintainerKey: join(fixturesDir, "keys", "maintainer-a.json"),
        coordinationUrl: coordination.url,
      });
      const result = await bridge.handleToolCall("mpas_review_action", {
        actionId: reviewSet.actionEnvelope.actionId.value,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("REVIEW_SET_INTEGRITY_ERROR"),
      });
    } finally {
      await coordination.close();
    }
  });
});

async function startMockCoordination(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : "mock coordination error");
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock coordination service did not bind to a TCP port.");
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
