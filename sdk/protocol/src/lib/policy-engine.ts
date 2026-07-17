/**
 * MPAS JSON Verifier Policy Engine
 *
 * Implements the policy evaluation semantics defined in mpas-profile-policy-json.md.
 *
 * Key behaviors:
 * - All matching policies apply (logical AND of their requirements).
 * - If no policy matches, defaultRequirement applies (defaults to proposerOnly).
 * - Explicit rules override defaultRequirement when they match.
 * - Requirements support recursive composition via allOf/anyOf.
 * - The proposer's own approval never counts toward thresholds (self-approval prevention).
 */

import type { ActionPackage, Did } from "../types/mpas.js";
import type { VerifiedApprovals } from "./verification.js";

// ---------------------------------------------------------------------------
// Requirement Types (per spec §5.5)
// ---------------------------------------------------------------------------

export interface ProposerOnlyRequirement {
  type: "proposerOnly";
}

export interface ThresholdRequirement {
  type: "threshold";
  threshold: number;
  eligibleSignerGroup?: string;
  eligibleSigners?: Did[];
  decision?: "approve" | "propose" | "reject" | "abstain";
  description?: string;
}

export interface AllOfRequirement {
  type: "allOf";
  requirements: Requirement[];
}

export interface AnyOfRequirement {
  type: "anyOf";
  requirements: Requirement[];
}

export type Requirement =
  | ProposerOnlyRequirement
  | ThresholdRequirement
  | AllOfRequirement
  | AnyOfRequirement;

// ---------------------------------------------------------------------------
// Policy Config (deployment-level, consumed by the adapter)
// ---------------------------------------------------------------------------

export interface PolicyConfig {
  defaultRequirement: Requirement;
  policies?: Record<string, PolicyEntry[]>;
  signerGroups?: Record<string, Did[]>;
}

export interface PolicyEntry {
  description?: string;
  match?: {
    conditions?: PolicyCondition[];
  };
  requirements: Requirement;
}

// ---------------------------------------------------------------------------
// Conditions (per spec §5.4)
// ---------------------------------------------------------------------------

export type ConditionSource = "executionPayload" | "actionEnvelope";

export type ConditionOp =
  | "eq"
  | "neq"
  | "in"
  | "notIn"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "exists"
  | "notExists"
  | "contains"
  | "prefix";

