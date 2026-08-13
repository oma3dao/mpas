import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { SignerServer } from "../../src/signer-server/index.js";
import type { Approval, CoordinationPollResponse, SignerReviewSet } from "../../src/signer-server/types.js";

const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const testKeysDir = fileURLToPath(new URL("../fixtures/test-keys/", import.meta.url));

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("SignerServer", () => {
  it("registers 4 signer tools", async () => {
    const server = new SignerServer({
      signerKey: join(testKeysDir, "maintainer-a.json"),
      coordinationUrl: "http://127.0.0.1:1",
    });

    expect(server.getToolDefinitions().map((tool) => tool.name)).toEqual([
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
      const server = new SignerServer({
        signerKey: join(testKeysDir, "maintainer-a.json"),
        coordinationUrl: coordination.url,
      });
      const result = await server.handleToolCall("mpas_list_pending", {});

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
      const server = new SignerServer({
        signerKey: join(testKeysDir, "maintainer-a.json"),
        coordinationUrl: coordination.url,
      });
      const result = await server.handleToolCall("mpas_review_action", {
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
      const server = new SignerServer({
        signerKey: join(testKeysDir, "maintainer-a.json"),
        coordinationUrl: coordination.url,
      });
      const result = await server.handleToolCall("mpas_approve", {
        actionId: reviewSet.actionEnvelope.actionId.value,
      });

      expect(result.isError).toBeUndefined();
      expect(submittedApproval?.decision).toBe("approve");
      expect(submittedHash).toEqual(pollResponse.approvalRequests[0].actionRef.actionEnvelopeHash);
      expect(result.structuredContent).toMatchObject({
        approval: { decision: "approve" },
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
    const originalPayload = reviewSet.executionPayload as Record<string, unknown>;
    const tamperedReviewSet: SignerReviewSet = {
      ...reviewSet,
      executionPayload: {
        ...originalPayload,
        arguments: {
          ...(originalPayload.arguments as Record<string, unknown>),
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
      const server = new SignerServer({
        signerKey: join(testKeysDir, "maintainer-a.json"),
        coordinationUrl: coordination.url,
      });
      const result = await server.handleToolCall("mpas_review_action", {
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

  it("builds and submits reject decisions", async () => {
    const pollResponse = await readJson<CoordinationPollResponse>(
      join(fixturesDir, "responses", "coordination-pending-actions.json"),
    );
    const reviewSet = pollResponse.approvalRequests[0].signerReviewSet;
    let submittedApproval: Approval | undefined;
    const coordination = await startMockCoordination(async (request, response) => {
      if (request.url === "/mpas/v1/coordination/poll") {
        sendJson(response, pollResponse);
        return;
      }
      if (request.url === "/mpas/v1/coordination/approval") {
        const body = JSON.parse(await readRequestBody(request)) as { approval: Approval };
        submittedApproval = body.approval;
        sendJson(response, { version: "1", type: "CoordinationApprovalSubmissionResponse", accepted: true });
        return;
      }
      response.statusCode = 404;
      response.end();
    });

    try {
      const server = new SignerServer({
        signerKey: join(testKeysDir, "maintainer-a.json"),
        coordinationUrl: coordination.url,
      });
      const result = await server.handleToolCall("mpas_reject", {
        actionId: reviewSet.actionEnvelope.actionId.value,
      });

      expect(result.isError).toBeUndefined();
      expect(submittedApproval?.decision).toBe("reject");
      expect(result.structuredContent).toMatchObject({
        approval: { decision: "reject" },
      });
    } finally {
      await coordination.close();
    }
  });

  it("returns APPROVAL_REQUEST_NOT_FOUND for unknown action ids", async () => {
    const pollResponse = await readJson<CoordinationPollResponse>(
      join(fixturesDir, "responses", "coordination-pending-actions.json"),
    );
    const coordination = await startMockCoordination((_request, response) => {
      sendJson(response, pollResponse);
    });

    try {
      const server = new SignerServer({
        signerKey: join(testKeysDir, "maintainer-a.json"),
        coordinationUrl: coordination.url,
      });
      const result = await server.handleToolCall("mpas_approve", {
        actionId: "missing-action-id",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("APPROVAL_REQUEST_NOT_FOUND"),
      });
    } finally {
      await coordination.close();
    }
  });

  it("returns UNKNOWN_TOOL for unrecognized tools", async () => {
    const server = new SignerServer({
      signerKey: join(testKeysDir, "maintainer-a.json"),
      coordinationUrl: "http://127.0.0.1:1",
    });
    const result = await server.handleToolCall("mpas_not_a_tool", {});

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("UNKNOWN_TOOL"),
    });
  });

  it("throws when required actionId is missing", async () => {
    const server = new SignerServer({
      signerKey: join(testKeysDir, "maintainer-a.json"),
      coordinationUrl: "http://127.0.0.1:1",
    });

    await expect(server.handleToolCall("mpas_review_action", {})).rejects.toThrow(/Missing required argument: actionId/);
  });

  it("rejects a configured signerDid that does not match the key", async () => {
    const server = new SignerServer({
      signerKey: join(testKeysDir, "maintainer-a.json"),
      coordinationUrl: "http://127.0.0.1:1",
      signerDid: "did:jwk:not-the-key",
    });

    await expect(server.handleToolCall("mpas_list_pending", {})).rejects.toThrow(/does not match derived DID/);
  });

  it("buildMcpServer registers list and call handlers", async () => {
    const server = new SignerServer({
      signerKey: join(testKeysDir, "maintainer-a.json"),
      coordinationUrl: "http://127.0.0.1:1",
    });
    const mcp = server.buildMcpServer();
    expect(mcp).toBeDefined();
  });

  it("buildMcpServer handlers list tools and coerce non-object CallTool arguments", async () => {
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    const pollResponse = await readJson<CoordinationPollResponse>(
      join(fixturesDir, "responses", "coordination-pending-actions.json"),
    );
    const coordination = await startMockCoordination((_request, response) => {
      sendJson(response, pollResponse);
    });

    const handlers: Array<(request?: unknown) => unknown> = [];
    const setSpy = vi.spyOn(Server.prototype, "setRequestHandler").mockImplementation(function (_schema, handler) {
      handlers.push(handler as (request?: unknown) => unknown);
      return undefined as never;
    });

    try {
      const server = new SignerServer({
        signerKey: join(testKeysDir, "maintainer-a.json"),
        coordinationUrl: coordination.url,
      });
      handlers.length = 0;
      server.buildMcpServer();
      expect(handlers.length).toBeGreaterThanOrEqual(2);
      const listHandler = handlers[handlers.length - 2]!;
      const callHandler = handlers[handlers.length - 1]!;

      const listed = await listHandler();
      expect(listed).toMatchObject({
        tools: expect.arrayContaining([expect.objectContaining({ name: "mpas_list_pending" })]),
      });

      for (const args of [null, [], "string-args"]) {
        const result = await callHandler({
          params: { name: "mpas_list_pending", arguments: args },
        });
        expect(result).toMatchObject({
          structuredContent: { approvalRequests: pollResponse.approvalRequests },
        });
      }
    } finally {
      setSpy.mockRestore();
      await coordination.close();
    }
  });

  it("runSignerServer accepts legacy maintainerKey and coordinationUrl config keys", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "mpas-signer-legacy-"));
    const configPath = join(dir, "signer.json");
    await writeFile(
      configPath,
      JSON.stringify({
        maintainerKey: join(testKeysDir, "maintainer-a.json"),
        coordinationUrl: "http://127.0.0.1:1",
      }),
    );

    const connect = vi.fn(async () => undefined);
    const buildSpy = vi.spyOn(SignerServer.prototype, "buildMcpServer").mockReturnValue({
      connect,
    } as never);

    try {
      const { runSignerServer } = await import("../../src/signer-server/index.js");
      await expect(runSignerServer(["--config", configPath])).resolves.toBeUndefined();
      expect(connect).toHaveBeenCalledTimes(1);
    } finally {
      buildSpy.mockRestore();
    }
  });

  it("returns APPROVAL_REQUEST_NOT_FOUND from mpas_review_action", async () => {
    const pollResponse = await readJson<CoordinationPollResponse>(
      join(fixturesDir, "responses", "coordination-pending-actions.json"),
    );
    const coordination = await startMockCoordination((_request, response) => {
      sendJson(response, pollResponse);
    });

    try {
      const server = new SignerServer({
        signerKey: join(testKeysDir, "maintainer-a.json"),
        coordinationUrl: coordination.url,
      });
      const result = await server.handleToolCall("mpas_review_action", {
        actionId: "missing-action-id",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining("APPROVAL_REQUEST_NOT_FOUND"),
      });
    } finally {
      await coordination.close();
    }
  });

  it("rejects approve when the review set fails integrity checks", async () => {
    const pollResponse = await readJson<CoordinationPollResponse>(
      join(fixturesDir, "responses", "coordination-pending-actions.json"),
    );
    const reviewSet = pollResponse.approvalRequests[0].signerReviewSet;
    const originalPayload = reviewSet.executionPayload as Record<string, unknown>;
    const tamperedPollResponse: CoordinationPollResponse = {
      ...pollResponse,
      approvalRequests: [
        {
          ...pollResponse.approvalRequests[0],
          signerReviewSet: {
            ...reviewSet,
            executionPayload: {
              ...originalPayload,
              arguments: {
                ...(originalPayload.arguments as Record<string, unknown>),
                title: "Tampered for approve",
              },
            },
          },
        },
      ],
    };
    const coordination = await startMockCoordination((_request, response) => {
      sendJson(response, tamperedPollResponse);
    });

    try {
      const server = new SignerServer({
        signerKey: join(testKeysDir, "maintainer-a.json"),
        coordinationUrl: coordination.url,
      });
      const result = await server.handleToolCall("mpas_approve", {
        actionId: reviewSet.actionEnvelope.actionId.value,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining("REVIEW_SET_INTEGRITY_ERROR"),
      });
    } finally {
      await coordination.close();
    }
  });

  it("accepts a JWK object as signerKey", async () => {
    const key = await readJson<{ privateJwk: Record<string, unknown> }>(join(testKeysDir, "maintainer-a.json"));
    const pollResponse = await readJson<CoordinationPollResponse>(
      join(fixturesDir, "responses", "coordination-pending-actions.json"),
    );
    const coordination = await startMockCoordination((_request, response) => {
      sendJson(response, pollResponse);
    });

    try {
      const server = new SignerServer({
        signerKey: key.privateJwk as never,
        coordinationUrl: coordination.url,
      });
      const result = await server.handleToolCall("mpas_list_pending", {});
      expect(result.structuredContent).toEqual({ approvalRequests: pollResponse.approvalRequests });
    } finally {
      await coordination.close();
    }
  });

  it("runSignerServer connects with a mocked MCP server", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "mpas-signer-cfg-"));
    const configPath = join(dir, "signer.json");
    await writeFile(
      configPath,
      JSON.stringify({
        agent: { keyFile: join(testKeysDir, "maintainer-a.json") },
        coordination: { url: "http://127.0.0.1:1" },
      }),
    );

    const connect = vi.fn(async () => undefined);
    const buildSpy = vi.spyOn(SignerServer.prototype, "buildMcpServer").mockReturnValue({
      connect,
    } as never);

    try {
      const { runSignerServer } = await import("../../src/signer-server/index.js");
      await expect(runSignerServer(["--config", configPath])).resolves.toBeUndefined();
      expect(connect).toHaveBeenCalledTimes(1);
    } finally {
      buildSpy.mockRestore();
    }
  });

  it("runSignerServer prints usage when --config is missing", async () => {
    const { runSignerServer } = await import("../../src/signer-server/index.js");
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    const chunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;

    try {
      await runSignerServer([]);
      expect(chunks.join("")).toContain("Usage: mpas signer-server --config");
      expect(process.exitCode).toBe(1);
    } finally {
      process.stderr.write = originalWrite;
      process.exitCode = previousExitCode;
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
