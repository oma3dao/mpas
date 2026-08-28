import { CompactSign, importJWK, type JWK } from "jose";
import { canonicalize } from "json-canonicalize";
import type { ActionEnvelope, Did, ExecutionPayload, ExecutionReceipt, ReceiptPayload, ReceiptResult } from "../types/mpas.js";
import { computeJsonHash } from "./verification.js";

export interface ReceiptBuildResult {
  result: ReceiptResult;
  executionRef?: string;
}

/** Input for constructing and signing an MPAS Execution Receipt. */
export interface BuildAndSignExecutionReceiptInput {
  /** Action Envelope whose exact hash is bound into the receipt. */
  actionEnvelope: ActionEnvelope;
  /** Execution Payload whose exact hash is bound into the receipt. */
  executionPayload: ExecutionPayload;
  /** Authoritative execution outcome and optional downstream reference. */
  result: ReceiptBuildResult;
  /** DID of the Verifier that performed or authorized execution. */
  verifierDid: Did;
  /** Ed25519 private JWK used to produce the compact JWS receipt. */
  signingKey: JWK;
}

/**
 * Constructs and signs an MPAS Execution Receipt.
 *
 * The signed payload binds the Action Envelope, Execution Payload, Proposer,
 * Verifier, Action identity, and execution outcome.
 */
export async function buildAndSignExecutionReceipt(
  input: BuildAndSignExecutionReceiptInput,
): Promise<ExecutionReceipt> {
  const { actionEnvelope, executionPayload, result, verifierDid, signingKey } = input;
  const receiptPayload: ReceiptPayload = {
    issuerDid: verifierDid,
    actionEnvelopeHash: computeJsonHash(actionEnvelope),
    executionPayloadHash: computeJsonHash(executionPayload),
    actionId: actionEnvelope.actionId,
    proposerDid: actionEnvelope.proposer.did,
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

/** @deprecated Use {@link buildAndSignExecutionReceipt} with an input object. */
export async function buildAndSignReceipt(
  envelope: ActionEnvelope,
  payload: ExecutionPayload,
  result: ReceiptBuildResult,
  verifierDid: Did,
  signingKey: JWK,
): Promise<ExecutionReceipt> {
  return buildAndSignExecutionReceipt({
    actionEnvelope: envelope,
    executionPayload: payload,
    result,
    verifierDid,
    signingKey,
  });
}
