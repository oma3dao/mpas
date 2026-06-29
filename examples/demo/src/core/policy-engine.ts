import type { ActionPackage, Did, ExecutionPayload } from "./types.js";
import type { VerifiedApprovals } from "./verification.js";

export interface PolicyConfig {
  defaultPolicy: "allow" | "deny";
  rules: PolicyRule[];
  enabledOperations?: string[];
  resourceRestrictions?: ResourceRestrictions;
  eligibleSignersByRole?: Record<string, Did[]>;
}

export interface ResourceRestrictions {
  allowedRepositories?: string[];
  allowedOrganizations?: string[];
}

export interface PolicyRule {
  description?: string;
  match: {
    conditions: PolicyCondition[];
  };
  requirements: ThresholdPolicyRequirement;
}

export interface PolicyCondition {
  source: "executionPayload";
  path: string;
  op: "eq";
  value: unknown;
}

export interface ThresholdPolicyRequirement {
  type: "threshold";
  threshold: number;
  eligibleSignerGroup: string;
  decision?: "approve" | "propose" | "reject" | "abstain";
}

export interface UnsatisfiedRule {
  rule: PolicyRule;
  requiredRole: string;
  requiredDecision: string;
  threshold: number;
  found: number;
  eligibleSigners: Did[];
}

export type PolicyResult =
  | {
      status: "satisfied";
    }
  | {
      status: "additionalApprovalsRequired";
      unsatisfiedRules: UnsatisfiedRule[];
    }
  | {
      status: "denied";
      code: "OPERATION_DISABLED" | "RESOURCE_RESTRICTED" | "DEFAULT_DENY";
      message: string;
    };

export function evaluatePolicy(
  actionPackage: ActionPackage,
  verifiedApprovals: VerifiedApprovals,
  policy: PolicyConfig,
): PolicyResult {
  const operationName = getOperationName(actionPackage);
  if (policy.enabledOperations && (!operationName || !policy.enabledOperations.includes(operationName))) {
    return {
      status: "denied",
      code: "OPERATION_DISABLED",
      message: `Operation is not enabled: ${operationName ?? "<unknown>"}`,
    };
  }

  if (policy.resourceRestrictions && !checkResourceRestrictions(actionPackage.executionPayload, policy.resourceRestrictions)) {
    return {
      status: "denied",
      code: "RESOURCE_RESTRICTED",
      message: "Execution Payload references a restricted resource.",
    };
  }

  let matchedAnyRule = false;
  const proposerDid = actionPackage.actionEnvelope.proposer.did;
  for (const rule of policy.rules) {
    if (!rule.match.conditions.every((condition) => conditionMatches(actionPackage, condition))) {
      continue;
    }

    matchedAnyRule = true;
    const unsatisfied = evaluateRequirement(rule, verifiedApprovals, policy, proposerDid);
    if (unsatisfied) {
      return {
        status: "additionalApprovalsRequired",
        unsatisfiedRules: [unsatisfied],
      };
    }
  }

  if (!matchedAnyRule && policy.defaultPolicy === "deny") {
    return {
      status: "denied",
      code: "DEFAULT_DENY",
      message: "No policy rule matched and defaultPolicy is deny.",
    };
  }

  return { status: "satisfied" };
}

function evaluateRequirement(
  rule: PolicyRule,
  verifiedApprovals: VerifiedApprovals,
  policy: PolicyConfig,
  proposerDid?: string,
): UnsatisfiedRule | null {
  const decision = rule.requirements.decision ?? "approve";
  const found = verifiedApprovals.approvals.filter(
    (approval) =>
      approval.roles.includes(rule.requirements.eligibleSignerGroup) &&
      approval.decision === decision &&
      // Defense in depth: never count the proposer's own approval toward thresholds.
      approval.signerDid !== proposerDid,
  ).length;

  if (found >= rule.requirements.threshold) {
    return null;
  }

  return {
    rule,
    requiredRole: rule.requirements.eligibleSignerGroup,
    requiredDecision: decision,
    threshold: rule.requirements.threshold,
    found,
    eligibleSigners: policy.eligibleSignersByRole?.[rule.requirements.eligibleSignerGroup] ?? [],
  };
}

function conditionMatches(actionPackage: ActionPackage, condition: PolicyCondition): boolean {
  if (condition.source !== "executionPayload") {
    return false;
  }

  return getJsonPointerValue(actionPackage.executionPayload, condition.path) === condition.value;
}

export function checkResourceRestrictions(payload: ExecutionPayload, restrictions: ResourceRestrictions): boolean {
  const args = getJsonPointerValue(payload, "/arguments");
  if (!isRecord(args)) {
    return true;
  }

  const owner = typeof args.owner === "string" ? args.owner : undefined;
  const repo = typeof args.repo === "string" ? args.repo : undefined;

  if (restrictions.allowedOrganizations && owner && !restrictions.allowedOrganizations.includes(owner)) {
    return false;
  }

  if (restrictions.allowedRepositories && owner && repo) {
    return restrictions.allowedRepositories.includes(`${owner}/${repo}`);
  }

  return true;
}

function getOperationName(actionPackage: ActionPackage): string | undefined {
  const value = getJsonPointerValue(actionPackage.executionPayload, "/name");
  return typeof value === "string" ? value : undefined;
}

function getJsonPointerValue(value: unknown, pointer: string): unknown {
  if (pointer === "") {
    return value;
  }

  const parts = pointer.split("/").slice(1).map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let current = value;
  for (const part of parts) {
    if (!isRecord(current) && !Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
