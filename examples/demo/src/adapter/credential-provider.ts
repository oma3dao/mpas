import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CredentialResult {
  ok: true;
  value: string;
}

export interface CredentialError {
  ok: false;
  error: {
    kind: "CredentialError";
    code: "CREDENTIAL_NOT_FOUND" | "CREDENTIAL_INVALID_JSON" | "CREDENTIAL_INVALID_SHAPE" | "CREDENTIAL_INSECURE_PERMISSIONS";
    message: string;
    path: string;
  };
}

export type CredentialProviderResult = CredentialResult | CredentialError;

export class FileCredentialProvider {
  constructor(private readonly credentialDir = join(homedir(), ".mpas", "credentials")) {}

  async getCredential(credentialHandle: string): Promise<CredentialProviderResult> {
    const path = join(this.credentialDir, `${credentialHandle}.json`);

    let mode: number;
    try {
      mode = (await stat(path)).mode;
    } catch {
      return credentialError("CREDENTIAL_NOT_FOUND", `Credential handle not found: ${credentialHandle}`, path);
    }

    if ((mode & 0o077) !== 0) {
      return credentialError("CREDENTIAL_INSECURE_PERMISSIONS", "Credential file must be chmod 600.", path);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      return credentialError("CREDENTIAL_INVALID_JSON", `Credential file is not valid JSON: ${credentialHandle}`, path);
    }

    if (!isRecord(parsed) || typeof parsed.value !== "string") {
      return credentialError("CREDENTIAL_INVALID_SHAPE", 'Credential file must contain a string "value".', path);
    }

    return {
      ok: true,
      value: parsed.value,
    };
  }
}

function credentialError(
  code: CredentialError["error"]["code"],
  message: string,
  path: string,
): CredentialProviderResult {
  return {
    ok: false,
    error: {
      kind: "CredentialError",
      code,
      message,
      path,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
