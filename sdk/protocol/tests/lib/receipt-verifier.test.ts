import { createPrivateKey, sign } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import { beforeAll, describe, expect, it } from "vitest";
import * as mpas from "../../src/index.js";
import type { JWK } from "jose";

const now = Date.parse("2026-09-01T12:00:00.000Z");
let issuer: mpas.GeneratedKey;
let other: mpas.GeneratedKey;
let envelope: mpas.ActionEnvelope;
const executionPayload: mpas.ExecutionPayload = { name: "echo", arguments: { text: "receipt control" } };

beforeAll(async () => {
  issuer = await mpas.generateEd25519Key();
  other = await mpas.generateEd25519Key();
  envelope = {
    version: "1", type: "ActionEnvelope", proposer: { did: other.did },
    target: { applicationDid: "did:web:application.example" },
    executionProfile: { id: "did:web:profile.example" },
    executionPayloadHash: mpas.computeJsonHash(executionPayload),
    actionId: { value: "receipt-action", scope: "receipt-tests" },
    createdAt: "2026-09-01T11:00:00.000Z", expiresAt: "2026-09-01T13:00:00.000Z",
  };
});

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuerDid: issuer.did, actionEnvelopeHash: mpas.computeJsonHash(envelope),
    executionPayloadHash: mpas.computeJsonHash(executionPayload), actionId: envelope.actionId,
    proposerDid: envelope.proposer.did, result: "executed", issuedAt: new Date(now).toISOString(),
    executionRef: "echo:123", ...overrides,
  };
}

function options(overrides: Partial<mpas.ReceiptVerificationOptions> = {}): mpas.ReceiptVerificationOptions {
  return { actionEnvelope: envelope, executionPayload, authorizedIssuers: [{ did: issuer.did }], now, ...overrides };
}

/** Independent signer: does not use the receipt builder or verifier's JOSE path. */
function signed(
  body: Record<string, unknown> | string = payload(),
  header: Record<string, unknown> | string = { alg: "EdDSA", kid: issuer.kid },
  privateJwk: JWK = issuer.privateJwk,
): mpas.ExecutionReceipt {
  const input = [typeof header === "string" ? header : JSON.stringify(header), typeof body === "string" ? body : canonicalize(body)]
    .map(text => Buffer.from(text).toString("base64url")).join(".");
  const key = createPrivateKey({ key: privateJwk, format: "jwk" });
  return { version: "1", type: "ExecutionReceipt", format: "jws", signature: `${input}.${sign(null, Buffer.from(input), key).toString("base64url")}` };
}

async function rejects(
  receipt: unknown,
  code: mpas.ReceiptVerificationErrorCode,
  context: mpas.ReceiptVerificationOptions = options(),
): Promise<void> {
  const result = await mpas.verifyReceiptCanonical(receipt, context);
  expect(result).toMatchObject({ ok: false, error: { code, message: expect.any(String) } });
  expect(result).not.toHaveProperty("payload");
}

