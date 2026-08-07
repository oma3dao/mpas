import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CoordinationClient,
  CoordinationResponseError,
  CoordinationUnavailableError,
  KeyManager,
  MpasAuthError,
  verifyMpasRfc9421,
  type ActionPackage,
  type AdapterResponse,
  type Approval,
  type AuthorizationRequirements,
  type CoordinationPollResponse,
} from "../../src/index.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("CoordinationClient", () => {
  it("calls all coordination endpoints and parses fixture responses", async () => {
    const actionPackage = await readJson<ActionPackage>(
      join(fixturesDir, "action-packages", "valid-create-issue-package.json"),
    );
    const needsApprovals = await readJson<AdapterResponse>(
      join(fixturesDir, "responses", "adapter-response-needs-approvals.json"),
    );
    const pollResponse = await readJson<CoordinationPollResponse>(
      join(fixturesDir, "responses", "coordination-pending-actions.json"),
    );
    const approval = actionPackage.approvalBundle.approvals[0] as Approval;
    const authorizationRequirements = needsApprovals.authorizationRequirements!;
    const requests: Array<{ url?: string; body: unknown }> = [];
    const server = await startMockCoordination(async (request, response) => {
      const body = await readRequestBody(request);
      requests.push({ url: request.url, body: body ? JSON.parse(body) : undefined });

      if (request.url === "/mpas/v1/coordination/action") {
        sendJson(response, {
          version: "1",
          type: "CoordinationActionResponse",
          actionRef: pollResponse.approvalRequests[0].actionRef,
          state: "awaitingApprovals",
          createdAt: "2026-06-05T18:20:00.000Z",
        });
        return;
      }
      if (request.url === "/mpas/v1/coordination/approval") {
        sendJson(response, {
          version: "1",
          type: "CoordinationApprovalSubmissionResponse",
          accepted: true,
          actionRef: pollResponse.approvalRequests[0].actionRef,
          state: "awaitingApprovals",
          createdAt: "2026-06-05T18:20:00.000Z",
        });
        return;
      }
      if (request.url === "/mpas/v1/coordination/poll") {
        sendJson(response, pollResponse);
        return;
      }
      if (request.url === "/mpas/v1/coordination/action-cancel") {
        sendJson(response, {
          version: "1",
          type: "CoordinationActionCancelResponse",
          actionRef: pollResponse.approvalRequests[0].actionRef,
          state: "cancelled",
          cancelledAt: "2026-06-05T18:20:00.000Z",
        });
        return;
      }

      response.statusCode = 404;
      response.end();
    });

    try {
      const client = new CoordinationClient({ url: server.url });

      await expect(client.submitAction(actionPackage, authorizationRequirements)).resolves.toMatchObject({
        actionRef: pollResponse.approvalRequests[0].actionRef,
      });
      await expect(client.poll("did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6IjhzRFY3NmI4aUY3NlBJbUF3NUk5V3ZlanNfOGJTOE4xMld2SHpQYTVWdzgifQ")).resolves.toEqual(
        pollResponse,
      );
      await expect(client.submitApproval(actionPackage.approvalBundle.actionEnvelopeHash, approval)).resolves.toMatchObject({
        accepted: true,
      });
      await expect(
        client.cancelAction(
          actionPackage.actionEnvelope.actionId,
          "did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Ims2TzdjaVFrbXBodUVFdDFpM3lBaW1KSldlR0ttT3EzdF9mc05renphNm8ifQ",
        ),
      ).resolves.toMatchObject({ state: "cancelled" });

      expect(requests.map((request) => request.url)).toEqual([
        "/mpas/v1/coordination/action",
        "/mpas/v1/coordination/poll",
        "/mpas/v1/coordination/approval",
        "/mpas/v1/coordination/action-cancel",
      ]);
      expect(
        requests.every(
          (request) =>
            typeof request.body === "object" &&
            request.body !== null &&
            !("audience" in request.body),
        ),
      ).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("signs all coordination endpoints with the configured or lazy signer", async () => {
    const actionPackage = await readJson<ActionPackage>(
      join(fixturesDir, "action-packages", "valid-create-issue-package.json"),
    );
    const needsApprovals = await readJson<AdapterResponse>(
      join(fixturesDir, "responses", "adapter-response-needs-approvals.json"),
    );
    const pollResponse = await readJson<CoordinationPollResponse>(
      join(fixturesDir, "responses", "coordination-pending-actions.json"),
    );
    const approval = actionPackage.approvalBundle.approvals[0] as Approval;
    const signer = await KeyManager.fromFile(join(fixturesDir, "keys", "proposer.json"));
    const verifications: Array<Awaited<ReturnType<typeof verifyMpasRfc9421>>> = [];
    const audiences: unknown[] = [];
    const requestPaths: string[] = [];
    const prefix = "/tenant/acme";
    let expectedAudience = "";
    const server = await startMockCoordination(async (request, response) => {
      const body = Buffer.from(await readRequestBody(request));
      const parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      audiences.push(parsed.audience);
      requestPaths.push(request.url ?? "");
      verifications.push(
        await verifyMpasRfc9421({
          method: request.method ?? "",
          path: request.url ?? "",
          headers: request.headers,
          body,
          audiences: [expectedAudience],
        }),
      );

      const endpointPath = request.url?.slice(prefix.length);
      if (endpointPath === "/mpas/v1/coordination/action") {
        sendJson(response, {
          version: "1",
          type: "CoordinationActionResponse",
          actionRef: pollResponse.approvalRequests[0].actionRef,
          state: "awaitingApprovals",
        });
      } else if (endpointPath === "/mpas/v1/coordination/poll") {
        sendJson(response, pollResponse);
      } else if (endpointPath === "/mpas/v1/coordination/approval") {
        sendJson(response, { version: "1", type: "CoordinationApprovalSubmissionResponse", accepted: true });
      } else if (endpointPath === "/mpas/v1/coordination/action-cancel") {
        sendJson(response, {
          version: "1",
          type: "CoordinationActionCancelResponse",
          actionRef: pollResponse.approvalRequests[0].actionRef,
          state: "cancelled",
          cancelledAt: "2026-06-05T18:20:00.000Z",
        });
      }
    });

    try {
      expectedAudience = server.url;
      const client = new CoordinationClient({ url: `${server.url}${prefix}/`, signer: Promise.resolve(signer) });
      await client.submitAction(actionPackage, needsApprovals.authorizationRequirements!);
      await client.poll(signer.did);
      await client.submitApproval(actionPackage.approvalBundle.actionEnvelopeHash, approval);
      await client.cancelAction(actionPackage.actionEnvelope.actionId, signer.did);

      expect(verifications).toHaveLength(4);
      expect(verifications.every((result) => result.ok && result.did === signer.did)).toBe(true);
      expect(audiences).toEqual([expectedAudience, expectedAudience, expectedAudience, expectedAudience]);
      expect(requestPaths).toEqual([
        `${prefix}/mpas/v1/coordination/action`,
        `${prefix}/mpas/v1/coordination/poll`,
        `${prefix}/mpas/v1/coordination/approval`,
        `${prefix}/mpas/v1/coordination/action-cancel`,
      ]);
    } finally {
      await server.close();
    }
  });

  it("does not send when the signer DID differs from the endpoint identity", async () => {
    const signer = await KeyManager.fromFile(join(fixturesDir, "keys", "proposer.json"));
    const client = new CoordinationClient({ url: "https://coordination.example.com", signer });

    await expect(client.poll("did:jwk:another" as `did:${string}`)).rejects.toThrow("does not match signer DID");
  });

  it("surfaces auth, request, and outage responses as distinct errors", async () => {
    for (const status of [400, 401, 403, 503]) {
      const server = await startMockCoordination((_request, response) => {
        sendJson(
          response,
          {
            version: "1",
            type: "MpasHttpError",
            error: { code: status === 401 ? "signature_invalid" : "permission_denied", message: "request denied" },
          },
          status,
        );
      });

      try {
        const client = new CoordinationClient({ url: server.url });
        const rejection = client.poll("did:jwk:test" as `did:${string}`);
        if (status === 400) {
          await expect(rejection).rejects.toBeInstanceOf(CoordinationResponseError);
        } else if (status === 503) {
          await expect(rejection).rejects.toBeInstanceOf(CoordinationUnavailableError);
        } else {
          await expect(rejection).rejects.toMatchObject({
            name: "MpasAuthError",
            status,
            authCode: status === 401 ? "signature_invalid" : "permission_denied",
          } satisfies Partial<MpasAuthError>);
        }
      } finally {
        await server.close();
      }
    }
  });

  it("wraps network errors as CoordinationUnavailable errors", async () => {
    const server = await startMockCoordination((_request, response) => {
      sendJson(response, { status: "ok" });
    });
    const url = server.url;
    await server.close();

    const client = new CoordinationClient({ url, timeoutMs: 100 });
    await expect(client.poll("did:web:agents.example:missing")).rejects.toBeInstanceOf(CoordinationUnavailableError);
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
