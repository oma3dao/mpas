import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.js";

const mockServer = fileURLToPath(new URL("./fixtures/mock-mcp-server.mjs", import.meta.url));

describe("low-level bridge generation", () => {
  it("writes a sibling tools.json next to the generated runtime", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "bridge-gen-low-level-"));
    const bridgePath = join(outDir, "bridge.ts");

    await run([
      "--output-bridge",
      bridgePath,
      "--",
      "node",
      mockServer,
    ]);

    const source = await readFile(bridgePath, "utf8");
    const tools = JSON.parse(await readFile(join(outDir, "tools.json"), "utf8")) as Array<{ name: string }>;
    expect(source).toContain('new URL("./tools.json", import.meta.url)');
    expect(source).not.toContain('"name": "create_issue"');
    expect(tools.map((tool) => tool.name)).toEqual(["create_issue", "delete_branch", "merge_pull_request"]);
  });
});
