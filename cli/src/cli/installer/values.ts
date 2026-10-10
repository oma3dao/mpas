import { didJwkToJwk, isDidJwk } from "../../core/did-jwk.js";
import type { CliIo } from "../index.js";
import type { InstallerDependencies } from "./deps.js";
import { InstallerError } from "./errors.js";

export const DEFAULT_COORDINATION_URL = "http://127.0.0.1:7545";
export const DEFAULT_ACTION_URL = "http://127.0.0.1:7544";

/** Parses a URL answer or flag. `local` and `localhost` mean the default. No scheme is ever added. */
export function parseUrl(value: string, defaultUrl: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === "local" || trimmed === "localhost") return defaultUrl;
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new InstallerError(`${label} must include http:// or https:// (for example https://${trimmed || "api.example.com"}).`, 2);
  }
  try {
    new URL(trimmed);
  } catch {
    throw new InstallerError(`${label} is not a valid URL: ${trimmed}`, 2);
  }
  return trimmed;
}

/** Any syntactically valid DID. A did:jwk must also decode. */
export function parseDid(value: string, label: string): string {
  const trimmed = value.trim();
  if (!/^did:[a-z0-9]+:.+/.test(trimmed)) {
    throw new InstallerError(`${label} is not a DID: ${trimmed}`, 2);
  }
  if (trimmed.startsWith("did:jwk:")) parseDidJwk(trimmed, label);
  return trimmed;
}

/** A did:jwk whose embedded key decodes. */
export function parseDidJwk(value: string, label: string): string {
  const trimmed = value.trim();
  try {
    if (!isDidJwk(trimmed)) throw new Error("not did:jwk");
    didJwkToJwk(trimmed);
  } catch {
    throw new InstallerError(`${label} must be a valid did:jwk: ${trimmed}`, 2);
  }
  return trimmed;
}

/** Terminal questions. Invalid answers are reported and asked again, up to three times. */
export class Asker {
  constructor(private readonly deps: InstallerDependencies, private readonly io: CliIo) {}

  async ask<T>(question: string, parse: (answer: string) => T): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const answer = await this.deps.prompt(question);
      try {
        return parse(answer);
      } catch (error) {
        lastError = error;
        this.io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    throw lastError instanceof Error ? lastError : new InstallerError(String(lastError));
  }

  async url(label: string, defaultUrl: string, saved?: string): Promise<string> {
    const shown = saved ?? defaultUrl;
    return this.ask(`${label} (${shown}): `, (answer) => (answer.trim() === "" ? shown : parseUrl(answer, defaultUrl, label)));
  }

  async optionalDid(label: string, saved?: string): Promise<string | undefined> {
    const suffix = saved ? ` (${saved})` : "";
    return this.ask(`${label}${suffix}: `, (answer) => (answer.trim() === "" ? saved : parseDid(answer, label)));
  }

  async required(label: string, hint: string, parse: (answer: string) => string): Promise<string> {
    return this.ask(`${label} (${hint}): `, (answer) => {
      if (answer.trim() === "") throw new InstallerError(`${label} is required.`, 2);
      return parse(answer.trim());
    });
  }

  async confirm(question: string): Promise<boolean> {
    const answer = (await this.deps.prompt(`${question} [y/N]: `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  }
}
