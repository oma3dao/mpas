import { spawn } from "node:child_process";

const child = spawn("vitest", ["run", "--passWithNoTests", ...process.argv.slice(2)], {
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
