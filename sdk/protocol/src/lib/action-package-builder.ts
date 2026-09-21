import { randomUUID } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import type {
  ActionEnvelope,
  ActionPackage,
  AdditionalApprovalsAuthorizationRequirements,
  Approval,
  CanonicalApprovalPayload,
  Decision,
  Did,
  Hash,
  ExecutionPayload,
} from "../types/mpas.js";
import { computeJsonHash } from "../utils/hash.js";
import type { KeyManager } from "./key-manager.js";
import { signMpasCompactJws, validateSignerIdentity, type MpasJwsSigner } from "./signer.js";

/** Reusable configuration for constructing Proposer-authored Action Packages. */
export interface ActionPackageBuilderConfig {
  /** DID of the MPAS Application targeted by constructed Actions. */
  applicationDid: Did;
  /** Execution profile identifier and payload format placed in each Action Envelope. */
  executionProfile: {
    id: Did;
    format: string;
  };
  /** Proposer key used to derive the Proposer DID and sign the proposal Approval. */
  keyManager?: KeyManager;
  /** Shared signing capability; supply exactly one of signer or keyManager. */
  signer?: MpasJwsSigner;
  /** Default Action validity window. Defaults to 30 minutes. */
  defaultExpirationMinutes?: number;
  /** Initial Proposer decision. Core permits `propose` and `approve`; defaults to `propose`. */
  proposerDecision?: Extract<Decision, "propose" | "approve">;
  /** Profile-defined payload hashing. Defaults to JSON/JCS/SHA-256 for compatibility. */
  hashPayload?: (payload: ExecutionPayload) => Hash;
}

/** Builds complete, Proposer-signed Action Packages from MCP tool calls. */
export class ActionPackageBuilder {
  private readonly signer: MpasJwsSigner;
  private readonly defaultExpirationMinutes: number;
  private readonly proposerDecision: Extract<Decision, "propose" | "approve">;

  constructor(private readonly config: ActionPackageBuilderConfig) {
    if (Boolean(config.signer) === Boolean(config.keyManager)) throw new Error("Supply exactly one signer or keyManager.");
    this.signer = config.signer ?? config.keyManager!;
    validateSignerIdentity(this.signer);
    this.defaultExpirationMinutes = config.defaultExpirationMinutes ?? 30;
    if (this.defaultExpirationMinutes <= 0 || this.defaultExpirationMinutes > 24 * 60) {
      throw new RangeError("defaultExpirationMinutes must be greater than zero and at most 1440 minutes.");
    }
    this.proposerDecision = config.proposerDecision ?? "propose";
  }

  /** Builds and signs one complete Action Package for a tool name and arguments object. */
  async buildFromToolCall(toolName: string, args: object): Promise<ActionPackage> {
    return this.buildFromPayload(this.createPayload(toolName, args));



  }

  /** Builds and signs one complete Action Package from a profile-native payload. */
  async buildFromPayload(payload: ExecutionPayload): Promise<ActionPackage> {
    const envelope = this.createEnvelope(payload);
    const approval = await this.createProposerApproval(envelope);
    return this.createPackage(payload, envelope, approval);
  }

  /**
   * Retires an approvals-gated Action and constructs the replacement Action
   * whose Approvals will be collected through Coordination.
   *
   * The Execution Payload and execution target are preserved, while the
   * replacement receives a new Action ID, envelope hash, validity window, and
   * Proposer Approval. The returned Authorization Requirements are newly
   * Proposer-authored and bind to the replacement envelope.
   */
  async buildCoordinationReplacement(
    priorPackage: ActionPackage,
    verifierRequirements: AdditionalApprovalsAuthorizationRequirements,
  ): Promise<{
    actionPackage: ActionPackage;
    authorizationRequirements: AdditionalApprovalsAuthorizationRequirements;
  }> {
    if (priorPackage.actionEnvelope.proposer.did !== this.signer.did) {
      throw new Error("Cannot replace an Action authored by a different Proposer.");
    }
    const priorActionEnvelopeHash = computeJsonHash(priorPackage.actionEnvelope);
    if (
      verifierRequirements.actionEnvelopeHash.alg !== priorActionEnvelopeHash.alg ||
      verifierRequirements.actionEnvelopeHash.value !== priorActionEnvelopeHash.value
    ) {
      throw new Error("Verifier Authorization Requirements do not bind to the Action being replaced.");
    }

    const payload = structuredClone(priorPackage.executionPayload);
    const envelope = this.createReplacementEnvelope(priorPackage.actionEnvelope, payload);
    const approval = await this.createProposerApproval(envelope);
    const actionPackage = this.createPackage(payload, envelope, approval);
    const actionEnvelopeHash = computeJsonHash(envelope);
    const authorizationRequirements: AdditionalApprovalsAuthorizationRequirements = {
      version: "1",
      type: "AuthorizationRequirements",
      actionEnvelopeHash,
      result: "additionalApprovalsRequired",
      verifier: structuredClone(verifierRequirements.verifier),
      approvalRequirements: structuredClone(verifierRequirements.approvalRequirements),
      ...(verifierRequirements.policyRef !== undefined ? { policyRef: verifierRequirements.policyRef } : {}),
      createdAt: envelope.createdAt,
      expiresAt: envelope.expiresAt,
    };

    return { actionPackage, authorizationRequirements };
  }

