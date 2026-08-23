#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import { chmod, copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { daemonStatus, defaultAdapterKeyPath, defaultConfigDir, defaultCredentialDir, startDaemon } from "../adapter/daemon.js";
import { loadDeploymentConfigs } from "../adapter/config-loader.js";
import { FileCredentialProvider } from "../adapter/credential-provider.js";
import { startCoordinationDaemon } from "../coordination/daemon.js";
import type { CoordinationAuthOptions } from "../coordination/coordination-api-server.js";
import { policyFromLoadedConfig } from "../adapter/adapter-api-server.js";
import { evaluatePolicy } from "../core/policy-engine.js";
import { loadPlugin, validatePayloadAgainstPlugin } from "../core/plugin-loader.js";
import { parseActionPackage, verifyActionPackage } from "../core/verification.js";
import { generateEd25519Key, didJwkToJwk, isDidJwk } from "../core/did-jwk.js";
import type { Did } from "../core/types.js";
import {
  type OAuthOperatorService,
  type ResolveOAuthDeployment,
  fileOAuthOperatorService,
  resolveOAuthApplication,
} from "../adapter/oauth-operator.js";
import {
  assertSignerTools,
  createSignerToolClient,
  decisionResultValue,
  formatSignerResult,
  pendingResultValue,
  promptReviewDecision,
  reviewResultValue,
  type ReviewDecision,
  type SignerToolClient,
} from "./signer-tools.js";

export interface CliIo {
  stdout: Pick<typeof process.stdout, "write">;
  stderr: Pick<typeof process.stderr, "write">;
}

export interface CliResult {
  exitCode: number;
}

interface ParsedOptions {
  configDir?: string;
  credentialDir?: string;
  adapterKeyPath?: string;
  journalPath?: string;
  tracePath?: string;
  keyDir?: string;
  bridgeDir?: string;
  host?: string;
  port?: number;
  coordinationPort?: number;
  coordinationAuthEnforcement?: boolean;
  coordinationAuthAudiences?: string[];
  coordinationAuthClockSkewSeconds?: number;
  coordinationAuthSignatureLifetimeSeconds?: number;
  url?: string;
  pluginDir?: string;
  value?: string;
  applicationDid?: string;
  noBrowser?: boolean;
  signerConfigPath?: string;
}

export interface CliDependencies {
  oauthOperator?: OAuthOperatorService;
  resolveOAuthDeployment?: ResolveOAuthDeployment;
  signerToolClient?: SignerToolClient;
  promptReviewDecision?: () => Promise<ReviewDecision>;
}

const defaultIo: CliIo = {
  stdout: process.stdout,
  stderr: process.stderr,
};

