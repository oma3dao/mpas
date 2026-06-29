import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
let bridgeDir = process.env.MPAS_MCP_BRIDGE_DIR ?? resolve(process.cwd(), "..", "oma3", "mpas-sdk", "packages", "mcp-bridge");

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--mcp-bridge-dir") {
    bridgeDir = resolve(args[++index]);
  }
}

if (!existsSync(resolve(bridgeDir, "package.json"))) {
  console.error(`MCP bridge package not found: ${bridgeDir}`);
  console.error("Pass --mcp-bridge-dir <path> or set MPAS_MCP_BRIDGE_DIR.");
  process.exit(1);
}

await run("npm", ["run", "build"], bridgeDir);
await run("npx", ["vitest", "run", "tests/e2e/mcp-bridge-stack.test.ts"], process.cwd(), {
  MPAS_MCP_BRIDGE_DIR: bridgeDir,
});

function run(command, commandArgs, cwd, extraEnv = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, commandArgs, {
      cwd,
      env: {
        ...process.env,
        ...extraEnv,
      },
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`${command} ${commandArgs.join(" ")} exited via ${signal}`));
        return;
      }
      if (code !== 0) {
        rejectPromise(new Error(`${command} ${commandArgs.join(" ")} exited with code ${code}`));
        return;
      }
      resolvePromise();
    });
  });
}