  /** @deprecated Use {@link buildFromToolCall}; staged construction is not part of the canonical API. */
  buildPayload(toolName: string, args: object): ExecutionPayload {
    return this.createPayload(toolName, args);
  }

  /** @deprecated Use {@link buildFromToolCall}; staged construction is not part of the canonical API. */
  buildEnvelope(payload: ExecutionPayload): ActionEnvelope {
    return this.createEnvelope(payload);
  }

  /** @deprecated Use {@link buildFromToolCall}; staged construction is not part of the canonical API. */
  async signProposerApproval(envelope: ActionEnvelope): Promise<Approval> {
    return this.createProposerApproval(envelope);
  }

  /** @deprecated Use {@link buildFromToolCall}; staged construction is not part of the canonical API. */
  assemblePackage(payload: ExecutionPayload, envelope: ActionEnvelope, approval: Approval): ActionPackage {
    return this.createPackage(payload, envelope, approval);
  }

  private createPayload(toolName: string, args: object): ExecutionPayload {
    return {
      name: toolName,
      arguments: { ...args },
    };
  }

  private createEnvelope(payload: ExecutionPayload): ActionEnvelope {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.defaultExpirationMinutes * 60 * 1000);

    return {
      version: "1",
      type: "ActionEnvelope",
      proposer: {
        did: this.signer.did,
      },
      target: {
        applicationDid: this.config.applicationDid,
      },
      executionProfile: this.config.executionProfile,
      executionPayloadHash: (this.config.hashPayload ?? computeJsonHash)(payload),
      actionId: {
        value: `urn:uuid:${randomUUID()}`,
      },
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  private createReplacementEnvelope(prior: ActionEnvelope, payload: ExecutionPayload): ActionEnvelope {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.defaultExpirationMinutes * 60 * 1000);
    return {
      ...structuredClone(prior),
      executionPayloadHash: (this.config.hashPayload ?? computeJsonHash)(payload),
      actionId: { value: `urn:uuid:${randomUUID()}` },
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  private async createProposerApproval(envelope: ActionEnvelope): Promise<Approval> {
    const createdAt = new Date().toISOString();
    const actionEnvelopeHash = computeJsonHash(envelope);
    const approvalPayload: CanonicalApprovalPayload = {
      type: "ApprovalPayload",
      actionEnvelopeHash,
      decision: this.proposerDecision,
      signerDid: this.signer.did,
      createdAt,
    };
    const signature = await signMpasCompactJws(this.signer, Buffer.from(canonicalize(approvalPayload)));

    return {
      version: "1",
      type: "Approval",
      actionEnvelopeHash,
      decision: this.proposerDecision,
      signature: {
        format: "jws",
        value: signature,
      },
      createdAt,
    };
  }

  private createPackage(payload: ExecutionPayload, envelope: ActionEnvelope, approval: Approval): ActionPackage {
    const actionEnvelopeHash = computeJsonHash(envelope);
    const createdAt = new Date().toISOString();

    return {
      version: "1",
      type: "ActionPackage",
      executionPayload: payload,
      actionEnvelope: envelope,
      approvalBundle: {
        version: "1",
        type: "ApprovalBundle",
        actionEnvelopeHash,
        approvals: [approval],
        assembledBy: this.signer.did,
        createdAt,
      },
      createdAt,
    };
  }
}
