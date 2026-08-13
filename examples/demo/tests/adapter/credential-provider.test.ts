import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileCredentialProvider } from "../../src/adapter/credential-provider.js";

const { statMock } = vi.hoisted(() => ({
  statMock: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: (...args: Parameters<typeof actual.stat>) => statMock(...args) as ReturnType<typeof actual.stat>,
  };
});

async function credentialDir() {
  const dir = await mkdtemp(join(tmpdir(), "mpas-credentials-"));
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeCredential(dir: string, handle: string, value: unknown): Promise<void> {
  await writeFile(join(dir, `${handle}.json`), `${JSON.stringify(value)}\n`);
}

afterEach(() => {
  statMock.mockReset();
});

describe("FileCredentialProvider", () => {
  it("resolves an existing credential when mode is owner-only", async () => {
    const dir = await credentialDir();
    await writeCredential(dir, "github-mirror-token", { value: "ghp_test" });
    statMock.mockResolvedValue({ mode: 0o100600 } as Awaited<ReturnType<typeof import("node:fs/promises").stat>>);

    await expect(new FileCredentialProvider(dir).getCredential("github-mirror-token")).resolves.toEqual({
      ok: true,
      value: "ghp_test",
    });
  });

  it("returns an error for missing handles", async () => {
    const dir = await credentialDir();
    statMock.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

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
    statMock.mockResolvedValue({ mode: 0o100600 } as Awaited<ReturnType<typeof import("node:fs/promises").stat>>);

    await expect(new FileCredentialProvider(dir).getCredential("bad")).resolves.toMatchObject({
      ok: false,
      error: {
        code: "CREDENTIAL_INVALID_SHAPE",
      },
    });
  });

  it("returns an error for invalid JSON", async () => {
    const dir = await credentialDir();
    await writeFile(join(dir, "broken.json"), "{not-json\n");
    statMock.mockResolvedValue({ mode: 0o100600 } as Awaited<ReturnType<typeof import("node:fs/promises").stat>>);

    await expect(new FileCredentialProvider(dir).getCredential("broken")).resolves.toMatchObject({
      ok: false,
      error: {
        code: "CREDENTIAL_INVALID_JSON",
      },
    });
  });

  it("rejects credentials readable by group or others", async () => {
    const dir = await credentialDir();
    await writeCredential(dir, "open", { value: "ghp_test" });
    statMock.mockResolvedValue({ mode: 0o100644 } as Awaited<ReturnType<typeof import("node:fs/promises").stat>>);

    await expect(new FileCredentialProvider(dir).getCredential("open")).resolves.toMatchObject({
      ok: false,
      error: {
        code: "CREDENTIAL_INSECURE_PERMISSIONS",
      },
    });
  });
});
