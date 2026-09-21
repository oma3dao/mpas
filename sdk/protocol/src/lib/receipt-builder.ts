import type { JWK } from "jose";
import { KeyManager } from "./key-manager.js";
import { signMpasCompactJws, validateSignerIdentity, type MpasJwsSigner } from "./signer.js";
import { canonicalize } from "json-canonicalize";
import type { ActionEnvelope, Did, ExecutionPayload, ExecutionReceipt, ReceiptPayload, ReceiptResult } from "../types/mpas.js";
import { computeJsonHash, type TrustedSigner } from "./verification.js";

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
  /** Compatibility input: constructs a local signer. Supply exactly one input. */
  signingKey?: JWK;
  /** Shared signer, including non-exporting providers. */
  signer?: MpasJwsSigner;
  /** Trusted issuer/key binding; required for DID methods other than did:jwk. */
  authorizedIssuer?: TrustedSigner;
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
  if (Boolean(input.signer) === Boolean(signingKey)) throw new Error("Supply exactly one signer or signingKey.");
  const signer = input.signer ?? KeyManager.fromJwk(signingKey!, { did: verifierDid });
  validateSignerIdentity(signer);
  if (signer.did !== verifierDid) throw new Error("Receipt signer does not match verifierDid.");
  // Validate the authorizedIssuer if provided.
  if (input.authorizedIssuer && input.authorizedIssuer.did !== verifierDid) {
    throw new Error("INVALID_ISSUER_KEY: Authorized issuer DID must match the receipt's verifierDid.");
  }
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

  let signature: string;
  try {
    signature = await signMpasCompactJws(signer, Buffer.from(canonicalize(receiptPayload)));
  } catch {
    throw new Error("INVALID_SIGNATURE: The supplied private key cannot sign a receipt for this issuer.");
  }

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
