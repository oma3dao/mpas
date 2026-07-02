import { compactVerify, importJWK, type JWK } from "jose";
import { canonicalize } from "json-canonicalize";
import type { ActionEnvelope, Approval, CanonicalApprovalPayload, Decision, HashObject } from "../types/mpas.js";
import { computeHash } from "../utils/hash.js";
import { KeyManager } from "./key-manager.js";

export interface ApprovalBuilderConfig {
  keyManager: KeyManager;
}

export class ApprovalBuilder {
  constructor(private readonly config: ApprovalBuilderConfig) {}

  async buildApproval(envelope: ActionEnvelope, decision: Extract<Decision, "approve" | "reject">): Promise<Approval> {
    const actionEnvelopeHash = computeHash(envelope);
    const createdAt = new Date().toISOString();
    const approvalPayload: CanonicalApprovalPayload = {
      type: "ApprovalPayload",
      actionEnvelopeHash,
      decision,
      signerDid: this.config.keyManager.did,
      createdAt,
    };
    const signature = await this.config.keyManager.sign(Buffer.from(canonicalize(approvalPayload)));

    return {
      version: "1",
      type: "Approval",
      actionEnvelopeHash,
      decision,
      signature: {
        format: "jws",
        value: signature,
      },
      createdAt,
    };
  }

  async verifyApproval(approval: Approval, signerPublicKey: JWK): Promise<boolean> {
    if (approval.signature.format !== "jws") {
      return false;
    }

    try {
      const keyManager = KeyManager.fromJwk(signerPublicKey);
      const key = await importJWK(keyManager.publicKey, "EdDSA");
      const verified = await compactVerify(approval.signature.value, key);
      const payload = JSON.parse(Buffer.from(verified.payload).toString("utf8")) as CanonicalApprovalPayload;

      return (
        hashesEqual(payload.actionEnvelopeHash, approval.actionEnvelopeHash) &&
        payload.decision === approval.decision &&
        payload.createdAt === approval.createdAt &&
        payload.signerDid === keyManager.did
      );
    } catch {
      return false;
    }
  }
}

function hashesEqual(left: HashObject, right: HashObject): boolean {
  return left.alg === right.alg && left.value === right.value;
}
