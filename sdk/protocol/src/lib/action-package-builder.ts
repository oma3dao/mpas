import { randomUUID } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import type {
  ActionEnvelope,
  ActionPackage,
  Approval,
  CanonicalApprovalPayload,
  Did,
  ExecutionPayload,
} from "../types/mpas.js";
import { computeHash } from "../utils/hash.js";
import { KeyManager } from "./key-manager.js";

export interface ActionPackageBuilderConfig {
  applicationDid: Did;
  executionProfile: {
    id: Did;
    format: string;
  };
  keyManager: KeyManager;
  defaultExpirationMinutes?: number;
}

export class ActionPackageBuilder {
  private readonly defaultExpirationMinutes: number;

  constructor(private readonly config: ActionPackageBuilderConfig) {
    this.defaultExpirationMinutes = config.defaultExpirationMinutes ?? 30;
  }

  async buildFromToolCall(toolName: string, args: object): Promise<ActionPackage> {
    const payload = this.buildPayload(toolName, args);
    const envelope = this.buildEnvelope(payload);
    const approval = await this.signProposerApproval(envelope);

    return this.assemblePackage(payload, envelope, approval);
  }

  buildPayload(toolName: string, args: object): ExecutionPayload {
    return {
      name: toolName,
      arguments: { ...args },
    };
  }

  buildEnvelope(payload: ExecutionPayload): ActionEnvelope {
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
      executionPayloadHash: computeHash(payload),
      actionId: {
        value: `urn:uuid:${randomUUID()}`,
      },
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async signProposerApproval(envelope: ActionEnvelope): Promise<Approval> {
    const createdAt = new Date().toISOString();
    const actionEnvelopeHash = computeHash(envelope);
    const approvalPayload: CanonicalApprovalPayload = {
      type: "ApprovalPayload",
      actionEnvelopeHash,
      decision: "propose",
      signerDid: this.config.keyManager.did,
      createdAt,
    };
    const signature = await this.config.keyManager.sign(Buffer.from(canonicalize(approvalPayload)));

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

  assemblePackage(payload: ExecutionPayload, envelope: ActionEnvelope, approval: Approval): ActionPackage {
    const actionEnvelopeHash = computeHash(envelope);
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
