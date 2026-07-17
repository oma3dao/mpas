import { resolve } from "node:path";
import { spawn } from "node:child_process";

await run("npm", ["run", "build"], resolve(process.cwd(), "..", "..", "sdk", "protocol"));
await run("npm", ["run", "build"], process.cwd());
await run("npx", ["vitest", "run", "tests/e2e/mcp-bridge-stack.test.ts"], process.cwd());

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
