import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileCredentialProvider } from "../../src/adapter/credential-provider.js";

async function credentialDir() {
  const dir = await mkdtemp(join(tmpdir(), "mpas-credentials-"));
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeCredential(dir: string, handle: string, value: unknown, mode = 0o600): Promise<void> {
  const path = join(dir, `${handle}.json`);
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode });
  await chmod(path, mode);
}

describe("FileCredentialProvider", () => {
  it("resolves an existing chmod 600 credential handle", async () => {
    const dir = await credentialDir();
    await writeCredential(dir, "github-mirror-token", { value: "ghp_test" });

    await expect(new FileCredentialProvider(dir).getCredential("github-mirror-token")).resolves.toEqual({
      ok: true,
      value: "ghp_test",
    });
  });

  it("returns an error for missing handles", async () => {
    const dir = await credentialDir();

    await expect(new FileCredentialProvider(dir).getCredential("missing")).resolves.toMatchObject({
      ok: false,
      error: {
        code: "CREDENTIAL_NOT_FOUND",
      },
    });
  });

  it("returns an error for invalid credential shape", async () => {
    const dir = await credentialDir();
    await writeCredential(dir, "bad", { token: "ghp_test" });

    await expect(new FileCredentialProvider(dir).getCredential("bad")).resolves.toMatchObject({
      ok: false,
      error: {
        code: "CREDENTIAL_INVALID_SHAPE",
      },
    });
  });

  it("rejects credentials readable by group or others", async () => {
    const dir = await credentialDir();
    await writeCredential(dir, "open", { value: "ghp_test" }, 0o644);

    await expect(new FileCredentialProvider(dir).getCredential("open")).resolves.toMatchObject({
      ok: false,
      error: {
        code: "CREDENTIAL_INSECURE_PERMISSIONS",
      },
    });
  });
});