export interface PolicyCondition {
  source: ConditionSource;
  path: string;
  op: ConditionOp;
  value?: unknown;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface UnsatisfiedThreshold {
  requirement: ThresholdRequirement;
  requiredRole: string;
  requiredDecision: string;
  threshold: number;
  found: number;
  eligibleSigners: Did[];
}

export type PolicyResult =
  | { status: "satisfied" }
  | { status: "additionalApprovalsRequired"; unsatisfiedRules: UnsatisfiedThreshold[] }
  | { status: "denied"; code: "DEFAULT_DENY"; message: string };

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export type ProposerGateResult =
  | { allowed: true }
  | { allowed: false; code: "PROPOSER_NOT_AUTHORIZED"; message: string };

/**
 * Proposer gating (JSON Verifier Policy Profile): the Verifier MUST reject any
 * Action Package whose proposer DID is not recognized. If `signerGroups`
 * contains a `proposers` group, only those DIDs may submit; otherwise
 * `signerGroups.all` is the allowed proposer set. Gating always occurs before
 * policy evaluation and applies to every operation, including pass-through.
 */
export function checkProposerAuthorization(proposerDid: Did, policy: PolicyConfig): ProposerGateResult {
  const allowedProposers = policy.signerGroups?.proposers ?? policy.signerGroups?.all;
  if (!allowedProposers || allowedProposers.length === 0) {
    return {
      allowed: false,
      code: "PROPOSER_NOT_AUTHORIZED",
      message: "Policy defines no allowed proposer set (signerGroups.proposers or signerGroups.all).",
    };
  }
  if (!allowedProposers.includes(proposerDid)) {
    return {
      allowed: false,
      code: "PROPOSER_NOT_AUTHORIZED",
      message: `Proposer ${proposerDid} is not in the allowed proposer set.`,
    };
  }

  return { allowed: true };
}

export function evaluatePolicy(
  actionPackage: ActionPackage,
  verifiedApprovals: VerifiedApprovals,
  policy: PolicyConfig,
): PolicyResult {
  const proposerDid = actionPackage.actionEnvelope.proposer.did;

  // Determine the action name from the execution payload.
  const payload = actionPackage.executionPayload;
  const actionName = isRecord(payload) && typeof payload.name === "string" ? payload.name : undefined;

  // Look up the action name in the policies object (structural match by key).
  const policyEntries = actionName && policy.policies?.[actionName];

  // Collect all matching entries within the action's policy array.
  const matchedEntries: PolicyEntry[] = [];
  if (policyEntries) {
    for (const entry of policyEntries) {
      if (!entry.match?.conditions || entry.match.conditions.length === 0 || matchesConditions(entry.match.conditions, actionPackage)) {
        matchedEntries.push(entry);
      }
    }
  }

  // Determine the effective requirement.
  let effectiveRequirement: Requirement;

  if (matchedEntries.length > 0) {
    // All matching entries apply — combine with allOf.
    if (matchedEntries.length === 1) {
      effectiveRequirement = matchedEntries[0].requirements;
    } else {
      effectiveRequirement = {
        type: "allOf",
        requirements: matchedEntries.map((e) => e.requirements),
      };
    }
  } else {
    // No policy entry matched — use defaultRequirement.
    effectiveRequirement = policy.defaultRequirement;
  }

  // Evaluate the effective requirement tree.
  const unsatisfied = evaluateRequirement(effectiveRequirement, verifiedApprovals, policy, proposerDid);

  if (unsatisfied.length === 0) {
    return { status: "satisfied" };
  }

  return {
    status: "additionalApprovalsRequired",
    unsatisfiedRules: unsatisfied,
  };
}

/**
 * Recursively evaluates a requirement tree.
 * Returns an array of unsatisfied threshold requirements (empty if satisfied).
 */
function evaluateRequirement(
  requirement: Requirement,
  verifiedApprovals: VerifiedApprovals,
  policy: PolicyConfig,
  proposerDid?: string,
): UnsatisfiedThreshold[] {
  switch (requirement.type) {
    case "proposerOnly":
      // Proposer's valid approval is sufficient — always satisfied at this level.
      // (The proposer's envelope signature was verified upstream.)
      return [];

    case "threshold":
      return evaluateThreshold(requirement, verifiedApprovals, policy, proposerDid);

    case "allOf":
      // All nested requirements must be satisfied.
      return requirement.requirements.flatMap((r) =>
        evaluateRequirement(r, verifiedApprovals, policy, proposerDid),
      );

    case "anyOf":
      // At least one nested requirement must be fully satisfied.
      for (const r of requirement.requirements) {
        const result = evaluateRequirement(r, verifiedApprovals, policy, proposerDid);
        if (result.length === 0) {
          return []; // This branch is satisfied.
        }
      }
      // None satisfied — return the unsatisfied from the first branch as representative.
      // (The operator can see what's needed for any path.)
      return evaluateRequirement(requirement.requirements[0], verifiedApprovals, policy, proposerDid);

    default:
      return [];
  }
}

function evaluateThreshold(
  requirement: ThresholdRequirement,
  verifiedApprovals: VerifiedApprovals,
  policy: PolicyConfig,
  proposerDid?: string,
): UnsatisfiedThreshold[] {
  if (requirement.threshold === 0) {
    return [];
  }

  const decision = requirement.decision ?? "approve";
  const eligibleSigners = resolveEligibleSigners(requirement, policy);
  // DID comparison is exact string match on canonical form (DID Core: the
  // method-specific identifier is case-sensitive). Normalization, if any, is
  // an ingest concern — never a comparison-time concern.
  const eligibleSet = eligibleSigners.length > 0 ? new Set<string>(eligibleSigners) : null;

  const found = verifiedApprovals.approvals.filter((approval) => {
    // Never count the proposer's own approval.
    if (approval.signerDid === proposerDid) return false;
    // Must have the required decision.
    if (approval.decision !== decision) return false;

    // Check DID membership in eligible set.
    return eligibleSet !== null && eligibleSet.has(approval.signerDid);
  }).length;

  if (found >= requirement.threshold) {
    return [];
  }

  return [
    {
      requirement,
      requiredRole: requirement.eligibleSignerGroup ?? "unknown",
      requiredDecision: decision,
      threshold: requirement.threshold,
      found,
      eligibleSigners,
    },
  ];
}

/**
 * Resolves eligible signers for a threshold requirement.
 * Checks eligibleSigners (inline) first, then eligibleSignerGroup in signerGroups.
 */
function resolveEligibleSigners(requirement: ThresholdRequirement, policy: PolicyConfig): Did[] {
  // Inline eligible signers take precedence.
  if (requirement.eligibleSigners && requirement.eligibleSigners.length > 0) {
    return requirement.eligibleSigners;
  }

  if (!requirement.eligibleSignerGroup) {
    return [];
  }

  // Look up signerGroups (plain DID arrays).
  return policy.signerGroups?.[requirement.eligibleSignerGroup] ?? [];
}

// ---------------------------------------------------------------------------
// Condition matching
// ---------------------------------------------------------------------------

function matchesConditions(conditions: PolicyCondition[], actionPackage: ActionPackage): boolean {
  return conditions.every((condition) => conditionMatches(condition, actionPackage));
}

function conditionMatches(condition: PolicyCondition, actionPackage: ActionPackage): boolean {
  const source = condition.source === "actionEnvelope"
    ? actionPackage.actionEnvelope
    : actionPackage.executionPayload;

  const actual = getJsonPointerValue(source, condition.path);

  switch (condition.op) {
    case "eq":
      return actual === condition.value;

    case "neq":
      return actual !== condition.value;

    case "in":
      return Array.isArray(condition.value) && condition.value.includes(actual);

    case "notIn":
      return Array.isArray(condition.value) && !condition.value.includes(actual);

    case "gt":
      return toNumber(actual) > toNumber(condition.value);

    case "gte":
      return toNumber(actual) >= toNumber(condition.value);

    case "lt":
      return toNumber(actual) < toNumber(condition.value);

    case "lte":
      return toNumber(actual) <= toNumber(condition.value);

    case "exists":
      return actual !== undefined;

    case "notExists":
      return actual === undefined;

    case "contains":
      return Array.isArray(actual) && actual.includes(condition.value);

    case "prefix":
      return typeof actual === "string" && typeof condition.value === "string" && actual.startsWith(condition.value);

    default:
      return false;
  }
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isNaN(n) ? -Infinity : n;
  }
  return -Infinity;
}

// ---------------------------------------------------------------------------
// JSON Pointer resolution (RFC 6901)
// ---------------------------------------------------------------------------

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