export async function runCli(
  args = process.argv.slice(2),
  io: CliIo = defaultIo,
  dependencies: CliDependencies = {},
): Promise<CliResult> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 2 };
  }
  const { positionals, options } = parsed;
  const [domain, command, subject] = positionals;

  try {
    if (domain === "daemon" && command === "start") {
      const daemon = await startDaemon({
        configDir: options.configDir,
        credentialDir: options.credentialDir,
        adapterKeyPath: options.adapterKeyPath,
        journalPath: options.journalPath,
        tracePath: options.tracePath,
        host: options.host,
        port: options.port,
      });
      try {
        const coordination = await startCoordinationDaemon({
          host: options.host,
          port: options.coordinationPort,
          tracePath: options.tracePath,
          auth: coordinationAuthOptions(options),
        });
        io.stdout.write(
          `${JSON.stringify({
            status: "started",
            address: daemon.address,
            coordinationAddress: coordination.address,
            loadedConfigs: daemon.loadedConfigs.length,
          })}\n`,
        );
      } catch (error) {
        await daemon.app.close();
        throw error;
      }
      return { exitCode: 0 };
    }

    if (domain === "coordination" && command === "start") {
      const daemon = await startCoordinationDaemon({
        host: options.host,
        port: options.port,
        tracePath: options.tracePath,
        auth: coordinationAuthOptions(options),
      });
      io.stdout.write(`${JSON.stringify({ status: "started", address: daemon.address })}\n`);
      return { exitCode: 0 };
    }

    if (domain === "daemon" && command === "status") {
      const status = await daemonStatus({
        configDir: options.configDir,
        host: options.host,
        port: options.port,
      });
      io.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      return { exitCode: 0 };
    }

    if (domain === "oauth" && ["login", "status", "logout"].includes(command ?? "")) {
      if (!options.applicationDid) {
        io.stderr.write("OAuth commands require --application-did <did>\n");
        return { exitCode: 2 };
      }
      const resolveDeployment = dependencies.resolveOAuthDeployment ?? resolveOAuthApplication;
      const selection = await resolveDeployment(options.configDir ?? defaultConfigDir(), options.applicationDid);
      const service = dependencies.oauthOperator ?? fileOAuthOperatorService({
        onAuthorizationUrl: (url) => { io.stderr.write(`Open this URL to authorize the Credential Adapter:\n${url}\n`); },
      });
      const request = {
        ...selection,
        refreshScope: selection.refreshScope ?? "offline_access",
      };
      const response = command === "login"
        ? await service.login({ ...request, openBrowser: options.noBrowser !== true })
        : command === "status"
          ? await service.status(request)
          : await service.logout(request);
      if (response.status === "authorized" && response.warnings?.length) {
        for (const warning of response.warnings) {
          io.stderr.write(`WARNING ${warning.code}: ${warning.message}\n`);
        }
      }
      io.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
      const failed = response.status === "oauth_operator_service_unavailable"
        || response.status === "oauth_scope_not_supported";
      return { exitCode: failed ? 1 : 0 };
    }

    if (domain === "test" && command === "submit" && subject) {
      const response = await submitAction(subject, options.url ?? "http://127.0.0.1:7544");
      io.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
      return { exitCode: 0 };
    }

    if (domain === "test" && command === "dry-run" && subject) {
      const response = await dryRunActionFile(subject, {
        configDir: options.configDir,
      });
      io.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
      return { exitCode: 0 };
    }

    if (domain === "action" && ["pending", "inspect", "review"].includes(command ?? "")) {
      if ((command === "inspect" || command === "review") && !subject) {
        io.stderr.write(`mpas action ${command} requires <action-id>\n`);
        return { exitCode: 2 };
      }
      return await runMaintainerAction(command as "pending" | "inspect" | "review", subject, options, io, dependencies);
    }

    if (domain === "plugin" && command === "install" && subject) {
      const response = await installPlugin(subject, options.pluginDir ?? defaultPluginDir());
      io.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
      return { exitCode: 0 };
    }

    if (domain === "plugin" && command === "list") {
      const response = await listPlugins(options.pluginDir ?? defaultPluginDir());
      io.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
      return { exitCode: 0 };
    }

    if (domain === "credential" && command === "set" && subject) {
      const value = options.value ?? (await readStdin());
      const response = await setCredential(subject, value.trim(), options.credentialDir ?? defaultCredentialDir());
      io.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
      return { exitCode: 0 };
    }

    if (domain === "credential" && command === "list") {
      const response = await listCredentials(options.credentialDir ?? defaultCredentialDir());
      io.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
      return { exitCode: 0 };
    }

    if (domain === "key" && command === "generate" && subject) {
      const response = await generateKeyFile(subject, options.keyDir ?? defaultKeyDir());
      io.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
      return { exitCode: 0 };
    }

    if (domain === "config" && command === "validate" && subject) {
      const response = await validateConfig(subject, {
        configDir: options.configDir,
        credentialDir: options.credentialDir,
        bridgeDir: options.bridgeDir,
      });
      io.stdout.write(formatValidationResult(response));
      return { exitCode: response.valid ? 0 : 1 };
    }

    if (domain === "trace" && command === "inspect" && subject) {
      const { inspectTrace } = await import("./trace-inspect.js");
      const output = inspectTrace(subject);
      io.stdout.write(output);
      return { exitCode: 0 };
    }

    if (domain === "signer-server" && command === "start") {
      const { runSignerServer } = await import("../signer-server/index.js");
      await runSignerServer(args.filter((a) => a !== "signer-server" && a !== "start"));
      return { exitCode: 0 };
    }

    io.stderr.write(`${usage()}\n`);
    return { exitCode: 1 };
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 1 };
  }
}

