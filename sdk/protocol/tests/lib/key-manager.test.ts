import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JWK } from "jose";
import { describe, expect, it } from "vitest";
import { KeyManager } from "../../src/index.js";
import type { Did } from "../../src/index.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

interface KeyFixture {
  did: Did;
  privateJwk: JWK;
  publicJwk: JWK;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("KeyManager", () => {
  it("loads fixture keys and derives their did:jwk identifiers", async () => {
    for (const file of ["proposer.json", "maintainer-a.json", "maintainer-b.json", "adapter.json"]) {
      const fixture = await readJson<KeyFixture>(join(fixturesDir, "keys", file));
      const keyManager = await KeyManager.fromFile(join(fixturesDir, "keys", file));

      expect(keyManager.did).toBe(fixture.did);
      expect(keyManager.publicKey).toEqual(fixture.publicJwk);
      expect(keyManager.publicKey).not.toHaveProperty("d");
    }
  });

  it("signs and verifies payloads round-trip", async () => {
    const keyManager = await KeyManager.fromFile(join(fixturesDir, "keys", "proposer.json"));
    const payload = Buffer.from("mpas bridge key manager test");
    const jws = await keyManager.sign(payload);

    await expect(keyManager.verify(jws)).resolves.toBe(true);
  });

  it("rejects signing when only a public JWK is available", async () => {
    const fixture = await readJson<KeyFixture>(join(fixturesDir, "keys", "proposer.json"));
    const keyManager = KeyManager.fromJwk(fixture.publicJwk);

    expect(keyManager.did).toBe(fixture.did);
    await expect(keyManager.sign(Buffer.from("payload"))).rejects.toThrow("private key material");
  });

  it("rejects unsupported JWKs and mismatched configured DIDs", async () => {
    expect(() => KeyManager.fromJwk({ kty: "EC", crv: "P-256", x: "x", y: "y" })).toThrow('kty "OKP"');

    const fixture = await readJson<KeyFixture>(join(fixturesDir, "keys", "proposer.json"));
    const mismatched = { did: "did:jwk:bWlzbWF0Y2g", privateJwk: fixture.privateJwk };
    const path = join(fixturesDir, "keys", "mismatched.tmp.json");
    await import("node:fs/promises").then(({ writeFile, rm }) =>
      writeFile(path, JSON.stringify(mismatched)).then(async () => {
        await expect(KeyManager.fromFile(path)).rejects.toThrow("does not match derived DID");
        await rm(path);
      }),
    );
  });
});
