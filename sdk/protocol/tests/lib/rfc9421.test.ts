import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { httpbis } from "http-message-signatures";
import {
  serializeDictionary,
  serializeList,
  type BareItem,
  type InnerList,
  type Item,
} from "structured-headers";
import type { JWK } from "jose";
import {
  createContentDigest,
  deriveMpasAudience,
  InMemoryNonceStore,
  isValidMpasAudienceOrigin,
  KeyManager,
  MPAS_COVERED_COMPONENTS,
  MPAS_SIGNATURE_TAG,
  signMpasRfc9421,
  verifyMpasRfc9421,
  type MpasHeaders,
} from "../../src/index.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
const now = new Date("2026-08-07T20:00:00.000Z");
const audience = "https://coordination.example.com";
const path = "/mpas/v1/coordination/poll";

interface FixtureKey {
  privateJwk: JWK;
}

interface MpasConformanceFixture {
  did: string;
  request: { method: string; path: string; body: string };
  created: number;
  expires: number;
  nonce: string;
  contentDigest: string;
  signatureInput: string;
  signature: string;
}

describe("MPAS RFC 9421", () => {
  it("signs and verifies the exact MPAS profile", async () => {
    const signer = await fixtureSigner("proposer");
    const body = requestBody(signer.did);
    const headers = await signMpasRfc9421({
      method: "POST",
      path,
      body,
      signer,
      created: new Date(now.getTime() - 10_000),
      expires: new Date(now.getTime() + 50_000),
      nonce: "round-trip",
    });

    expect(headers["Signature-Input"]).toContain('mpas=("@method" "@path" "content-digest")');
    expect(headers["Signature-Input"]).toContain(';keyid="did:jwk:');
    expect(headers["Signature-Input"]).toContain(';nonce="round-trip";tag="mpas-v1"');
    expect(headers["Signature-Input"]).not.toContain(";alg=");

    await expectVerified(headers, body, signer.did);
  });

  it("strictly reserializes parsed @signature-params instead of using raw field bytes", async () => {
    const signer = await fixtureSigner("proposer");
    const body = requestBody(signer.did);
    const headers = await signMpasRfc9421({
      method: "POST",
      path,
      body,
      signer,
      created: new Date(now.getTime() - 10_000),
      expires: new Date(now.getTime() + 50_000),
      nonce: "optional-whitespace",
    });
    const signatureInputWithWhitespace = headers["Signature-Input"].replaceAll(";", "; ");
    expect(signatureInputWithWhitespace).not.toBe(headers["Signature-Input"]);

    await expectVerified(
      { ...headers, "Signature-Input": signatureInputWithWhitespace },
      body,
      signer.did,
    );
  });

  it("reproduces the committed MPAS v1 fixture byte-exactly", async () => {
    const fixturePath = fileURLToPath(
      new URL("../../../../conformance/http-message-signatures/mpas-v1-ed25519.json", import.meta.url),
    );
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as MpasConformanceFixture;
    const signer = await fixtureSigner("proposer");
    expect(signer.did).toBe(fixture.did);

    const headers = await signMpasRfc9421({
      method: fixture.request.method,
      path: fixture.request.path,
      body: Buffer.from(fixture.request.body),
      signer,
      created: new Date(fixture.created * 1000),
      expires: new Date(fixture.expires * 1000),
      nonce: fixture.nonce,
    });

    expect(headers).toEqual({
      "Content-Digest": fixture.contentDigest,
      "Signature-Input": fixture.signatureInput,
      Signature: fixture.signature,
    });
  });

  it("accepts an alternate label and ignores unrelated signatures", async () => {
    const signer = await fixtureSigner("proposer");
    const body = requestBody(signer.did);
    const coord = await rawSign(signer, body, {
      label: "coord",
      params: validParams(signer.did),
    });
    const unrelated = await rawSign(signer, body, {
      label: "legacy",
      fields: ["@method"],
      params: { created: epoch(now), keyid: signer.did, tag: "other" },
    });
    const headers = combineSignatures(unrelated, coord);

    const result = await verify(headers, body);
    expect(result).toMatchObject({ ok: true, did: signer.did, label: "coord" });
  });

  it.each([
    ["tampered path", { path: "/mpas/v1/coordination/action" }],
    ["tampered key", { key: "maintainer-a" }],
  ])("rejects a %s", async (_name, mutation) => {
    const signer = await fixtureSigner("proposer");
    const body = requestBody(signer.did);
    const headers = await rawSign(signer, body, { params: validParams(signer.did) });

    if (mutation.key) {
      const other = await fixtureSigner(mutation.key);
      const keyed = await rawSign(signer, body, { params: validParams(other.did) });
      const result = await verify(keyed, body);
      expect(result).toMatchObject({ ok: false, status: 401, code: "signature_invalid" });
      return;
    }

    const result = await verify(headers, body, mutation.path);
    expect(result).toMatchObject({ ok: false, status: 401, code: "signature_invalid" });
  });

  it("returns artifact_hash_mismatch for a body changed after signing", async () => {
    const signer = await fixtureSigner("proposer");
    const body = requestBody(signer.did);
    const headers = await rawSign(signer, body, { params: validParams(signer.did) });
    const tampered = Buffer.from(Buffer.from(body).toString("utf8").replace('"type":"CoordinationPollRequest"', '"type":"Changed"'));

    const result = await verify(headers, tampered);
    expect(result).toEqual({
      ok: false,
      status: 400,
      code: "artifact_hash_mismatch",
      reason: "content_digest_mismatch",
    });
  });

  it("rejects missing, malformed, and unsupported Content-Digest values", async () => {
    const signer = await fixtureSigner("proposer");
    const body = requestBody(signer.did);
    for (const digest of ["sha-512=:YWJjZA==:", "not structured"]) {
      const headers = await rawSign(signer, body, {
        params: validParams(signer.did),
        contentDigest: digest,
      });
      const result = await verify(headers, body);
      expect(result).toMatchObject({ ok: false, status: 401, reason: "content_digest_invalid" });
    }
  });

  it("rejects the wrong or missing audience", async () => {
    const signer = await fixtureSigner("proposer");
    for (const body of [
      Buffer.from(JSON.stringify({ version: "1", type: "CoordinationPollRequest", did: signer.did, audience: "https://other.example" })),
      Buffer.from(JSON.stringify({ version: "1", type: "CoordinationPollRequest", did: signer.did })),
    ]) {
      const headers = await rawSign(signer, body, { params: validParams(signer.did) });
      const result = await verify(headers, body);
      expect(result).toMatchObject({ ok: false, status: 401, reason: "audience_invalid" });
    }
  });

  it.each([
    ["equal timestamps", { created: epoch(now), expires: epoch(now) }],
    ["reversed timestamps", { created: epoch(now), expires: epoch(now) - 1 }],
    ["overlong lifetime", { created: epoch(now) - 1, expires: epoch(now) + 60 }],
    ["expired", { created: epoch(now) - 61, expires: epoch(now) - 1 }],
    ["too far in the future", { created: epoch(now) + 31, expires: epoch(now) + 60 }],
    ["non-integer", { created: epoch(now) - 1.5, expires: epoch(now) + 10 }],
  ])("rejects %s", async (_name, times) => {
    const signer = await fixtureSigner("proposer");
    const body = requestBody(signer.did);
    const headers = await rawSign(signer, body, {
      params: { ...validParams(signer.did), ...times },
    });

    const result = await verify(headers, body);
    expect(result).toMatchObject({
      ok: false,
      status: 401,
      reason: _name === "non-integer" ? "parameters_invalid" : "freshness_invalid",
    });
  });

  it("accepts alg=ed25519 and rejects algorithm substitution", async () => {
    const signer = await fixtureSigner("proposer");
    const body = requestBody(signer.did);
    const accepted = await rawSign(signer, body, {
      params: { ...validParams(signer.did), alg: "ed25519" },
    });
    await expectVerified(accepted, body, signer.did);

    const rejected = await rawSign(signer, body, {
      params: { ...validParams(signer.did), alg: "rsa-pss-sha512" },
    });
    expect(await verify(rejected, body)).toMatchObject({ ok: false, reason: "parameters_invalid" });
  });

  it("rejects private key material embedded in keyid", async () => {
    const signer = await fixtureSigner("proposer");
    const fixture = await readFixtureKey("proposer");
    const privateDid = `did:jwk:${Buffer.from(JSON.stringify(fixture.privateJwk)).toString("base64url")}`;
    const body = requestBody(signer.did);
    const headers = await rawSign(signer, body, { params: validParams(privateDid) });

    expect(await verify(headers, body)).toMatchObject({ ok: false, reason: "key_invalid" });
  });

  it.each([
    ["missing component", ["@method", "content-digest"]],
    ["extra component", ["@method", "@path", "content-digest", "content-type"]],
    ["reordered components", ["@path", "@method", "content-digest"]],
  ])("rejects %s", async (_name, fields) => {
    const signer = await fixtureSigner("proposer");
    const body = requestBody(signer.did);
    const headers = await rawSign(signer, body, {
      fields,
      params: validParams(signer.did),
      extraHeaders: { "content-type": "application/mpas+json" },
    });

    expect(await verify(headers, body)).toMatchObject({ ok: false, reason: "covered_components_invalid" });
  });

  it.each(["created", "expires", "keyid", "nonce", "tag"])("rejects missing %s", async (missing) => {
    const signer = await fixtureSigner("proposer");
    const body = requestBody(signer.did);
    const params = validParams(signer.did);
    delete params[missing];
    const headers = await rawSign(signer, body, { params });

    expect(await verify(headers, body)).toMatchObject({ ok: false, status: 401 });
  });

  it("rejects wrong tags, zero candidates, and multiple MPAS candidates", async () => {
    const signer = await fixtureSigner("proposer");
    const body = requestBody(signer.did);
    const otherTag = await rawSign(signer, body, {
      label: "other",
      params: { ...validParams(signer.did), tag: "other" },
    });
    expect(await verify(otherTag, body)).toMatchObject({ ok: false, reason: "candidate_selection_failed" });

    const first = await rawSign(signer, body, { label: "first", params: validParams(signer.did) });
    const second = await rawSign(signer, body, { label: "second", params: validParams(signer.did) });
    expect(await verify(combineSignatures(first, second), body)).toMatchObject({
      ok: false,
      reason: "candidate_selection_failed",
    });
  });

  it("distinguishes absent, partial, malformed, and missing-label signature headers", async () => {
    const signer = await fixtureSigner("proposer");
    const body = requestBody(signer.did);
    const valid = await rawSign(signer, body, { params: validParams(signer.did) });

    expect(await verify({}, body)).toMatchObject({ ok: false, code: "authentication_required" });
    expect(await verify({ "Signature-Input": valid["Signature-Input"] }, body)).toMatchObject({
      ok: false,
      reason: "headers_incomplete",
    });
    expect(await verify({ "Signature-Input": "not valid", Signature: "not valid" }, body)).toMatchObject({
      ok: false,
      reason: "structured_field_malformed",
    });
    expect(await verify({ ...valid, Signature: valid.Signature.replace("mpas=", "other=") }, body)).toMatchObject({
      ok: false,
      reason: "signature_member_missing",
    });
  });

  it("derives and validates canonical service origins", () => {
    expect(deriveMpasAudience("https://Example.COM:443/mpas/v1/coordination/")).toBe("https://example.com");
    expect(deriveMpasAudience("https://[2001:db8::1]:8443/base/")).toBe("https://[2001:db8::1]:8443");
    expect(isValidMpasAudienceOrigin("https://example.com")).toBe(true);
    expect(isValidMpasAudienceOrigin("http://127.0.0.1:7545")).toBe(true);
    expect(isValidMpasAudienceOrigin("https://example.com/path")).toBe(false);
    expect(isValidMpasAudienceOrigin("https://example.com/")).toBe(false);
    expect(isValidMpasAudienceOrigin("https://user:pass@example.com")).toBe(false);
    expect(isValidMpasAudienceOrigin("not-a-url")).toBe(false);
    expect(() => deriveMpasAudience("file:///tmp/coordination")).toThrow("http or https");
  });

  it("rejects invalid signing lifetimes and expires windows", async () => {
    const signer = await fixtureSigner("proposer");
    const body = requestBody(signer.did);
    const base = { method: "POST", path, body, signer };

    await expect(signMpasRfc9421({ ...base, lifetimeSeconds: 0 })).rejects.toThrow(/integer from 1 to 60/);
    await expect(signMpasRfc9421({ ...base, lifetimeSeconds: 61 })).rejects.toThrow(/integer from 1 to 60/);
    await expect(signMpasRfc9421({ ...base, lifetimeSeconds: 1.5 })).rejects.toThrow(/integer from 1 to 60/);
    await expect(signMpasRfc9421({
      ...base,
      created: now,
      expires: now,
    })).rejects.toThrow(/expires must be after created/);
  });

  it("treats a non-JSON body as an invalid audience after digest verification", async () => {
    const signer = await fixtureSigner("proposer");
    const body = Buffer.from("not-json");
    const headers = await signMpasRfc9421({
      method: "POST",
      path,
      body,
      signer,
      created: new Date(now.getTime() - 10_000),
      expires: new Date(now.getTime() + 50_000),
    });

    await expect(verify(headers, body)).resolves.toMatchObject({
      ok: false,
      reason: "audience_invalid",
    });
  });

  it("throws on an invalid verification policy instead of failing closed as auth", async () => {
    const signer = await fixtureSigner("proposer");
    const body = requestBody(signer.did);
    const headers = await signMpasRfc9421({
      method: "POST",
      path,
      body,
      signer,
      created: new Date(now.getTime() - 10_000),
      expires: new Date(now.getTime() + 50_000),
    });

    await expect(verifyMpasRfc9421({
      method: "POST",
      path,
      headers,
      body,
      audiences: [audience],
      now,
      maxLifetimeSeconds: 0,
    })).rejects.toThrow("Invalid RFC 9421 verification policy.");
    await expect(verifyMpasRfc9421({
      method: "POST",
      path,
      headers,
      body,
      audiences: [audience],
      now,
      clockSkewSeconds: -1,
    })).rejects.toThrow("Invalid RFC 9421 verification policy.");
  });

  it("keeps nonce claims atomic and retained through expiry", async () => {
    let currentTime = now.getTime();
    const store = new InMemoryNonceStore(() => currentTime);
    const expiresAt = new Date(currentTime + 10_000);

    const results = await Promise.all([
      store.claim("did:jwk:test", "same", expiresAt),
      store.claim("did:jwk:test", "same", expiresAt),
    ]);
    expect(results.sort()).toEqual([false, true]);

    currentTime = expiresAt.getTime();
    await expect(store.claim("did:jwk:test", "same", new Date(currentTime + 10_000))).resolves.toBe(false);
    currentTime += 1;
    await expect(store.claim("did:jwk:test", "same", new Date(currentTime + 10_000))).resolves.toBe(true);
  });

  it("reclaims a nonce whose stored expiry is non-finite", async () => {
    const store = new InMemoryNonceStore();
    await expect(store.claim("did:jwk:test", "nan-expiry", new Date(Number.NaN))).resolves.toBe(true);
    await expect(store.claim("did:jwk:test", "nan-expiry", new Date(now.getTime() + 10_000))).resolves.toBe(true);
  });

  it("treats a path that cannot build a signature base as unverifiable", async () => {
    const signer = await fixtureSigner("proposer");
    const body = requestBody(signer.did);
    const headers = await signMpasRfc9421({
      method: "POST",
      path,
      body,
      signer,
      created: new Date(now.getTime() - 10_000),
      expires: new Date(now.getTime() + 50_000),
    });

    await expect(verify(headers, body, "http://[")).resolves.toMatchObject({
      ok: false,
      reason: "signature_unverifiable",
    });
  });
});