export async function dryRunActionFile(path: string, options: Pick<ParsedOptions, "configDir"> = {}) {
  const parseResult = parseActionPackage(JSON.parse(await readFile(path, "utf8")));
  if (!parseResult.ok) {
    return {
      result: "malformed",
      error: parseResult.error,
    };
  }

  const loaded = await loadDeploymentConfigs(options.configDir ?? defaultConfigDir(), {
    // Dry-run inspects policy behavior but does not ingest a plugin for execution.
    confirmPluginUse: async () => true,
  });
  if (!loaded.ok) {
    throw new Error(loaded.error.message);
  }

  const actionPackage = parseResult.actionPackage;
  const loadedConfig = loaded.configsByApplicationDid.get(actionPackage.actionEnvelope.target.applicationDid);
  if (!loadedConfig) {
    return {
      result: "rejected",
      error: {
        code: "UNKNOWN_APPLICATION",
        message: "Unknown application.",
      },
    };
  }

  const verification = await verifyActionPackage(actionPackage, {
    trustedSigners: loadedConfig.config.signerKeys,
    trustedApplicationDids: [loadedConfig.config.target.applicationDid],
  });
  if (verification.status !== "verified") {
    return {
      result: "rejected",
      error: verification,
    };
  }

  const payloadValidation = validatePayloadAgainstPlugin(actionPackage.executionPayload, loadedConfig.plugin);
  const cliOpName = (actionPackage.executionPayload as Record<string, unknown>)?.name as string | undefined;
  const inPolicies = cliOpName !== undefined && loadedConfig.config.policy.policies?.[cliOpName] !== undefined;
  const isGovernedOperation = payloadValidation.ok || payloadValidation.error.code !== "UNKNOWN_OPERATION" || inPolicies;

  if (isGovernedOperation) {
    // Governed path: validate schema and evaluate policy.
    if (!payloadValidation.ok) {
      return {
        result: "rejected",
        error: payloadValidation.error,
      };
    }

    const policyResult = evaluatePolicy(actionPackage, verification.verifiedApprovals, policyFromLoadedConfig(loadedConfig));
    if (policyResult.status === "satisfied") {
      return {
        result: "satisfied",
        operationName: payloadValidation.match.operationName,
      };
    }

    return {
      result: policyResult.status,
      policyResult,
    };
  }

  // Pass-through path: operation is not in the plugin, would be forwarded without policy.
  const operationName = (actionPackage.executionPayload as Record<string, unknown>)?.name;
  return {
    result: "satisfied",
    operationName: typeof operationName === "string" ? operationName : "<unknown>",
    path: "pass-through",
  };
}

export async function installPlugin(path: string, pluginDir: string) {
  const pluginResult = await loadPlugin(path);
  if (!pluginResult.ok) {
    throw new Error(pluginResult.error.message);
  }

  await mkdir(pluginDir, { recursive: true });
  const destination = join(pluginDir, basename(path));
  await copyFile(path, destination);
  return {
    installed: true,
    path: destination,
    pluginDid: pluginResult.plugin.pluginDid,
    pluginVersion: pluginResult.plugin.pluginVersion,
  };
}

export async function listPlugins(pluginDir: string) {
  let files: string[];
  try {
    files = (await readdir(pluginDir)).filter((file) => file.endsWith(".json")).sort();
  } catch {
    files = [];
  }

  const plugins = [];
  for (const file of files) {
    const path = join(pluginDir, file);
    const plugin = await loadPlugin(path);
    plugins.push(
      plugin.ok
        ? {
            file,
            pluginDid: plugin.plugin.pluginDid,
            pluginVersion: plugin.plugin.pluginVersion,
          }
        : {
            file,
            error: plugin.error.code,
          },
    );
  }

  return { plugins };
}

