import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const vitest = fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs", import.meta.url));
const signatureSuiteConformance = fileURLToPath(
  new URL("../../../../conformance/signature-suites/verify-openssl.mjs", import.meta.url),
);

await requireSuccess(
  runNode(vitest, ["run", ...process.argv.slice(2)], "Vitest"),
);

console.log("\nRunning independent signature-suite conformance verification...");
await requireSuccess(runNode(signatureSuiteConformance, [], "signature-suite conformance verifier"));

function runNode(script, args, name) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: "inherit" });
    let settled = false;

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      console.error(`Failed to start ${name}: ${error.message}`);
      resolve({ code: 1, signal: null });
    });

    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal });
    });
  });
}

async function requireSuccess(resultPromise) {
  const { code, signal } = await resultPromise;
  if (signal !== null) {
    try {
      process.kill(process.pid, signal);
    } catch (error) {
      console.error(`Failed to propagate child signal ${signal}: ${error.message}`);
      process.exit(1);
    }
    await new Promise(() => {});
  }

  if (code !== 0) process.exit(code ?? 1);
}
