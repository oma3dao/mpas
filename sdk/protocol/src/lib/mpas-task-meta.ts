import { parseApprovalRequirements } from "./approval-requirements-schema.js";
import type { ActionPackage, ApprovalRequirements, HashObject } from "../types/mpas.js";
import type { WorkflowRecord } from "./workflow-store.js";

export interface MpasTaskMeta {
  version: "2";
  actionId: string;
  actionEnvelopeHash: HashObject;
  authorizationState: "submitted" | "authorization_required" | "pending" | "approvals_collected";
  disclosure: "transparent";
  requirements?: ApprovalRequirements;
  expiresAt: string;
}

export function buildMpasTaskMeta(record: WorkflowRecord): MpasTaskMeta {
  const pkg = actionPackageOf(record);
  const actionEnvelopeHash = pkg.approvalBundle.actionEnvelopeHash;
  if (
    actionEnvelopeHash?.alg !== "sha-256" ||
    typeof actionEnvelopeHash.value !== "string" ||
    actionEnvelopeHash.value !== record.actionEnvelopeHash
  ) {
    throw new Error(`Workflow ${record.taskId} has an inconsistent Action Envelope hash.`);
  }

  const authorizationState = authorizationStateOf(record);
  const requirements = authorizationState === "authorization_required" ? approvalRequirementsOf(record) : undefined;
  return {
    version: "2",
    actionId: record.actionId,
    actionEnvelopeHash: structuredClone(actionEnvelopeHash),
    authorizationState,
    disclosure: "transparent",
    ...(authorizationState === "authorization_required" && requirements !== undefined
      ? { requirements: structuredClone(requirements) }
      : {}),
    expiresAt: record.expiresAt,
  };
}

export function workflowProposerDid(record: WorkflowRecord): string {
  const did = actionPackageOf(record).actionEnvelope.proposer?.did;
  if (typeof did !== "string" || did.length === 0) {
    throw new Error(`Workflow ${record.taskId} has no proposer DID.`);
  }
  return did;
}

function authorizationStateOf(record: WorkflowRecord): MpasTaskMeta["authorizationState"] {
  switch (record.state) {
    case "created":
      return "submitted";
    case "awaitingApprovals":
    case "submittingToCoordination":
      return "authorization_required";
    case "readyForSubmission":
    case "submittingToVerifier":
      return "approvals_collected";
    case "awaitingVerifierResult":
      return "pending";
    default:
      throw new Error(`Cannot build active MPAS metadata for terminal workflow ${record.taskId}.`);
  }
}

function approvalRequirementsOf(record: WorkflowRecord): ApprovalRequirements | undefined {
  const value = record.authorizationRequirements;
  const requirements = typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>).approvalRequirements : undefined;
  try {
    return parseApprovalRequirements(requirements);
  } catch {
    throw new Error(`Workflow ${record.taskId} has invalid transparent approval requirements.`);
  }
}

function actionPackageOf(record: WorkflowRecord): ActionPackage {
  const value = record.actionPackage;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Workflow ${record.taskId} has no stored Action Package.`);
  }
  const pkg = value as Partial<ActionPackage>;
  if (!pkg.actionEnvelope || !pkg.approvalBundle) {
    throw new Error(`Workflow ${record.taskId} has an invalid stored Action Package.`);
  }
  return pkg as ActionPackage;
}