export async function generateKeyFile(name: string, keyDir: string) {
  const key = await generateEd25519Key();
  await mkdir(keyDir, { recursive: true });
  const path = join(keyDir, `${name}.json`);
  const contents = {
    did: key.did,
    kid: key.kid,
    privateJwk: key.privateJwk,
    publicJwk: key.publicJwk,
  };
  await writeFile(path, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return {
    created: true,
    name,
    path,
    did: key.did,
    publicJwk: key.publicJwk,
  };
}

export async function setCredential(handle: string, value: string, credentialDir: string) {
  await mkdir(credentialDir, { recursive: true });
  const path = join(credentialDir, `${handle}.json`);
  await writeFile(path, `${JSON.stringify({ value })}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return {
    stored: true,
    handle,
  };
}

export async function listCredentials(credentialDir: string) {
  let files: string[];
  try {
    files = (await readdir(credentialDir)).filter((file) => file.endsWith(".json")).sort();
  } catch {
    files = [];
  }

  return {
    credentials: files.map((file) => parse(file).name),
  };
}

export async function validateConfig(name: string, options: Pick<ParsedOptions, "configDir" | "credentialDir" | "bridgeDir"> = {}) {
  const loaded = await loadDeploymentConfigs(options.configDir ?? defaultConfigDir(), {
    // Validation reports configuration problems without prompting for runtime use.
    confirmPluginUse: async () => true,
  });
  if (!loaded.ok) {
    throw new Error(loaded.error.message);
  }

  const config = loaded.configs.find((entry) => entry.config.name === name || basename(entry.filePath) === name);
  if (!config) {
    throw new Error(`Config not found: ${name}`);
  }

  const credentialProvider = new FileCredentialProvider(options.credentialDir ?? defaultCredentialDir());
  const credentialChecks = [];
  for (const binding of config.config.credentialBindings) {
    if (binding.provider !== "file") {
      credentialChecks.push({
        handle: binding.credentialHandle,
        provider: binding.provider,
        ok: false,
        error: "CREDENTIAL_PROVIDER_UNSUPPORTED",
      });
      continue;
    }

    const credential = await credentialProvider.getCredential(binding.credentialHandle);
    credentialChecks.push({
      handle: binding.credentialHandle,
      provider: binding.provider,
      ok: credential.ok,
      error: credential.ok ? undefined : credential.error.code,
    });
  }

  const signerChecks = [];
  for (const signer of config.config.signerKeys) {
    const check: { did: string; label?: string; ok: boolean; error?: string } = {
      did: signer.did,
      label: signer.label,
      ok: true,
    };

    // Verify the signer identity. For did:jwk the DID embeds the key and is
    // the source of truth; any configured publicJwk must agree with it.
    try {
      if (isDidJwk(signer.did)) {
        const embedded = didJwkToJwk(signer.did);
        if (signer.publicJwk && signer.publicJwk.x !== embedded.x) {
          check.ok = false;
          check.error = "publicJwk does not match the key embedded in did:jwk (the DID is the source of truth).";
        }
      } else if (!signer.publicJwk) {
        check.ok = false;
        check.error = "publicJwk is required for non-did:jwk DIDs.";
      }
    } catch (error) {
      check.ok = false;
      check.error = `Invalid did:jwk: ${error instanceof Error ? error.message : String(error)}`;
    }

    signerChecks.push(check);
  }

  // Validate bridge configs if --bridge-dir is provided
  const bridgeChecks = [];
  const bridgeDir = options.bridgeDir;
  if (bridgeDir) {
    let bridgeFiles: string[] = [];
    try {
      bridgeFiles = (await readdir(bridgeDir)).filter((f) => f.endsWith(".json"));
    } catch {
      // bridge dir doesn't exist or isn't readable — skip
    }

    const trustedDids = new Set(config.config.signerKeys.map((s) => s.did));
    // Every application this adapter serves, so a bridge proposing to an
    // unserved application is caught here rather than as a confusing
    // UNKNOWN_APPLICATION at dispatch time.
    const servedApplicationDids = new Set(loaded.configs.map((entry) => entry.config.target.applicationDid));
    const bridgeDids = new Map<string, string[]>(); // did → [file, file, ...]
    for (const file of bridgeFiles) {
      const filePath = join(bridgeDir, file);
      try {
        const bridgeConfig = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
        const agentDid = (bridgeConfig.agent as Record<string, unknown>)?.did as string | undefined;
        const check: { file: string; did?: string; ok: boolean; error?: string } = {
          file,
          did: agentDid,
          ok: true,
        };

        const bridgeTarget =
          ((bridgeConfig.target as Record<string, unknown> | undefined)?.applicationDid as string | undefined) ??
          (bridgeConfig.applicationDid as string | undefined);
        const toolsPath = bridgeConfig.tools as string | undefined;

        if (!agentDid) {
          check.ok = false;
          check.error = "Bridge config missing agent.did";
        } else if (!trustedDids.has(agentDid as Did)) {
          check.ok = false;
          check.error = `agent.did ${agentDid} is not in signerKeys`;
        } else if (bridgeTarget && !servedApplicationDids.has(bridgeTarget as Did)) {
          check.ok = false;
          check.error =
            `target.applicationDid ${bridgeTarget} is not served by any deployment config in this directory. ` +
            `Actions from this bridge would be rejected as UNKNOWN_APPLICATION. Served: ${[...servedApplicationDids].join(", ")}`;
        } else if (toolsPath && !existsSync(resolve(dirname(filePath), toolsPath))) {
          check.ok = false;
          check.error = `tools file not found: ${toolsPath}`;
        } else {
          const files = bridgeDids.get(agentDid) ?? [];
          files.push(file);
          bridgeDids.set(agentDid, files);
        }

        bridgeChecks.push(check);
      } catch (error) {
        bridgeChecks.push({
          file,
          ok: false,
          error: `Failed to read bridge config: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    // Warn if multiple bridges use different DIDs — self-approval prevention
    // only works when the proposer and maintainer share the same DID.
    if (bridgeDids.size > 1) {
      const distinctDids = [...bridgeDids.keys()];
      for (const [did, files] of bridgeDids) {
        if (files.length === 1) {
          const check = bridgeChecks.find((b) => b.file === files[0] && b.ok);
          if (check) {
            const otherDids = distinctDids.filter((d) => d !== did);
            check.error = `Uses a different DID than other bridge configs (${otherDids.length} other DID${otherDids.length > 1 ? "s" : ""}). If these bridges belong to the same agent, they should share one DID — otherwise self-approval prevention does not apply between them.`;
            // This is a warning, not an error — don't set ok = false
          }
        }
      }
    }
  }

  const allValid =
    credentialChecks.every((c) => c.ok) &&
    signerChecks.every((s) => s.ok) &&
    bridgeChecks.every((b) => b.ok);

  return {
    valid: allValid,
    name: config.config.name,
    applicationDid: config.config.target.applicationDid,
    pluginDid: config.plugin.pluginDid,
    credentials: credentialChecks,
    signerKeys: signerChecks,
    ...(bridgeChecks.length > 0 ? { bridgeConfigs: bridgeChecks } : {}),
  };
}

async function submitAction(path: string, url: string): Promise<unknown> {
  const actionPackage = JSON.parse(await readFile(path, "utf8")) as unknown;
  const response = await fetch(`${url.replace(/\/$/, "")}/mpas/v1/action`, {
    method: "POST",
    headers: {
      "content-type": "application/mpas+json",
    },
    body: JSON.stringify({ version: "1", type: "ActionRequest", actionPackage }),
  });

  return response.json();
}

interface ValidationResult {
  valid: boolean;
  name: string;
  applicationDid: string;
  pluginDid: string;
  credentials: Array<{ handle: string; provider: string; ok: boolean; error?: string }>;
  signerKeys: Array<{ did: string; label?: string; ok: boolean; error?: string }>;
  bridgeConfigs?: Array<{ file: string; did?: string; ok: boolean; error?: string }>;
}

function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];
  const ok = (msg: string) => `  ✓ ${msg}`;
  const fail = (msg: string) => `  ✗ ${msg}`;

  lines.push(`Config: ${result.name} (${result.applicationDid})`);
  lines.push(`Plugin: ${result.pluginDid} (artifact verified)`);
  lines.push("");

  lines.push("Credentials:");
  for (const c of result.credentials) {
    lines.push(c.ok ? ok(`${c.handle} (found)`) : fail(`${c.handle} — ${c.error}`));
  }
  lines.push("");

  lines.push("Signer Keys:");
  for (const s of result.signerKeys) {
    const shortDid = s.did.length > 30 ? `${s.did.slice(0, 20)}...${s.did.slice(-8)}` : s.did;
    const labelStr = s.label ?? "(no label)";
    lines.push(s.ok ? ok(`${labelStr} — ${shortDid}`) : fail(`${labelStr} — ${shortDid} — ${s.error}`));
  }

  if (result.bridgeConfigs && result.bridgeConfigs.length > 0) {
    lines.push("");
    lines.push("Bridge Configs:");
    for (const b of result.bridgeConfigs) {
      const shortDid = b.did && b.did.length > 30 ? `${b.did.slice(0, 20)}...${b.did.slice(-8)}` : b.did ?? "(none)";
      if (!b.ok) {
        lines.push(fail(`${b.file} — ${shortDid} — ${b.error}`));
      } else if (b.error) {
        lines.push(`  ⚠ ${b.file} — ${shortDid} — ${b.error}`);
      } else {
        lines.push(ok(`${b.file} — ${shortDid}`));
      }
    }
  }

  lines.push("");
  if (result.valid) {
    lines.push("Validation passed.");
  } else {
    const errors = [
      ...result.credentials.filter((c) => !c.ok),
      ...result.signerKeys.filter((s) => !s.ok),
      ...(result.bridgeConfigs ?? []).filter((b) => !b.ok),
    ];
    lines.push(`Validation failed: ${errors.length} error${errors.length === 1 ? "" : "s"}.`);
  }
  lines.push("");

  return lines.join("\n");
}

