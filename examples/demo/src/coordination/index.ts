#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { startCoordinationDaemon } from "./daemon.js";

export { createCoordinationHttpEndpoint } from "./http-endpoint.js";
export { CoordinationStore, CoordinationStoreError } from "./store.js";
export * from "./types.js";

interface ParsedArgs {
  host?: string;
  port?: number;
}

export async function runCoordinationService(args = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args);
  const daemon = await startCoordinationDaemon(options);
  console.log(JSON.stringify({ status: "started", address: daemon.address }));

  const shutdown = async () => {
    await daemon.app.close();
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => {
      process.exitCode = 0;
    });
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => {
      process.exitCode = 0;
    });
  });
}

function parseArgs(args: string[]): ParsedArgs {
  const options: ParsedArgs = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--host") {
      options.host = args[++index];
    } else if (arg === "--port") {
      options.port = Number(args[++index]);
    }
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCoordinationService();
}
