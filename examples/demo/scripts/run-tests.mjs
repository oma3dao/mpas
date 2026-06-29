import { spawn } from "node:child_process";

const passthroughArgs = process.argv.slice(2);
const vitestArgs = ["run", "--passWithNoTests"];

for (let index = 0; index < passthroughArgs.length; index += 1) {
  const arg = passthroughArgs[index];
  if (arg === "--grep") {
    const pattern = passthroughArgs[index + 1];
    index += 1;
    if (pattern?.startsWith("core/")) {
      vitestArgs.push("tests/core");
    } else if (pattern === "adapter" || pattern?.startsWith("adapter/")) {
      vitestArgs.push("tests/adapter");
    } else if (pattern === "cli" || pattern?.startsWith("cli/")) {
      vitestArgs.push("tests/cli");
    } else if (pattern) {
      vitestArgs.push("--testNamePattern", pattern);
    }
    continue;
  }

  vitestArgs.push(arg);
}

const child = spawn("vitest", vitestArgs, {
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
