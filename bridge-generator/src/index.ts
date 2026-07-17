#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generateBridge } from "./bridge-codegen.js";
import { discoverUpstream } from "./discovery.js";
import { generatePlugin } from "./plugin-codegen.js";

interface CliArgs {
  outputBridge: string;
  outputPlugin?: string;
  upstreamCommand: string;
  upstreamArgs: string[];
}

export async function run(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const upstream = await discoverUpstream(args.upstreamCommand, args.upstreamArgs);

  await writeOutput(args.outputBridge, generateBridge(upstream));
  process.stderr.write(`Bridge written to: ${args.outputBridge}\n`);

  if (args.outputPlugin) {
    await writeOutput(args.outputPlugin, generatePlugin(upstream.tools));
    process.stderr.write(`Plugin written to: ${args.outputPlugin}\n`);
  }
}

function parseArgs(argv: string[]): CliArgs {
  let outputBridge: string | undefined;
  let outputPlugin: string | undefined;
  let delimiterIndex = -1;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") {
      delimiterIndex = index;
      break;
    }
    if (arg === "--output-bridge") {
      outputBridge = argv[++index];
      continue;
    }
    if (arg === "--output-plugin") {
      outputPlugin = argv[++index];
      continue;
    }
    throw usage(`Unknown argument: ${arg}`);
  }

  if (!outputBridge) {
    throw usage("Missing required --output-bridge <path>.");
  }
  if (delimiterIndex < 0 || !argv[delimiterIndex + 1]) {
    throw usage("Missing upstream command after --.");
  }

  return {
    outputBridge: resolve(outputBridge),
    ...(outputPlugin ? { outputPlugin: resolve(outputPlugin) } : {}),
    upstreamCommand: argv[delimiterIndex + 1],
    upstreamArgs: argv.slice(delimiterIndex + 2),
  };
}

async function writeOutput(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

function usage(message: string): Error {
  return new Error(`${message}

Usage:
  bridge-generator --output-bridge <path> [--output-plugin <path>] -- <upstream-command> [upstream-args...]`);
}

function exitCodeFor(error: unknown): number {
  if (typeof error === "object" && error !== null && "exitCode" in error) {
    const code = (error as { exitCode?: unknown }).exitCode;
    if (typeof code === "number") {
      return code;
    }
  }
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await run();
  } catch (error) {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(exitCodeFor(error));
  }
}
