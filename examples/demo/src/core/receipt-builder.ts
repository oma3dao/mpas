import { CompactSign, importJWK, type JWK } from "jose";
import { canonicalize } from "json-canonicalize";
import type { ActionEnvelope, ExecutionPayload, ExecutionReceipt, ReceiptPayload, ReceiptResult } from "./types.js";
import { computeJsonHash } from "./verification.js";

export interface ReceiptBuildResult {
  result: ReceiptResult;
  executionRef?: string;
}

export async function buildAndSignReceipt(
  envelope: ActionEnvelope,
  payload: ExecutionPayload,
  result: ReceiptBuildResult,
  adapterDid: `did:${string}:${string}`,
  signingKey: JWK,
): Promise<ExecutionReceipt> {
  const receiptPayload: ReceiptPayload = {
    issuerDid: adapterDid,
    actionEnvelopeHash: computeJsonHash(envelope),
    executionPayloadHash: computeJsonHash(payload),
    actionId: envelope.actionId,
    proposerDid: envelope.proposer.did,
    result: result.result,
    issuedAt: new Date().toISOString(),
    executionRef: result.executionRef,
  };

  const key = await importJWK(signingKey, "EdDSA");
  const signature = await new CompactSign(Buffer.from(canonicalize(receiptPayload)))
    .setProtectedHeader({ alg: "EdDSA", kid: signingKey.kid })
    .sign(key);

  return {
    version: "1",
    type: "ExecutionReceipt",
    format: "jws",
    signature,
  };
}
