import { spawn } from "node:child_process";
import { detectMpasSdkSource } from "./sdk-source.mjs";

const passthroughArgs = process.argv.slice(2);
const vitestArgs = ["run", "--passWithNoTests"];
const sdkSource = detectMpasSdkSource();

console.log(sdkSource.message);

if (sdkSource.mode !== "local") {
  vitestArgs.push("--exclude", "tests/local-sdk/**");
}

for (let index = 0; index < passthroughArgs.length; index += 1) {
  const arg = passthroughArgs[index];
  if (arg === "--grep") {
    const pattern = passthroughArgs[index + 1];
    index += 1;
    if (pattern === "adapter" || pattern?.startsWith("adapter/")) {
      vitestArgs.push("tests/adapter");
    } else if (pattern === "cli" || pattern?.startsWith("cli/")) {
      vitestArgs.push("tests/cli");
    } else if (pattern === "local-sdk" || pattern?.startsWith("local-sdk/")) {
      vitestArgs.push("tests/local-sdk");
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
