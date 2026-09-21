import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compactVerify, importJWK, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { generateEd25519Key, verifyReceiptCanonical, type BuildAndSignExecutionReceiptInput, type GeneratedKey, type TrustedSigner } from "@oma3/mpas";
import { buildAndSignExecutionReceipt, buildAndSignReceipt } from "../../src/core/receipt-builder.js";
import { computeJsonHash } from "../../src/core/verification.js";
import type { ActionPackage, Did, ReceiptPayload } from "../../src/core/types.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

interface KeyFixture {
  did: Did;
  privateJwk: JWK;
  publicJwk: JWK;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

let actionPackage: ActionPackage;
let adapter: KeyFixture;
let foreign: GeneratedKey;

beforeAll(async () => {
  actionPackage = await readJson<ActionPackage>(join(fixturesDir, "core", "valid-no-approval-required.json"));
  adapter = await readJson<KeyFixture>(join(fixturesDir, "test-keys", "adapter.json"));
  foreign = await generateEd25519Key();
});

function receiptInput(overrides: Partial<BuildAndSignExecutionReceiptInput> = {}): BuildAndSignExecutionReceiptInput {
  return {
    actionEnvelope: actionPackage.actionEnvelope, executionPayload: actionPackage.executionPayload,
    result: { result: "executed" }, verifierDid: adapter.did, signingKey: adapter.privateJwk, ...overrides,
  };
}

describe("buildAndSignExecutionReceipt", () => {
  it("builds and signs a verifiable Execution Receipt", async () => {
    const actionPackage = await readJson<ActionPackage>(join(fixturesDir, "core", "valid-no-approval-required.json"));
    const adapter = await readJson<KeyFixture>(join(fixturesDir, "test-keys", "adapter.json"));

    const receipt = await buildAndSignExecutionReceipt({
      actionEnvelope: actionPackage.actionEnvelope,
      executionPayload: actionPackage.executionPayload,
      result: { result: "executed", executionRef: "echo:123" },
      verifierDid: adapter.did,
      signingKey: adapter.privateJwk,
    });

    expect(receipt).toMatchObject({
      version: "1",
      type: "ExecutionReceipt",
      format: "jws",
    });

    const publicKey = await importJWK(adapter.publicJwk, "EdDSA");
    const { payload, protectedHeader } = await compactVerify(receipt.signature, publicKey);
    const receiptPayload = JSON.parse(Buffer.from(payload).toString("utf8")) as ReceiptPayload;

    expect(protectedHeader.alg).toBe("EdDSA");
    expect(receiptPayload).toMatchObject({
      issuerDid: adapter.did,
      actionEnvelopeHash: computeJsonHash(actionPackage.actionEnvelope),
      executionPayloadHash: computeJsonHash(actionPackage.executionPayload),
      actionId: actionPackage.actionEnvelope.actionId,
      proposerDid: actionPackage.actionEnvelope.proposer.did,
      result: "executed",
      executionRef: "echo:123",
    });
    expect(receiptPayload.issuedAt).toEqual(expect.any(String));
  });

  it("rejects a foreign did:jwk issuer before returning a receipt", async () => {
    await expect(buildAndSignExecutionReceipt(receiptInput({ verifierDid: foreign.did }))).rejects.toThrow();
  });

  it("rejects mismatched public parameters on the private signing JWK", async () => {
    await expect(buildAndSignExecutionReceipt(receiptInput({ signingKey: { ...adapter.privateJwk, x: foreign.publicJwk.x } }))).rejects.toThrow();
  });

  it("rejects private material that does not match the authorized public key", async () => {
    await expect(buildAndSignExecutionReceipt(receiptInput({ signingKey: { ...adapter.privateJwk, d: foreign.privateJwk.d } }))).rejects.toThrow();
  });

  it.each(["unknown", "foreign"])("rejects invalid signing key identifier %s", async kid => {
    await expect(buildAndSignExecutionReceipt(receiptInput({ signingKey: { ...adapter.privateJwk, kid: kid === "foreign" ? foreign.kid : kid } }))).rejects.toThrow();
  });

  it("keeps the positional compatibility builder bound to a valid did:jwk", async () => {
    const input = receiptInput();
    const receipt = await buildAndSignReceipt(input.actionEnvelope, input.executionPayload, input.result, input.verifierDid, input.signingKey!);
    expect(await verifyReceiptCanonical(receipt, { actionEnvelope: input.actionEnvelope, executionPayload: input.executionPayload, authorizedIssuers: [{ did: adapter.did }] })).toMatchObject({ ok: true });
  });

  it("does not let the positional compatibility builder bypass issuer binding", async () => {
    const input = receiptInput();
    await expect(buildAndSignReceipt(input.actionEnvelope, input.executionPayload, input.result, foreign.did, input.signingKey!)).rejects.toThrow();
  });

  it("accepts non-did:jwk issuer when signer identity validates", async () => {
    // PR #80's signer framework validates identity via validateSignerIdentity;
    // non-did:jwk DIDs with matching keys are accepted when the signer can sign.
    const receipt = await buildAndSignExecutionReceipt(receiptInput({ verifierDid: "did:web:adapter.example", signingKey: { ...adapter.privateJwk, kid: "did:web:adapter.example#receipt" } }));
    expect(receipt).toHaveProperty("signature");
  });

  it("accepts explicitly authorized non-did:jwk issuer and matching key", async () => {
    const did = "did:web:adapter.example";
    const kid = `${did}#receipt`;
    const authorizedIssuer: TrustedSigner = { did, kid, publicJwk: { ...adapter.publicJwk, kid } };
    const input = receiptInput({ verifierDid: did, signingKey: { ...adapter.privateJwk, kid }, authorizedIssuer });
    const receipt = await buildAndSignExecutionReceipt(input);
    expect(await verifyReceiptCanonical(receipt, { actionEnvelope: input.actionEnvelope, executionPayload: input.executionPayload, authorizedIssuers: [authorizedIssuer] })).toMatchObject({ ok: true, payload: { issuerDid: did } });
  });

  it("rejects another issuer's trusted record", async () => {
    await expect(buildAndSignExecutionReceipt(receiptInput({ verifierDid: "did:web:adapter.example", authorizedIssuer: { did: foreign.did, publicJwk: adapter.publicJwk } }))).rejects.toThrow("INVALID_ISSUER_KEY");
  });

  it("rejects an authorizedIssuer whose DID does not match verifierDid", async () => {
    const did = "did:web:adapter.example";
    const kid = `${did}#receipt`;
    const input = receiptInput({ verifierDid: did, signingKey: { ...adapter.privateJwk, kid }, authorizedIssuer: { did: "did:web:other.example", kid, publicJwk: { ...adapter.publicJwk, kid } } });
    await expect(buildAndSignExecutionReceipt(input)).rejects.toThrow("INVALID_ISSUER_KEY");
  });

  it.each(["executed", "rejected", "failed", "indeterminate", "expired", "cancelled", "revoked"] as const)("keeps outcome %s intact", async result => {
    const input = receiptInput({ result: { result } });
    const receipt = await buildAndSignExecutionReceipt(input);
    expect(await verifyReceiptCanonical(receipt, { actionEnvelope: input.actionEnvelope, executionPayload: input.executionPayload, authorizedIssuers: [{ did: adapter.did }] })).toMatchObject({ ok: true, payload: { result } });
  });

  it("preserves rejection when the exact payload differs from the envelope's claim", async () => {
    const input = receiptInput({ executionPayload: { wrong: "payload" }, result: { result: "rejected" } });
    const receipt = await buildAndSignExecutionReceipt(input);
    expect(await verifyReceiptCanonical(receipt, { actionEnvelope: input.actionEnvelope, executionPayload: input.executionPayload, authorizedIssuers: [{ did: adapter.did }] })).toMatchObject({ ok: true, payload: { result: "rejected" } });
  });

  it("preserves an expiry receipt after the action has expired", async () => {
    const input = receiptInput({ actionEnvelope: { ...actionPackage.actionEnvelope, expiresAt: "2020-01-01T00:00:00.000Z" }, result: { result: "expired" } });
    const receipt = await buildAndSignExecutionReceipt(input);
    expect(await verifyReceiptCanonical(receipt, { actionEnvelope: input.actionEnvelope, executionPayload: input.executionPayload, authorizedIssuers: [{ did: adapter.did }] })).toMatchObject({ ok: true, payload: { result: "expired" } });
  });
});
