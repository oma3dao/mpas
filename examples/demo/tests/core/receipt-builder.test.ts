import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compactVerify, importJWK, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { buildAndSignReceipt } from "../../src/core/receipt-builder.js";
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

describe("buildAndSignReceipt", () => {
  it("builds and signs a verifiable Execution Receipt", async () => {
    const actionPackage = await readJson<ActionPackage>(join(fixturesDir, "core", "valid-no-approval-required.json"));
    const adapter = await readJson<KeyFixture>(join(fixturesDir, "test-keys", "adapter.json"));

    const receipt = await buildAndSignReceipt(
      actionPackage.actionEnvelope,
      actionPackage.executionPayload,
      { result: "executed", executionRef: "echo:123" },
      adapter.did,
      adapter.privateJwk,
    );

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
});
