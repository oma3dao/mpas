import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { computeArtifactDid } from "../../src/adapter/config-loader.js";
import { generateMpasKey } from "../../src/core/did-jwk.js";
import { runCli } from "../../src/cli/index.js";
import type { InstallerDependencies } from "../../src/cli/installer/deps.js";

export const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
export const installerFixtures = fileURLToPath(new URL("../fixtures/installer/", import.meta.url));

class MemoryWriter {
  text = "";

  write(chunk: string | Uint8Array): boolean {
    this.text += chunk.toString();
    return true;
  }
}

export interface ScriptedPrompt {
  asked: string[];
  prompt: (question: string) => Promise<string>;
}

/** Answers prompts in order and records each question. Fails on an unexpected prompt. */
export function scriptedPrompt(answers: string[]): ScriptedPrompt {
  const queue = [...answers];
  const asked: string[] = [];
  return {
    asked,
    prompt: async (question: string) => {
      asked.push(question);
      const answer = queue.shift();
      if (answer === undefined) throw new Error(`Unexpected prompt: ${question}`);
      return answer;
    },
  };
}

export interface CommandRecord {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export async function tempDir(prefix = "mpas-installer-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export function testDeps(overrides: Partial<InstallerDependencies> = {}): InstallerDependencies & { commands: CommandRecord[] } {
  const commands: CommandRecord[] = [];
  return {
    commands,
    isTerminal: false,
    prompt: async (question: string) => {
      throw new Error(`Unexpected prompt without a terminal: ${question}`);
    },
    env: {},
    homedir: join(tmpdir(), "mpas-installer-no-home"),
    now: () => new Date("2026-10-09T12:00:00.000Z"),
    platform: "darwin",
    execPath: "/opt/node/bin/node",
    mpasScriptPath: "/opt/node/lib/node_modules/@oma3/mpas-cli/dist/cli/index.js",
    npxScriptPath: "/opt/node/lib/node_modules/npm/bin/npx-cli.js",
    startedViaNpx: false,
    packageVersion: "0.1.0-alpha.1",
    registryDir: join(installerFixtures, "registry"),
    skillsDir: join(repoRoot, "integrations", "skills"),
    fetchBytes: fixtureFetch,
    npmVersionExists: async () => true,
    pid: process.pid,
    isProcessAlive: () => false,
    runCommand: async (command: string, args: string[], options: { env?: Record<string, string> } = {}) => {
      commands.push({ command, args, env: options.env });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    ...overrides,
  };
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function run(args: string[], deps: InstallerDependencies): Promise<RunResult> {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const result = await runCli(args, { stdout, stderr }, { installer: deps });
  return { exitCode: result.exitCode, stdout: stdout.text, stderr: stderr.text };
}

/** Every file under a directory with its bytes and mode, for "nothing changed" assertions. */
export async function snapshot(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    const stat = await lstat(path);
    const key = relative(dir, path);
    result[key] = entry.isFile()
      ? `${(stat.mode & 0o777).toString(8)}:${(await readFile(path)).toString("base64")}`
      : `${(stat.mode & 0o777).toString(8)}:dir`;
  }
  return result;
}

export async function mode(path: string): Promise<number> {
  return (await lstat(path)).mode & 0o777;
}

export async function readJson<T = Record<string, unknown>>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export const fixtureApplicationDid = "did:web:github-mirror.example";
export const fixtureArtifactDid = "did:artifact:bafkreiboiym5t7serxxvynew6qzrjjo65lqiqv6jnjunkwmyp3hrvgh7qq";
/** The content-addressed name `mpas mcp add` gives the fixture plugin. */
export const fixturePluginFile = `mirror-plugin-${fixtureArtifactDid.replace("did:artifact:", "")}.json`;
export const fixtureTemplatePath = join(installerFixtures, "downloads", "mirror", "adapter-config.example.json");
export const fixturePluginPath = join(installerFixtures, "downloads", "mirror", "plugin.json");

export async function newDid(suite: "Ed25519" | "P-256" = "Ed25519"): Promise<string> {
  return (await generateMpasKey(suite)).did;
}

/** A key file whose DID and public key come from one key and whose private key comes from another. */
export async function writeMixedKey(path: string): Promise<{ did: string; foreignPrivateD: string }> {
  const owner = await generateMpasKey("Ed25519");
  const other = await generateMpasKey("Ed25519");
  await writeFile(path, `${JSON.stringify({ did: owner.did, kid: owner.kid, privateJwk: other.privateJwk, publicJwk: owner.publicJwk }, null, 2)}\n`, { mode: 0o600 });
  return { did: owner.did, foreignPrivateD: String((other.privateJwk as { d: string }).d) };
}

/** Splits a printed command the way /bin/sh would, after joining backslash-continued lines. */
export function shellWords(command: string): string[] {
  const result = spawnSync("/bin/sh", ["-c", `for a in ${command.replace(/\\\n\s*/g, " ")}; do printf '%s\\0' "$a"; done`], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.split("\0").slice(0, -1);
}

/** Returns the printed command that starts with `start`, joining its continuation lines. */
export function printedCommand(output: string, start: string): string {
  const lines = output.split("\n");
  const first = lines.findIndex((line) => line.trimStart().startsWith(start));
  if (first < 0) throw new Error(`No printed command starts with ${start}`);
  const parts = [lines[first].trimStart()];
  for (let index = first; lines[index].endsWith("\\"); index += 1) parts.push(lines[index + 1].trim());
  return parts.join("\n");
}

/** Creates an account without a terminal and returns its home. */
export async function initAccount(role: "proposer" | "maintainer" | "verifier", extra: string[] = []): Promise<string> {
  const home = join(await tempDir(), "home");
  const args = role === "proposer"
    ? ["--coordination", "local", "--action", "local"]
    : role === "maintainer"
      ? ["--coordination", "local", "--harness", "none"]
      : ["--action", "local", "--mode", "direct"];
  const result = await run(["init", role, "--home", home, ...args, ...extra], testDeps());
  if (result.exitCode !== 0) throw new Error(`init ${role} failed: ${result.stderr}`);
  return home;
}

/** Writes the bridge config `mpas mcp add` would write for the fixture application. */
export async function writeFixtureBridge(home: string, app = "mirror"): Promise<string> {
  const account = await readJson<{ did: string; coordinationUrl: string; actionUrl: string; verifierDid?: string }>(join(home, "account.json"));
  await mkdir(join(home, "plugins"), { recursive: true });
  await copyFile(fixturePluginPath, join(home, "plugins", `${app}-plugin.json`));
  const path = join(home, "mcp-server-configs", `${app}-mcp-bridge-config.json`);
  await writeFile(path, `${JSON.stringify({
    mode: "proposer",
    plugin: join(home, "plugins", `${app}-plugin.json`),
    agent: { did: account.did, keyFile: join(home, "keys", "signing-key.json") },
    target: { applicationDid: fixtureApplicationDid },
    coordination: { url: account.coordinationUrl },
    actionEndpoint: { url: account.actionUrl, verifierDid: account.verifierDid ?? "did:web:verifier.example.test" },
    workflow: { dbPath: join(home, "workflows", `${app}.db`) },
  }, null, 2)}\n`);
  return path;
}

/** Writes a Verifier deployment config from the fixture template, as a draft or as a live config. */
export async function writeFixtureConfig(
  home: string,
  where: "draft" | "live",
  modify: (config: Record<string, any>) => void = () => {},
  app = "mirror",
): Promise<string> {
  await mkdir(join(home, "plugins"), { recursive: true });
  await copyFile(fixturePluginPath, join(home, "plugins", `${app}-plugin.json`));
  const config = await readJson<Record<string, any>>(fixtureTemplatePath);
  config.plugin.path = join(home, "plugins", `${app}-plugin.json`);
  modify(config);
  const dir = where === "draft" ? join(home, "config", "drafts") : join(home, "config");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${app}-adapter-config.json`);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

/** Serves the static fixture downloads under https://fixtures.example.test/. */
export async function fixtureFetch(url: string): Promise<Uint8Array> {
  const prefix = "https://fixtures.example.test/";
  if (!url.startsWith(prefix)) throw new Error(`Unexpected download: ${url}`);
  return new Uint8Array(await readFile(join(installerFixtures, "downloads", url.slice(prefix.length))));
}

export function sha256Digest(bytes: Uint8Array): { alg: "sha-256"; value: string } {
  return { alg: "sha-256", value: createHash("sha256").update(bytes).digest("base64url") };
}

export interface FixtureApp {
  /** Registry name, for example `mirror-fixtureorg`. */
  name: string;
  applicationDid?: string;
  manifest?: (manifest: Record<string, any>) => void;
  template?: (template: Record<string, any>) => void;
  withoutTemplate?: boolean;
  pluginBytes?: Uint8Array;
  /** The registry's artifactDid. Defaults to the one computed from the plugin bytes. */
  registryArtifactDid?: string;
}

/** Builds a registry and its downloads in a temporary folder, with digests computed over the final bytes. */
export async function buildRegistry(apps: FixtureApp[]): Promise<{ registryDir: string; fetchBytes: (url: string) => Promise<Uint8Array> }> {
  const registryDir = await tempDir("mpas-registry-");
  const downloads = new Map<string, Uint8Array>();
  const baseEntry = await readJson<Record<string, any>>(join(installerFixtures, "registry", "mirror-fixtureorg.json"));
  for (const app of apps) {
    const applicationDid = app.applicationDid ?? fixtureApplicationDid;
    const base = `https://fixtures.example.test/${app.name}/`;
    const pluginBytes = app.pluginBytes ?? new Uint8Array(await readFile(fixturePluginPath));
    downloads.set(`${base}plugin.json`, pluginBytes);
    const artifactDid = await computeArtifactDid(JSON.parse(new TextDecoder().decode(pluginBytes)));
    const template = await readJson<Record<string, any>>(fixtureTemplatePath);
    template.target.applicationDid = applicationDid;
    template.policy.applicationDid = applicationDid;
    template.plugin.artifactDid = artifactDid;
    app.template?.(template);
    const templateBytes = new TextEncoder().encode(`${JSON.stringify(template, null, 2)}\n`);
    downloads.set(`${base}adapter-config.example.json`, templateBytes);
    const manifest: Record<string, any> = {
      version: "1",
      type: "MpasInstallManifest",
      applicationDid,
      bridge: { package: `@fixture/mpas-bridge-${app.name}`, version: "1.2.3" },
      plugin: { url: `${base}plugin.json` },
      adapterConfigTemplate: { url: `${base}adapter-config.example.json`, digest: sha256Digest(templateBytes) },
      readme: `${base}README.md`,
    };
    if (app.withoutTemplate) delete manifest.adapterConfigTemplate;
    app.manifest?.(manifest);
    const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
    downloads.set(`${base}install.json`, manifestBytes);
    const entry = structuredClone(baseEntry);
    entry.application.applicationDid = applicationDid;
    entry.publisher.githubOrg = app.name.split("-").pop();
    entry.plugin.artifactDid = app.registryArtifactDid ?? artifactDid;
    entry.install = { manifestUrl: `${base}install.json`, manifestDigest: sha256Digest(manifestBytes) };
    await writeFile(join(registryDir, `${app.name}.json`), `${JSON.stringify(entry, null, 2)}\n`);
  }
  return {
    registryDir,
    fetchBytes: async (url: string) => {
      const bytes = downloads.get(url);
      if (!bytes) throw new Error(`Unexpected download: ${url}`);
      return bytes;
    },
  };
}

export async function writeCredential(home: string, handle = "github-mirror-token"): Promise<void> {
  await mkdir(join(home, "credentials"), { recursive: true });
  await writeFile(join(home, "credentials", `${handle}.json`), `${JSON.stringify({ value: "test-token" })}\n`, { mode: 0o600 });
}
