import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ApprovalBuilder,
  CoordinationClient,
  KeyManager,
  verifyHash,
  type Approval,
  type CoordinationPollResponse,
} from "../../src/index.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("maintainer flow integration", () => {
  it("reviews a pending action, signs an approval, and submits it", async () => {
    const pollResponse = await readJson<CoordinationPollResponse>(
      join(fixturesDir, "responses", "coordination-pending-actions.json"),
    );
    const approvalRequest = pollResponse.approvalRequests[0];
    const reviewSet = approvalRequest.signerReviewSet;
    let submittedApproval: Approval | undefined;
    const server = await startMockCoordination(async (request, response) => {
      expect(request.method).toBe("POST");
      const body = JSON.parse(await readRequestBody(request)) as { did?: string; approval?: Approval };

      if (request.url === "/mpas/v1/coordination/poll" && body.did) {
        sendJson(response, pollResponse);
        return;
      }
      if (request.url === "/mpas/v1/coordination/approval") {
        submittedApproval = body.approval;
        response.statusCode = 204;
        response.end();
        return;
      }

      response.statusCode = 404;
      response.end();
    });

    try {
      const signerKey = await KeyManager.fromFile(join(fixturesDir, "keys", "maintainer-a.json"));
      const approvalBuilder = new ApprovalBuilder({ keyManager: signerKey });
      const client = new CoordinationClient({ url: server.url });

      const pending = await client.poll(signerKey.did);
      expect(pending).toEqual(pollResponse);

      const fetchedReviewSet = pending.approvalRequests[0].signerReviewSet;
      expect(fetchedReviewSet).toEqual(reviewSet);
      expect(verifyHash(fetchedReviewSet.executionPayload, fetchedReviewSet.actionEnvelope.executionPayloadHash)).toBe(true);

      const approval = await approvalBuilder.buildApproval(fetchedReviewSet.actionEnvelope, "approve");
      await expect(approvalBuilder.verifyApproval(approval, signerKey.publicKey)).resolves.toBe(true);
      await client.submitApproval(approvalRequest.actionRef.actionEnvelopeHash, approval);

      expect(submittedApproval).toEqual(approval);
    } finally {
      await server.close();
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
