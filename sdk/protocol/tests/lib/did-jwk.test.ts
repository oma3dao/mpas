import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deriveDidJwk, didJwkToJwk, didJwkToKid, generateEd25519Key, isDidJwk } from "../../src/lib/did-jwk.js";

const fixturesDir = fileURLToPath(new URL("../../../../examples/demo/tests/fixtures/", import.meta.url));

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("did:jwk derivation (sdk)", () => {
  it.each(["adapter.json", "proposer.json", "maintainer-a.json", "maintainer-b.json"])(
    "derives the same did:jwk as fixture %s",
    async (file) => {
      const key = await readJson<{ did: string; publicJwk: Record<string, unknown> }>(
        join(fixturesDir, "test-keys", file),
      );
      expect(deriveDidJwk(key.publicJwk)).toBe(key.did);
    },
  );

  it("derivation is canonical across JWK member order", async () => {
    const key = await readJson<{ did: string; publicJwk: { crv: string; kty: string; x: string } }>(
      join(fixturesDir, "test-keys", "proposer.json"),
    );
    const reordered = {
      x: key.publicJwk.x,
      kty: key.publicJwk.kty,
      crv: key.publicJwk.crv,
      alg: "EdDSA",
      use: "sig",
      kid: "anything",
    };
    expect(deriveDidJwk(reordered)).toBe(key.did);
  });

  it("round-trips: the DID is the source of truth for the public key", async () => {
    const key = await readJson<{ did: string; publicJwk: { x: string } }>(
      join(fixturesDir, "test-keys", "proposer.json"),
    );
    const decoded = didJwkToJwk(key.did);
    expect(decoded.x).toBe(key.publicJwk.x);
    expect(decoded.kty).toBe("OKP");
    expect(decoded.crv).toBe("Ed25519");
  });

  it("rejects a did:jwk containing private key material", async () => {
    const key = await readJson<{ privateJwk: { crv: string; kty: string; x: string; d: string } }>(
      join(fixturesDir, "test-keys", "proposer.json"),
    );
    const { crv, kty, x, d } = key.privateJwk;
    const withPrivate = `did:jwk:${Buffer.from(JSON.stringify({ crv, d, kty, x }), "utf8").toString("base64url")}`;
    expect(() => didJwkToJwk(withPrivate)).toThrow(/private key material/);
  });

  it("generates an Ed25519 key whose derived DID and kid are self-consistent", async () => {
    const key = await generateEd25519Key();

    expect(key.did).toMatch(/^did:jwk:/);
    expect(deriveDidJwk(key.publicJwk)).toBe(key.did);
    expect(deriveDidJwk(key.privateJwk)).toBe(key.did);
    expect(key.kid).toBe(didJwkToKid(key.did));
    expect(key.kid.endsWith("#0")).toBe(true);
    expect(key.privateJwk.d).toBeDefined();
    expect(key.publicJwk.d).toBeUndefined();
  });

  it("generates distinct keys on each call", async () => {
    const a = await generateEd25519Key();
    const b = await generateEd25519Key();
    expect(a.did).not.toBe(b.did);
  });

  it("rejects non-Ed25519 JWKs for derivation", () => {
    expect(() => deriveDidJwk({ kty: "EC", crv: "P-256", x: "x" })).toThrow(/Ed25519/);
    expect(() => deriveDidJwk({ kty: "OKP", crv: "X25519", x: "x" })).toThrow(/Ed25519/);
    expect(() => deriveDidJwk({ kty: "OKP", crv: "Ed25519", x: "" })).toThrow(/Ed25519/);
  });

  it("rejects malformed did:jwk payloads", () => {
    expect(() => didJwkToJwk("did:web:example")).toThrow(/Not a did:jwk/);
    expect(() => didJwkToJwk("did:jwk:!!!")).toThrow(/not canonical unpadded base64url/);
    expect(() => didJwkToJwk("did:jwk:YR")).toThrow(/not valid base64url-encoded JSON/);
    expect(() => didJwkToJwk(`did:jwk:${Buffer.from("{").toString("base64url")}`)).toThrow(
      /not valid base64url-encoded JSON/,
    );
    expect(() => didJwkToJwk(`did:jwk:${Buffer.from("[]").toString("base64url")}`)).toThrow(/must be a JWK object/);
    expect(() =>
      didJwkToJwk(`did:jwk:${Buffer.from(JSON.stringify({ kty: "OKP", crv: "X25519", x: "abc" })).toString("base64url")}`),
    ).toThrow(/Ed25519/);
  });

  it("reports isDidJwk", () => {
    expect(isDidJwk("did:jwk:abc")).toBe(true);
    expect(isDidJwk("did:web:example")).toBe(false);
  });
});
