import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { bundledAssets } from "./assets.js";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Everything the installer reads from its environment, injectable for tests. */
export interface InstallerDependencies {
  /** True when both stdin and stdout are a terminal. */
  isTerminal: boolean;
  /** Asks one question on the terminal and returns the raw answer. */
  prompt: (question: string) => Promise<string>;
  env: Record<string, string | undefined>;
  homedir: string;
  now: () => Date;
  platform: NodeJS.Platform;
  /** Absolute path of the Node executable running the installer. */
  execPath: string;
  /** Absolute path of the `mpas` script (`dist/cli/index.js`). */
  mpasScriptPath: string;
  /** Absolute path of npm's `npx` script, or "" when it cannot be found. */
  npxScriptPath: string;
  /** True when this `mpas` was started from the transient `npx` cache. */
  startedViaNpx: boolean;
  /** Version of the running `@oma3/mpas-cli` package. */
  packageVersion: string;
  registryDir: string;
  skillsDir: string;
  fetchBytes: (url: string) => Promise<Uint8Array>;
  npmVersionExists: (packageName: string, version: string) => Promise<boolean>;
  /** This process's id, recorded in the home's lock file. */
  pid: number;
  /** Whether a process that holds a lock is still running. */
  isProcessAlive: (pid: number) => boolean;
  runCommand: (command: string, args: string[], options?: { env?: Record<string, string> }) => Promise<CommandResult>;
  /** Test hook: called before each step of a multi-file update so a failure can be injected there. */
  failpoint?: (step: "stage" | "backup" | "marker" | "commit", path: string) => void;
}

function findNpxScript(execPath: string, env: Record<string, string | undefined>): string {
  const nodeDir = dirname(execPath);
  const candidates = [
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
    join(nodeDir, "node_modules", "npm", "bin", "npx-cli.js"),
    ...(env.npm_execpath ? [join(dirname(env.npm_execpath), "npx-cli.js")] : []),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? "";
}

export function defaultInstallerDependencies(): InstallerDependencies {
  const assets = bundledAssets();
  const mpasScriptPath = fileURLToPath(new URL("../index.js", import.meta.url));
  const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8")) as { version: string };
  return {
    isTerminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    prompt: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    env: process.env,
    homedir: homedir(),
    now: () => new Date(),
    platform: process.platform,
    execPath: process.execPath,
    mpasScriptPath,
    npxScriptPath: findNpxScript(process.execPath, process.env),
    startedViaNpx: mpasScriptPath.split(/[\\/]/).includes("_npx"),
    packageVersion: packageJson.version,
    registryDir: assets.registryDir,
    skillsDir: assets.skillsDir,
    fetchBytes: async (url) => {
      if (!url.startsWith("https://")) throw new Error(`Refusing to download over a non-https URL: ${url}`);
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    npmVersionExists: async (packageName, version) => {
      const url = `https://registry.npmjs.org/${packageName.replace("/", "%2f")}/${encodeURIComponent(version)}`;
      const response = await fetch(url, { headers: { accept: "application/json" } });
      if (response.status === 404) return false;
      if (!response.ok) throw new Error(`npm registry lookup failed (${response.status}) for ${packageName}@${version}`);
      return true;
    },
    pid: process.pid,
    isProcessAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    runCommand: (command, args, options = {}) =>
      new Promise((resolve, reject) => {
        const child = spawn(command, args, { env: { ...process.env, ...options.env }, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        child.on("error", reject);
        child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
      }),
  };
}