function parseArgs(args: string[]): { positionals: string[]; options: ParsedOptions } {
  const positionals: string[] = [];
  const options: ParsedOptions = {
    configDir: process.env.MPAS_CONFIG_DIR,
    credentialDir: process.env.MPAS_CREDENTIAL_DIR,
    adapterKeyPath: process.env.MPAS_ADAPTER_KEY,
    journalPath: process.env.MPAS_JOURNAL_PATH,
    tracePath: process.env.MPAS_TRACE_PATH,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--config-dir") {
      options.configDir = args[++index];
    } else if (arg === "--credential-dir") {
      options.credentialDir = args[++index];
    } else if (arg === "--adapter-key") {
      options.adapterKeyPath = args[++index];
    } else if (arg === "--journal-path") {
      options.journalPath = args[++index];
    } else if (arg === "--trace") {
      options.tracePath = args[++index];
    } else if (arg === "--key-dir") {
      options.keyDir = args[++index];
    } else if (arg === "--bridge-dir") {
      options.bridgeDir = args[++index];
    } else if (arg === "--host") {
      options.host = args[++index];
    } else if (arg === "--port") {
      options.port = Number(args[++index]);
    } else if (arg === "--coordination-port") {
      options.coordinationPort = Number(args[++index]);
    } else if (arg === "--auth-enforcement") {
      options.coordinationAuthEnforcement = true;
    } else if (arg === "--auth-audience") {
      (options.coordinationAuthAudiences ??= []).push(args[++index]);
    } else if (arg === "--auth-clock-skew-seconds") {
      options.coordinationAuthClockSkewSeconds = Number(args[++index]);
    } else if (arg === "--auth-signature-lifetime-seconds") {
      options.coordinationAuthSignatureLifetimeSeconds = Number(args[++index]);
    } else if (arg === "--url") {
      options.url = args[++index];
    } else if (arg === "--plugin-dir") {
      options.pluginDir = args[++index];
    } else if (arg === "--value") {
      options.value = args[++index];
    } else if (arg === "--application-did") {
      options.applicationDid = args[++index];
    } else if (arg === "--no-browser") {
      options.noBrowser = true;
    } else if (arg === "--config") {
      options.signerConfigPath = requiredOptionValue(args, index, arg);
      index += 1;
    } else {
      positionals.push(arg);
    }
  }

  options.configDir ??= defaultConfigDir();
  options.credentialDir ??= defaultCredentialDir();
  options.adapterKeyPath ??= defaultAdapterKeyPath();
  return { positionals, options };
}

function requiredOptionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function usage(): string {
  const coordinationAuthFlags = "[--auth-enforcement] [--auth-audience <origin>] [--auth-clock-skew-seconds <seconds>] [--auth-signature-lifetime-seconds <seconds>]";
  return [
    "Usage:",
    `  mpas daemon start [--config-dir <dir>] [--credential-dir <dir>] [--adapter-key <file>] [--journal-path <file>] [--trace <file>] [--host <host>] [--port <port>] [--coordination-port <port>] ${coordinationAuthFlags}`,
    "  mpas daemon status [--config-dir <dir>] [--host <host>] [--port <port>]",
    `  mpas coordination start [--host <host>] [--port <port>] [--trace <file>] ${coordinationAuthFlags}`,
    "  mpas signer-server start --config <path>",
    "  mpas action pending [--config <signer-config>]",
    "  mpas action inspect <action-id> [--config <signer-config>]",
    "  mpas action review <action-id> [--config <signer-config>]",
    "  mpas key generate <name> [--key-dir <dir>]",
    "  mpas test submit <file> [--url <adapter-url>]",
    "  mpas test dry-run <file> [--config-dir <dir>]",
    "  mpas plugin install <path> [--plugin-dir <dir>]",
    "  mpas plugin list [--plugin-dir <dir>]",
    "  mpas credential set <handle> [--credential-dir <dir>] [--value <secret>]",
    "  mpas credential list [--credential-dir <dir>]",
    "  mpas oauth login --application-did <did> [--no-browser] [--config-dir <dir>]",
    "  mpas oauth status --application-did <did> [--config-dir <dir>]",
    "  mpas oauth logout --application-did <did> [--config-dir <dir>]",
    "  mpas config validate <name> [--config-dir <dir>] [--credential-dir <dir>]",
    "  mpas trace inspect <file>",
  ].join("\n");
}