async function verify(headers: MpasHeaders, body: Uint8Array, requestPath = path) {
  return verifyMpasRfc9421({
    method: "POST",
    path: requestPath,
    headers,
    body,
    audiences: [audience],
    now,
    clockSkewSeconds: 30,
  });
}

async function expectVerified(headers: MpasHeaders, body: Uint8Array, did: string): Promise<void> {
  const result = await verify(headers, body);
  expect(result).toMatchObject({ ok: true, did });
}

function requestBody(did: string): Buffer {
  return Buffer.from(JSON.stringify({ version: "1", type: "CoordinationPollRequest", did, audience }));
}

function validParams(keyid: string): Record<string, BareItem> {
  return {
    created: epoch(now) - 10,
    expires: epoch(now) + 50,
    keyid,
    nonce: "fixture-nonce",
    tag: MPAS_SIGNATURE_TAG,
  };
}

function epoch(value: Date): number {
  return Math.floor(value.getTime() / 1000);
}

async function rawSign(
  signer: KeyManager,
  body: Uint8Array,
  options: {
    label?: string;
    fields?: string[];
    params: Record<string, BareItem>;
    contentDigest?: string;
    extraHeaders?: Record<string, string>;
  },
): Promise<Record<string, string>> {
  // This helper signs intentionally malformed or non-canonical profile
  // variants that signMpasRfc9421 correctly refuses to emit. Its manual RFC
  // base construction is not the correctness oracle: the independent B.2.6
  // known-answer test pins the library, and the primary round trip above signs
  // through httpbis.signMessage.
  const label = options.label ?? "mpas";
  const fields = options.fields ?? [...MPAS_COVERED_COMPONENTS];
  const contentDigest = options.contentDigest ?? createContentDigest(body);
  const requestHeaders = { "content-digest": contentDigest, ...options.extraHeaders };
  const request = { method: "POST", url: new URL(path, "https://mpas.invalid"), headers: requestHeaders };
  const parameters = new Map(Object.entries(options.params));
  const items = fields.map((field): Item => [field, new Map()]);
  const input: InnerList = [items, parameters];
  const inputValue = serializeList([input]);
  const base = httpbis.createSignatureBase({ fields }, request);
  base.push(["\"@signature-params\"", [inputValue]]);
  const signature = await signer.signBytes(Buffer.from(httpbis.formatSignatureBase(base), "utf8"));

  return {
    "Content-Digest": contentDigest,
    "Signature-Input": serializeDictionary(new Map([[label, input]])),
    Signature: serializeDictionary(new Map([[label, [toArrayBuffer(signature), new Map()]]])),
  };
}

function combineSignatures(first: Record<string, string>, second: Record<string, string>): Record<string, string> {
  return {
    "Content-Digest": second["Content-Digest"],
    "Signature-Input": `${first["Signature-Input"]}, ${second["Signature-Input"]}`,
    Signature: `${first.Signature}, ${second.Signature}`,
  };
}

async function fixtureSigner(label: string): Promise<KeyManager> {
  return KeyManager.fromFile(join(fixturesDir, "keys", `${label}.json`));
}

async function readFixtureKey(label: string): Promise<FixtureKey> {
  return JSON.parse(await readFile(join(fixturesDir, "keys", `${label}.json`), "utf8")) as FixtureKey;
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}
