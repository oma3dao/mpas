import type { CliIo } from "../index.js";
import type { Account, HomePaths } from "./account.js";
import { roleTitle } from "./account.js";
import type { InstallerDependencies } from "./deps.js";
import { Asker } from "./values.js";

export interface InstallerContext {
  deps: InstallerDependencies;
  io: CliIo;
  asker: Asker;
}

export function createContext(deps: InstallerDependencies, io: CliIo): InstallerContext {
  return { deps, io, asker: new Asker(deps, io) };
}

export function say(ctx: InstallerContext, text = ""): void {
  ctx.io.stdout.write(`${text}\n`);
}

export function warn(ctx: InstallerContext, text: string): void {
  ctx.io.stderr.write(`Warning: ${text}\n`);
}

export function printSettings(ctx: InstallerContext, paths: HomePaths, account: Account): void {
  say(ctx, `MPAS home: ${paths.home}`);
  say(ctx, `Roles: ${account.roles.map(roleTitle).join(", ")}`);
  say(ctx, `DID: ${account.did}`);
  if (account.roles.includes("proposer") || account.roles.includes("maintainer")) {
    say(ctx, `Coordination URL: ${account.coordinationUrl ?? "(not set)"}`);
  }
  if (account.roles.includes("proposer") || account.roles.includes("verifier")) {
    say(ctx, `Action URL: ${account.actionUrl ?? "(not set)"}`);
  }
  if (account.roles.includes("verifier")) {
    say(ctx, `Mode: ${account.verifierMode ?? "(not set)"}`);
  }
  if (account.roles.includes("proposer")) {
    say(ctx, `Verifier DID: ${account.verifierDid ?? "(not set)"}`);
  }
}
