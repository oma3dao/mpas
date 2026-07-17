import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ActionPackageBuilder,
  AdapterClient,
  computeHash,
  KeyManager,
  type ActionPackage,
  type AdapterResponse,
  type MpasApplicationPlugin,
} from "../../src/index.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("proposer flow integration", () => {
  it("generates tools, builds a package, submits it, and receives an executed response", async () => {
    const plugin = await readJson<MpasApplicationPlugin>(join(fixturesDir, "plugins", "github-repo.json"));
    const executed = await readJson<AdapterResponse>(join(fixturesDir, "responses", "adapter-response-executed.json"));
    let submittedPackage: ActionPackage | undefined;
    const server = await startMockAdapter(async (request, response) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/mpas/v1/action");
      submittedPackage = (JSON.parse(await readRequestBody(request)) as { actionPackage: ActionPackage }).actionPackage;
      sendJson(response, executed);
    });

    try {
      expect(Object.keys(plugin.operations)).toContain("create_issue");

      const keyManager = await KeyManager.fromFile(join(fixturesDir, "keys", "proposer.json"));
      const builder = new ActionPackageBuilder({
        applicationDid: plugin.applicationDid,
        executionProfile: {
          id: plugin.executionProfile.id,
          format: plugin.executionProfile.format ?? "mcp.toolsCall",
        },
        keyManager,
      });
      const client = new AdapterClient({ url: server.url });
      const actionPackage = await builder.buildFromToolCall("create_issue", {
        owner: "oma3dao",
        repo: "test",
        title: "Hello",
      });
      const response = await client.submit(actionPackage);

      expect(response).toEqual(executed);
      expect(submittedPackage).toBeDefined();
      expect(submittedPackage?.executionPayload).toEqual(actionPackage.executionPayload);
      expect(submittedPackage?.actionEnvelope.executionPayloadHash).toEqual(computeHash(actionPackage.executionPayload));
      expect(submittedPackage?.approvalBundle.actionEnvelopeHash).toEqual(computeHash(actionPackage.actionEnvelope));
    } finally {
      await server.close();
    }
  });

  it("receives structured authorization requirements for additional approval flow", async () => {
    const plugin = await readJson<MpasApplicationPlugin>(join(fixturesDir, "plugins", "github-repo.json"));
    const needsApprovals = await readJson<AdapterResponse>(
      join(fixturesDir, "responses", "adapter-response-needs-approvals.json"),
    );
    const server = await startMockAdapter((_request, response) => {
      sendJson(response, needsApprovals);
    });

    try {
      const keyManager = await KeyManager.fromFile(join(fixturesDir, "keys", "proposer.json"));
      const builder = new ActionPackageBuilder({
        applicationDid: plugin.applicationDid,
        executionProfile: {
          id: plugin.executionProfile.id,
          format: plugin.executionProfile.format ?? "mcp.toolsCall",
        },
        keyManager,
      });
      const client = new AdapterClient({ url: server.url });
      const actionPackage = await builder.buildFromToolCall("merge_pull_request", {
        owner: "oma3dao",
        repo: "app-registry",
        pullNumber: 42,
        baseRef: "main",
        expectedHeadSha: "abc123def456",
        mergeMethod: "squash",
      });
      const response = await client.submit(actionPackage);

      expect(response.result).toBe("additionalApprovalsRequired");
      if (response.result === "additionalApprovalsRequired") {
        expect(response.authorizationRequirements).toMatchObject({
          version: "1",
          type: "AuthorizationRequirements",
          result: "additionalApprovalsRequired",
        });
        const authz = response.authorizationRequirements;
        if (authz?.result === "additionalApprovalsRequired") {
          expect(authz.approvalRequirements.anyOf?.[0]?.threshold).toBe(1);
        }
      }
    } finally {
      await server.close();
    }
  });
});

async function startMockAdapter(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : "mock adapter error");
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock adapter did not bind to a TCP port.");
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
