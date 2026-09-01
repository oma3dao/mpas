import { randomUUID } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import type {
  ActionEnvelope,
  ActionPackage,
  AdditionalApprovalsAuthorizationRequirements,
  Approval,
  CanonicalApprovalPayload,
  Did,
  ExecutionPayload,
} from "../types/mpas.js";
import { computeJsonHash } from "../utils/hash.js";
import { KeyManager } from "./key-manager.js";

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
  keyManager: KeyManager;
  /** Default Action validity window. Defaults to 30 minutes. */
  defaultExpirationMinutes?: number;
}

/** Builds complete, Proposer-signed Action Packages from MCP tool calls. */
export class ActionPackageBuilder {
  private readonly defaultExpirationMinutes: number;

  constructor(private readonly config: ActionPackageBuilderConfig) {
    this.defaultExpirationMinutes = config.defaultExpirationMinutes ?? 30;
  }

  /** Builds and signs one complete Action Package for a tool name and arguments object. */
  async buildFromToolCall(toolName: string, args: object): Promise<ActionPackage> {
    const payload = this.createPayload(toolName, args);
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
    if (priorPackage.actionEnvelope.proposer.did !== this.config.keyManager.did) {
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
        did: this.config.keyManager.did,
      },
      target: {
        applicationDid: this.config.applicationDid,
      },
      executionProfile: this.config.executionProfile,
      executionPayloadHash: computeJsonHash(payload),
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
      executionPayloadHash: computeJsonHash(payload),
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
      decision: "propose",
      signerDid: this.config.keyManager.did,
      createdAt,
    };
    const signature = await this.config.keyManager.signCompactJws(Buffer.from(canonicalize(approvalPayload)));

    return {
      version: "1",
      type: "Approval",
      actionEnvelopeHash,
      decision: "propose",
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
        assembledBy: this.config.keyManager.did,
        createdAt,
      },
      createdAt,
    };
  }
}
