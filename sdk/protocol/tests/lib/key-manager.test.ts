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

    const rawSignature = await keyManager.signBytes(payload);
    await expect(keyManager.verifyBytes(payload, rawSignature)).resolves.toBe(true);
    await expect(keyManager.verifyBytes(Buffer.from("tampered"), rawSignature)).resolves.toBe(false);
    await expect(keyManager.verifyBytes(payload, Buffer.from("short"))).resolves.toBe(false);
  });

  it("rejects signing when only a public JWK is available", async () => {
    const fixture = await readJson<KeyFixture>(join(fixturesDir, "keys", "proposer.json"));
    const keyManager = KeyManager.fromJwk(fixture.publicJwk);

    expect(keyManager.did).toBe(fixture.did);
    await expect(keyManager.sign(Buffer.from("payload"))).rejects.toThrow("private key material");
    await expect(keyManager.signBytes(Buffer.from("payload"))).rejects.toThrow("private key material");
  });

  it("rejects unsupported JWKs and mismatched configured DIDs", async () => {
    expect(() => KeyManager.fromJwk({ kty: "EC", crv: "P-256", x: "x", y: "y" })).toThrow('kty "OKP"');
    expect(() => KeyManager.fromJwk({ kty: "OKP", crv: "X25519", x: "x" })).toThrow('crv "Ed25519"');
    expect(() => KeyManager.fromJwk({ kty: "OKP", crv: "Ed25519", x: "" })).toThrow("public key parameter x");

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

  it("loads a bare private JWK object and fails verification for garbage input", async () => {
    const fixture = await readJson<KeyFixture>(join(fixturesDir, "keys", "proposer.json"));
    const keyManager = KeyManager.fromJwk(fixture.privateJwk);
    expect(keyManager.did).toBe(fixture.did);
    await expect(keyManager.verify("not.a.jws")).resolves.toBe(false);
  });

  it("loads public-only and bare private JWK files", async () => {
    const fixture = await readJson<KeyFixture>(join(fixturesDir, "keys", "proposer.json"));
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "mpas-key-manager-"));
    try {
      const publicOnly = join(dir, "public-only.json");
      await writeFile(publicOnly, JSON.stringify({ did: fixture.did, publicJwk: fixture.publicJwk }));
      const publicManager = await KeyManager.fromFile(publicOnly);
      expect(publicManager.did).toBe(fixture.did);
      await expect(publicManager.sign(Buffer.from("x"))).rejects.toThrow("private key material");

      const barePrivate = join(dir, "bare-private.json");
      await writeFile(barePrivate, JSON.stringify(fixture.privateJwk));
      const privateManager = await KeyManager.fromFile(barePrivate);
      expect(privateManager.did).toBe(fixture.did);
      await expect(privateManager.sign(Buffer.from("x"))).resolves.toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
