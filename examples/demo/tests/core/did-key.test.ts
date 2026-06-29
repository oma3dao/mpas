import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deriveDidKey, didKeyToKid, generateEd25519Key } from "../../src/core/did-key.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("did:key derivation", () => {
  it.each(["adapter.json", "proposer.json", "maintainer-a.json", "maintainer-b.json"])(
    "derives the same did:key as fixture %s",
    async (file) => {
      const key = await readJson<{ did: string; publicJwk: Record<string, unknown> }>(join(fixturesDir, "test-keys", file));
      expect(deriveDidKey(key.publicJwk)).toBe(key.did);
    },
  );

  it("generates an Ed25519 key whose derived DID and kid are self-consistent", async () => {
    const key = await generateEd25519Key();

    expect(key.did).toMatch(/^did:key:z6Mk/);
    expect(deriveDidKey(key.publicJwk)).toBe(key.did);
    expect(deriveDidKey(key.privateJwk)).toBe(key.did);
    expect(key.kid).toBe(didKeyToKid(key.did));
    expect(key.privateJwk.d).toBeDefined();
    expect(key.publicJwk.d).toBeUndefined();
  });

  it("generates distinct keys on each call", async () => {
    const a = await generateEd25519Key();
    const b = await generateEd25519Key();
    expect(a.did).not.toBe(b.did);
  });
});
