#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { startCoordinationDaemon } from "./daemon.js";
import type { CoordinationAuthOptions } from "./coordination-api-server.js";
import type { Did } from "../core/types.js";

export {
  createCoordinationApiServer,
  type CoordinationAuthOptions,
  type CoordinationHttpEndpointOptions,
} from "./coordination-api-server.js";
export { CoordinationStore, CoordinationStoreError } from "./store.js";
export * from "./types.js";

interface ParsedArgs {
  host?: string;
  port?: number;
  authEnforcement?: boolean;
  authAudiences?: string[];
  authClockSkewSeconds?: number;
  authSignatureLifetimeSeconds?: number;
  designatedVerifierDid?: Did;
  authorizedRecipientDids?: Did[];
  notificationOrigin?: string;
}

export async function runCoordinationService(args = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args);
  const daemon = await startCoordinationDaemon({
    host: options.host,
    port: options.port,
    auth: coordinationAuthOptions(options),
    designatedVerifierDid: options.designatedVerifierDid,
    authorizedRecipientDids: options.authorizedRecipientDids,
    notificationOrigin: options.notificationOrigin,
  });
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
    } else if (arg === "--auth-enforcement") {
      options.authEnforcement = true;
    } else if (arg === "--auth-audience") {
      (options.authAudiences ??= []).push(args[++index]);
    } else if (arg === "--auth-clock-skew-seconds") {
      options.authClockSkewSeconds = Number(args[++index]);
    } else if (arg === "--auth-signature-lifetime-seconds") {
      options.authSignatureLifetimeSeconds = Number(args[++index]);
    } else if (arg === "--designated-verifier-did") {
      options.designatedVerifierDid = args[++index] as Did;
    } else if (arg === "--authorized-recipient-did") {
      (options.authorizedRecipientDids ??= []).push(args[++index] as Did);
    } else if (arg === "--notification-origin") {
      options.notificationOrigin = args[++index];
    }
  }
  return options;
}

function coordinationAuthOptions(options: ParsedArgs): CoordinationAuthOptions {
  return {
    enforcement: options.authEnforcement ?? false,
    audiences: options.authAudiences ?? [],
    ...(options.authClockSkewSeconds !== undefined ? { clockSkewSeconds: options.authClockSkewSeconds } : {}),
    ...(options.authSignatureLifetimeSeconds !== undefined
      ? { signatureLifetimeSeconds: options.authSignatureLifetimeSeconds }
      : {}),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCoordinationService();
}
