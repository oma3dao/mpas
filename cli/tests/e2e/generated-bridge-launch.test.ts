import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createBridgeFromConfig } from "../../src/bridge/github-bridge.js";
import { PLUGIN_RESOURCE_LIMITS } from "@oma3/mpas/plugin-loader";

const fixturesDir = join(process.cwd(), "tests", "fixtures");
const pluginFixture = join(fixturesDir, "plugins", "github-mirror-plugin.json");
const proposerKeyPath = join(fixturesDir, "test-keys", "proposer.json");
const toolsPath = join(process.cwd(), "bridge-tools", "github-mirror-tools.json");

interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

interface MockEndpoint {
  url: string;
  captured: CapturedRequest[];
  close(): Promise<void>;
}

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.allSettled(openServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startMockEndpoint(): Promise<MockEndpoint> {
  const captured: CapturedRequest[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      captured.push({
        method: request.method ?? "",
        path: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks),
      });
      response.writeHead(200, { "content-type": "application/mpas+json" });
      response.end(
        JSON.stringify({
          version: "1",
          type: "ActionResponse",
          result: "pending",
          actionEnvelopeHash: { alg: "sha-256", value: "A".repeat(43) },
        }),
      );
    });
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    captured,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function writeConfig(overrides: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mpas-bridge-launch-"));
  const configPath = join(dir, "bridge-config.json");
  await writeFile(configPath, JSON.stringify(overrides));
  return configPath;
}

async function baseConfig(endpoint: MockEndpoint, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    plugin: pluginFixture,
    adapter: { url: endpoint.url },
    agent: { keyFile: proposerKeyPath },
    tools: toolsPath,
    workflow: { pollIntervalMs: 100 },
    ...extra,
  };
}

async function stopQuietly(bridge: { stop?: () => void }): Promise<void> {
  bridge.stop?.();
  await new Promise((resolve) => setTimeout(resolve, 25));
}

describe("generated bridge launch controls (N35)", () => {
  it("starts with a valid plugin through the exported SDK loader", async () => {
    const endpoint = await startMockEndpoint();
    const bridge = await createBridgeFromConfig(await writeConfig(await baseConfig(endpoint)));

    expect(bridge.getToolDefinitions().length).toBeGreaterThan(0);
    await bridge.start();
    await stopQuietly(bridge);
    expect(endpoint.captured).toHaveLength(0);
  });

  it("starts with matching legacy Application and profile values", async () => {
    const endpoint = await startMockEndpoint();
    const plugin = JSON.parse(await readFile(pluginFixture, "utf8")) as {
      applicationDid: string;
      executionProfile: { id: string; format?: string };
    };
    const bridge = await createBridgeFromConfig(
      await writeConfig(
        await baseConfig(endpoint, {
          applicationDid: plugin.applicationDid,
          executionProfile: {
            id: plugin.executionProfile.id,
            format: plugin.executionProfile.format ?? "mcp.toolsCall",
          },
        }),
      ),
    );
    expect(bridge.getToolDefinitions().length).toBeGreaterThan(0);
    await stopQuietly(bridge);
  });

  it.each([
    ["applicationDid", { applicationDid: "did:web:other.example" }],
    [
      "profile id",
      { executionProfile: { id: "did:web:profiles.example:other", format: "mcp.toolsCall" } },
    ],
    [
      "profile format",
      { executionProfile: { id: "did:web:profiles.oma3.org:mcp", format: "mcp.other" } },
    ],
  ])("fails before endpoint contact on %s mismatch", async (_label, binding) => {
    const endpoint = await startMockEndpoint();
    const config = await baseConfig(endpoint);
    if ("applicationDid" in binding) {
      config.applicationDid = binding.applicationDid;
    } else {
      config.executionProfile = binding.executionProfile;
    }
    await expect(createBridgeFromConfig(await writeConfig(config))).rejects.toThrow(/does not match the plugin/);
    expect(endpoint.captured).toHaveLength(0);
  });

  it.each([
    ["invalid JSON", () => Promise.resolve("{")],
    [
      "duplicate keys",
      async () =>
        JSON.stringify(JSON.parse(await readFile(pluginFixture, "utf8"))).replace(
          '"type":"MpasApplicationPlugin"',
          '"type":"MpasApplicationPlugin","type":"MpasApplicationPlugin"',
        ),
    ],
    [
      "resource-limit (oversized document)",
      async () => {
        const plugin = JSON.parse(await readFile(pluginFixture, "utf8")) as {
          operations: Record<string, { description?: string }>;
        };
        const [firstOperation] = Object.values(plugin.operations);
        firstOperation.description = "x".repeat(PLUGIN_RESOURCE_LIMITS.maxPluginDocumentBytes);
        return JSON.stringify(plugin);
      },
    ],
  ])("fails before endpoint contact with a %s plugin", async (_label, buildDocument) => {
    const endpoint = await startMockEndpoint();
    const dir = await mkdtemp(join(tmpdir(), "mpas-bridge-hostile-"));
    const pluginPath = join(dir, "plugin.json");
    await writeFile(pluginPath, await buildDocument());
    const config = await baseConfig(endpoint);
    config.plugin = pluginPath;
    await expect(createBridgeFromConfig(await writeConfig(config))).rejects.toThrow(
      /Unable to load plugin/,
    );
    expect(endpoint.captured).toHaveLength(0);
  });

  it("contains no raw plugin cast in the checked-in generated bridge", async () => {
    const source = await readFile(join(process.cwd(), "src", "bridge", "github-bridge.ts"), "utf8");
    expect(source).not.toContain("JSON.parse(readFileSync(plugin");
    expect(source).toContain("loadPlugin as loadSdkPlugin");
  });
});