async function runMaintainerAction(
  command: "pending" | "inspect" | "review",
  actionId: string | undefined,
  options: ParsedOptions,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<CliResult> {
  const client = dependencies.signerToolClient ?? createSignerToolClient(options.signerConfigPath, io.stderr);
  try {
    await client.connect();
    await assertSignerTools(client);

    if (command === "pending") {
      const result = await client.callTool("mpas_list_pending", {});
      io.stdout.write(formatSignerResult(pendingResultValue(result)));
      return { exitCode: 0 };
    }

    const review = await client.callTool("mpas_review_action", { actionId });
    const reviewValue = reviewResultValue(review, actionId!);
    io.stdout.write(formatSignerResult(reviewValue));
    if (command === "inspect") return { exitCode: 0 };

    io.stdout.write(`\nReviewing Action ID: ${actionId}\n`);
    io.stdout.write("Approving or rejecting will submit a signed MPAS decision.\n");
    const decision = await (dependencies.promptReviewDecision ?? promptReviewDecision)();
    if (decision === "cancel") {
      io.stdout.write("No decision submitted.\n");
      return { exitCode: 0 };
    }

    const toolName = decision === "approve" ? "mpas_approve" : "mpas_reject";
    const result = await client.callTool(toolName, { actionId });
    io.stdout.write(formatSignerResult(decisionResultValue(result, toolName, reviewValue)));
    return { exitCode: 0 };
  } finally {
    await client.close();
  }
}

function coordinationAuthOptions(options: ParsedOptions): CoordinationAuthOptions {
  return {
    enforcement: options.coordinationAuthEnforcement ?? false,
    audiences: options.coordinationAuthAudiences ?? [],
    ...(options.coordinationAuthClockSkewSeconds !== undefined
      ? { clockSkewSeconds: options.coordinationAuthClockSkewSeconds }
      : {}),
    ...(options.coordinationAuthSignatureLifetimeSeconds !== undefined
      ? { signatureLifetimeSeconds: options.coordinationAuthSignatureLifetimeSeconds }
      : {}),
  };
}

function defaultPluginDir(): string {
  return process.env.MPAS_PLUGIN_DIR ?? join(homedir(), ".mpas", "plugins");
}

function defaultKeyDir(): string {
  return process.env.MPAS_KEY_DIR ?? join(homedir(), ".mpas", "keys");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const result = await runCli();
  process.exitCode = result.exitCode;
}
