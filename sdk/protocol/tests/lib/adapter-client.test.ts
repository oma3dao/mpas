import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AdapterClient, AdapterUnavailableError, type ActionPackage, type AdapterResponse } from "../../src/index.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("AdapterClient", () => {
  it("submits Action Packages and parses ActionResponse results", async () => {
    const actionPackage = await readJson<ActionPackage>(
      join(fixturesDir, "action-packages", "valid-create-issue-package.json"),
    );
    const fixtureFiles = [
      "adapter-response-executed.json",
      "adapter-response-needs-approvals.json",
      "adapter-response-rejected.json",
      "adapter-response-malformed.json",
    ];

    for (const file of fixtureFiles) {
      const expected = await readJson<AdapterResponse>(join(fixturesDir, "responses", file));
      const server = await startMockAdapter(async (request, response) => {
        expect(request.method).toBe("POST");
        expect(request.url).toBe("/mpas/v1/action");
        await readRequestBody(request);
        sendJson(response, expected, 200);
      });

      try {
        const client = new AdapterClient({ url: server.url });
        await expect(client.submit(actionPackage)).resolves.toEqual(expected);
      } finally {
        await server.close();
      }
    }
  });

  it("throws AdapterRequestError on a 400 MpasHttpError", async () => {
    const actionPackage = await readJson<ActionPackage>(
      join(fixturesDir, "action-packages", "valid-create-issue-package.json"),
    );
    const httpError = await readJson<unknown>(join(fixturesDir, "responses", "adapter-http-error.json"));
    const server = await startMockAdapter((_request, response) => {
      sendJson(response, httpError, 400);
    });

    try {
      const client = new AdapterClient({ url: server.url });
      await expect(client.submit(actionPackage)).rejects.toMatchObject({
        name: "AdapterRequestError",
        code: "artifact_malformed",
        status: 400,
      });
    } finally {
      await server.close();
    }
  });

  it("checks adapter health", async () => {
    const server = await startMockAdapter((request, response) => {
      expect(request.method).toBe("GET");
      expect(request.url).toBe("/mpas/v1/health");
      sendJson(response, { status: "ok" });
    });

    try {
      const client = new AdapterClient({ url: server.url });
      await expect(client.healthCheck()).resolves.toEqual({ status: "ok" });
    } finally {
      await server.close();
    }
  });

  it("wraps network errors as AdapterUnavailable errors", async () => {
    const server = await startMockAdapter((_request, response) => {
      sendJson(response, { status: "ok" });
    });
    const url = server.url;
    await server.close();

    const client = new AdapterClient({ url, timeoutMs: 100 });
    await expect(client.healthCheck()).rejects.toBeInstanceOf(AdapterUnavailableError);
  });

  it("maps non-MpasHttpError HTTP failures to server_error", async () => {
    const actionPackage = await readJson<ActionPackage>(
      join(fixturesDir, "action-packages", "valid-create-issue-package.json"),
    );
    const server = await startMockAdapter((_request, response) => {
      response.statusCode = 503;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ error: "busy" }));
    });

    try {
      const client = new AdapterClient({ url: `${server.url}/` });
      await expect(client.submit(actionPackage)).rejects.toMatchObject({
        name: "AdapterRequestError",
        code: "server_error",
        status: 503,
      });
    } finally {
      await server.close();
    }
  });

  it("rejects non-JSON success bodies", async () => {
    const actionPackage = await readJson<ActionPackage>(
      join(fixturesDir, "action-packages", "valid-create-issue-package.json"),
    );
    const server = await startMockAdapter((_request, response) => {
      response.statusCode = 200;
      response.end("not-json");
    });

    try {
      const client = new AdapterClient({ url: server.url });
      await expect(client.submit(actionPackage)).rejects.toMatchObject({
        name: "AdapterResponseInvalid",
      });
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
