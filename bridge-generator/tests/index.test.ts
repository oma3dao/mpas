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

describe("CLI usage errors", () => {
  it.each([
    [[], "Missing required --output-bridge"],
    [["--output-bridge", "bridge.ts"], "Missing upstream command after --."],
    [["--unknown", "x", "--", "node", "server"], "Unknown argument: --unknown"],
    [["--prompt-secret", "--", "node", "server"], "Missing value for --prompt-secret"],
  ])("rejects %j", async (argv, message) => {
    await expect(run(argv)).rejects.toThrow(message);
  });

  it("rejects a generate command missing required flags", async () => {
    await expect(run(["generate", "--app", "demo"])).rejects.toThrow("Missing required --out");
    await expect(run(["generate", "--app", "demo", "--out", "out"])).rejects.toThrow(
      "Missing upstream command after --.",
    );
  });
});