describe("verifyExecutionReceipt public contract", () => {
  it("exports the receipt verifier from the public package entry", () => {
    expect("verifyReceiptCanonical" in mpas).toBe(true);
  });

  it("verifies a complete independently signed receipt", async () => {
    expect(await mpas.verifyReceiptCanonical(signed(), options())).toEqual({ ok: true, payload: payload() });
  });

  it("verifies raw wrapper JSON and omitted optional fields", async () => {
    const body = payload();
    for (const field of ["actionId", "proposerDid", "executionRef"]) delete body[field];
    expect(await mpas.verifyReceiptCanonical(JSON.stringify(signed(body)), options())).toEqual({ ok: true, payload: body });
  });

  it.each(["executed", "rejected", "failed", "indeterminate", "expired", "cancelled", "revoked"])("supports Core outcome %s", async result => {
    expect(await mpas.verifyReceiptCanonical(signed(payload({ result })), options())).toMatchObject({ ok: true, payload: { result } });
  });

  it("accepts harmless JOSE metadata without deriving authority from its embedded key", async () => {
    const header = { alg: "EdDSA", kid: issuer.kid, typ: "application/mpas+json", cty: "application/json", jwk: other.publicJwk, example: "metadata" };
    expect(await mpas.verifyReceiptCanonical(signed(payload(), header), options())).toMatchObject({ ok: true });
  });

  it("resolves did:jwk from its embedded key rather than configured public parameters", async () => {
    const context = options({ authorizedIssuers: [{ did: issuer.did, publicJwk: { ...other.publicJwk, kid: issuer.kid } }] });
    expect(await mpas.verifyReceiptCanonical(signed(), context)).toMatchObject({ ok: true });
  });

  it.each(["record", "jwk"])("accepts authorized non-did:jwk with exact kid from %s", async source => {
    const did = "did:web:issuer.example";
    const kid = `${did}#receipt`;
    const record: mpas.TrustedSigner = { did, publicJwk: { ...issuer.publicJwk, kid: source === "jwk" ? kid : undefined }, ...(source === "record" ? { kid } : {}) };
    expect(await mpas.verifyReceiptCanonical(signed(payload({ issuerDid: did }), { alg: "EdDSA", kid }), options({ authorizedIssuers: [record] }))).toMatchObject({ ok: true });
  });

  it("supports distinct authorized rotation keys with exact key selection", async () => {
    const did = "did:web:issuer.example";
    const authorizedIssuers: mpas.TrustedSigner[] = [
      { did, publicJwk: { ...other.publicJwk, kid: `${did}#old` } },
      { did, publicJwk: { ...issuer.publicJwk, kid: `${did}#new` } },
    ];
    expect(await mpas.verifyReceiptCanonical(signed(payload({ issuerDid: did }), { alg: "EdDSA", kid: `${did}#new` }), options({ authorizedIssuers }))).toMatchObject({ ok: true });
  });

  it("preserves historical execution after current Action expiry", async () => {
    expect(await mpas.verifyReceiptCanonical(signed(), options({ now: now + 86400000 }))).toMatchObject({ ok: true });
  });

  it.each(["expired", "rejected", "cancelled", "revoked"])("accepts %s issued after Action expiry", async result => {
    const later = now + 86400000;
    expect(await mpas.verifyReceiptCanonical(signed(payload({ result, issuedAt: new Date(later).toISOString() })), options({ now: later }))).toMatchObject({ ok: true });
  });

  it("binds rejection to both expected objects even when their payload hashes disagree", async () => {
    const mismatched = { ...envelope, executionPayloadHash: mpas.computeJsonHash("different request") };
    const body = payload({ result: "rejected", actionEnvelopeHash: mpas.computeJsonHash(mismatched) });
    expect(await mpas.verifyReceiptCanonical(signed(body), options({ actionEnvelope: mismatched }))).toMatchObject({ ok: true });
  });

  it.each([
    ["version", "2"], ["type", "Approval"], ["format", "other"], ["signature", "bad.jws"],
    ["signature", "a.b.c="], ["payload", {}], ["extra", true],
  ])("rejects malformed wrapper field %s=%j", async (field, value) => {
    await rejects({ ...signed(), [field as string]: value }, "INVALID_RECEIPT");
  });

  it.each(["version", "type", "format", "signature"])("rejects missing wrapper %s", async field => {
    const receipt = { ...signed() } as Record<string, unknown>;
    delete receipt[field];
    await rejects(receipt, "INVALID_RECEIPT");
  });

  it.each([null, [], 7, "not json"])("rejects invalid wrapper %j without throwing", async receipt => {
    await rejects(receipt, "INVALID_RECEIPT");
  });

  it("rejects duplicate wrapper JSON members", async () => {
    await rejects(JSON.stringify(signed()).replace('"version":"1"', '"version":"1","version":"1"'), "INVALID_RECEIPT");
  });

  it("rejects duplicate protected header members", async () => {
    await rejects(signed(payload(), `{"alg":"EdDSA","alg":"EdDSA","kid":${JSON.stringify(issuer.kid)}}`), "INVALID_JWS_HEADER");
  });

  it.each(["none", "HS256", "ES256"])("rejects unsupported algorithm %s", async alg => {
    await rejects(signed(payload(), { alg, kid: issuer.kid }), "UNSUPPORTED_ALGORITHM");
  });

  it("requires protected alg", async () => {
    await rejects(signed(payload(), { kid: issuer.kid }), "INVALID_JWS_HEADER");
  });

  it.each([{ crit: ["example"], example: true }, { crit: [] }, { b64: false }])("rejects unsupported JOSE extension %j", async fields => {
    await rejects(signed(payload(), { alg: "EdDSA", kid: issuer.kid, ...fields }), "INVALID_JWS_HEADER");
  });

  it.each(["issuerDid", "actionEnvelopeHash", "executionPayloadHash", "result", "issuedAt"])("rejects missing payload field %s", async field => {
    const body = payload(); delete body[field];
    await rejects(signed(body), "INVALID_RECEIPT_PAYLOAD");
  });

  it.each([
    { extra: true }, { authorizationHash: "invented" }, { expiresAt: "invented" },
    { issuerDid: "not-a-did" }, { proposerDid: null }, { executionRef: 3 },
    { actionId: { value: "receipt-action", scope: "receipt-tests", extra: true } },
    { actionId: { value: "" } }, { actionId: { value: "receipt-action", scope: "" } },
    { actionEnvelopeHash: { alg: "sha-256", value: "hash", extra: true } },
    { executionPayloadHash: { alg: "sha-256", value: "hash", extra: true } },
    { executionPayloadHash: { alg: "md5", value: "hash" } },
    { executionPayloadHash: { alg: "sha-256", value: "not padded=" } },
    { executionRef: "lone\ud800" },
  ])("rejects malformed or undeclared signed payload %j", async override => {
    await rejects(signed(payload(override)), "INVALID_RECEIPT_PAYLOAD");
  });

  it("rejects duplicate payload members even with a correct signature", async () => {
    const text = canonicalize(payload()).replace('"result":"executed"', '"result":"executed","result":"executed"');
    await rejects(signed(text), "INVALID_RECEIPT_PAYLOAD");
  });

  it("rejects duplicate nested members even with a correct signature", async () => {
    const text = canonicalize(payload()).replace('"alg":"sha-256"', '"alg":"sha-256","alg":"sha-256"');
    await rejects(signed(text), "INVALID_RECEIPT_PAYLOAD");
  });

  it.each(["pending", "", 17, null])("rejects unsupported result %j", async result => {
    await rejects(signed(payload({ result })), "UNSUPPORTED_RESULT");
  });

  it("rejects noncanonical signed bytes", async () => {
    await rejects(signed(JSON.stringify(payload(), null, 2)), "NON_CANONICAL_RECEIPT_PAYLOAD");
  });

  it("rejects a signed UTF-8 BOM rather than stripping it before canonical validation", async () => {
    await rejects(signed(`\uFEFF${canonicalize(payload())}`), "INVALID_RECEIPT_PAYLOAD");
  });

  it("rejects a protected-header UTF-8 BOM rather than stripping it before strict parsing", async () => {
    await rejects(signed(payload(), `\uFEFF${JSON.stringify({ alg: "EdDSA", kid: issuer.kid })}`), "INVALID_JWS_HEADER");
  });

  it("rejects noncanonical signature pad bits even when the decoded signature is unchanged", async () => {
    const receipt = signed();
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = receipt.signature.slice(-1);
    await rejects({ ...receipt, signature: receipt.signature.slice(0, -1) + alphabet[alphabet.indexOf(last) + 1] }, "INVALID_RECEIPT");
  });

  it("rejects forged signatures under an authorized kid", async () => {
    await rejects(signed(payload(), { alg: "EdDSA", kid: issuer.kid }, other.privateJwk), "INVALID_SIGNATURE");
  });

  it.each(["executionRef", "result", "actionEnvelopeHash"])("rejects post-signature tampering of %s", async field => {
    const receipt = signed();
    const body = payload({ [field]: field === "actionEnvelopeHash" ? mpas.computeJsonHash("tampered") : field === "result" ? "failed" : "tampered" });
    const parts = receipt.signature.split("."); parts[1] = Buffer.from(canonicalize(body)).toString("base64url");
    await rejects({ ...receipt, signature: parts.join(".") }, "INVALID_SIGNATURE");
  });

  it("rejects a cryptographically valid but unauthorized issuer", async () => {
    await rejects(signed(payload({ issuerDid: other.did }), { alg: "EdDSA", kid: other.kid }, other.privateJwk), "UNAUTHORIZED_ISSUER");
  });

  it("rejects an issuer authorized for a different action, absent from this action's list", async () => {
    await rejects(signed(), "UNAUTHORIZED_ISSUER", options({ authorizedIssuers: [{ did: other.did }] }));
  });

  it("rejects a foreign issuer even if configured and embedded JWKs name the actual signing key", async () => {
    const receipt = signed(payload({ issuerDid: other.did }), { alg: "EdDSA", kid: other.kid, jwk: issuer.publicJwk });
    await rejects(receipt, "INVALID_SIGNATURE", options({ authorizedIssuers: [{ did: other.did, publicJwk: { ...issuer.publicJwk, kid: other.kid } }] }));
  });

  it.each([undefined, "", "unknown", "foreign"])("rejects missing, unknown or foreign protected kid: %s", async kid => {
    await rejects(signed(payload(), { alg: "EdDSA", kid: kid === "foreign" ? other.kid : kid }), "KEY_ID_MISMATCH");
  });

  it("rejects a conflicting configured did:jwk kid", async () => {
    await rejects(signed(), "KEY_ID_MISMATCH", options({ authorizedIssuers: [{ did: issuer.did, kid: other.kid }] }));
  });

  it.each(["unresolved", "missing-kid", "conflicting-kid", "conflicting-key"])("rejects non-did:jwk %s authority", async fault => {
    const did = "did:web:issuer.example"; const kid = `${did}#receipt`;
    const publicJwk = { ...issuer.publicJwk, kid: fault === "missing-kid" ? undefined : kid };
    let records: mpas.TrustedSigner[] = [{ did, publicJwk }];
    if (fault === "unresolved") records = [{ did, kid }];
    if (fault === "conflicting-kid") records[0].kid = `${did}#different`;
    if (fault === "conflicting-key") records.push({ did, publicJwk: { ...other.publicJwk, kid } });
    await rejects(signed(payload({ issuerDid: did }), { alg: "EdDSA", kid }), fault === "unresolved" || fault === "conflicting-key" ? "INVALID_ISSUER_KEY" : "KEY_ID_MISMATCH", options({ authorizedIssuers: records }));
  });

  it("rejects wrong trusted envelope including otherwise unexamined fields", async () => {
    await rejects(signed(), "ACTION_ENVELOPE_HASH_MISMATCH", options({ actionEnvelope: { ...envelope, target: { ...envelope.target, resource: "changed" } } }));
  });

  it("rejects wrong trusted payload", async () => {
    await rejects(signed(), "EXECUTION_PAYLOAD_HASH_MISMATCH", options({ executionPayload: { different: true } }));
  });

  it.each(["actionEnvelopeHash", "executionPayloadHash"])("rejects an independently signed wrong %s", async field => {
    await rejects(signed(payload({ [field]: mpas.computeJsonHash("different object") })), field === "actionEnvelopeHash" ? "ACTION_ENVELOPE_HASH_MISMATCH" : "EXECUTION_PAYLOAD_HASH_MISMATCH");
  });

  it.each([{ value: "different", scope: "receipt-tests" }, { value: "receipt-action", scope: "different" }, { value: "receipt-action" }])("compares complete Action ID %j", async actionId => {
    await rejects(signed(payload({ actionId })), "ACTION_ID_MISMATCH");
  });

  it("compares proposer identity", async () => {
    await rejects(signed(payload({ proposerDid: issuer.did })), "PROPOSER_MISMATCH");
  });

  it.each(["2026-02-30T00:00:00.000Z", "2026-02-29T00:00:00.000Z", "2026-09-01T12:00:00Z", "2026-09-01T12:00:00.000+00:00", "2026-09-01T24:00:00.000Z", "not-a-date", 0, null])("rejects invalid issuance %j", async issuedAt => {
    await rejects(signed(payload({ issuedAt })), "INVALID_RECEIPT_TIME");
  });

  it("rejects issuance beyond the trusted future tolerance", async () => {
    await rejects(signed(payload({ issuedAt: new Date(now + 101).toISOString() })), "RECEIPT_FROM_FUTURE", options({ timestampToleranceMs: 100 }));
  });

  it("accepts issuance exactly on the future tolerance boundary", async () => {
    expect(await mpas.verifyReceiptCanonical(signed(payload({ issuedAt: new Date(now + 100).toISOString() })), options({ timestampToleranceMs: 100 }))).toMatchObject({ ok: true });
  });

  it("rejects stale receipts only under a supplied age limit", async () => {
    await rejects(signed(), "RECEIPT_TOO_OLD", options({ now: now + 1001, maxAgeMs: 1000 }));
  });

  it("accepts exactly the maximum age plus tolerance", async () => {
    expect(await mpas.verifyReceiptCanonical(signed(), options({ now: now + 1100, maxAgeMs: 1000, timestampToleranceMs: 100 }))).toMatchObject({ ok: true });
  });

  it.each(["now", "timestampToleranceMs", "maxAgeMs"])("rejects all invalid numeric options for %s", async field => {
    for (const value of [NaN, Infinity, -Infinity, null, "0", ...(field === "now" ? [1e30] : [-1])]) {
      await rejects(signed(), "INVALID_TIME_OPTIONS", { ...options(), [field]: value } as mpas.ReceiptVerificationOptions);
    }
  });

  it("requires a nonempty action-specific issuer list", async () => {
    await rejects(signed(), "INVALID_VERIFICATION_OPTIONS", options({ authorizedIssuers: [] }));
  });

  it("captures caller bindings before awaiting cryptographic verification", async () => {
    const context = options({ actionEnvelope: structuredClone(envelope), authorizedIssuers: [{ did: issuer.did }] });
    const verification = mpas.verifyReceiptCanonical(signed(), context);
    context.actionEnvelope.actionId.value = "changed-after-call";
    context.authorizedIssuers = [{ did: other.did }];
    expect(await verification).toMatchObject({ ok: true });
  });
});
