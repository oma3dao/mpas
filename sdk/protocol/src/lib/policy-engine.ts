/**
 * MPAS JSON Verifier Policy Engine
 *
 * Implements the policy evaluation semantics defined in mpas-profile-policy-json.md.
 *
 * Key behaviors:
 * - All matching policies apply (logical AND of their requirements).
 * - A matching reject entry overrides all matching positive requirements.
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

interface PolicyEntryBase {
  description?: string;
  match?: {
    conditions?: PolicyCondition[];
  };
}

export interface RequirementPolicyEntry extends PolicyEntryBase {
  reject?: false;
  requirements: Requirement;
}

export interface RejectPolicyEntry extends PolicyEntryBase {
  reject: true;
  requirements?: never;
}

export type PolicyEntry = RequirementPolicyEntry | RejectPolicyEntry;

export type PolicyConfigValidationResult =
  | { ok: true }
  | { ok: false; message: string };

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
  | { status: "rejected"; code: "ACTION_BLOCKED_BY_POLICY"; message: string }
  | { status: "additionalApprovalsRequired"; unsatisfiedRules: UnsatisfiedThreshold[] }
  /**
   * The Action Package (or policy) contains a value that prevents
   * deterministic evaluation — e.g. a numeric condition over a value that
   * cannot be parsed as a number. Per the JSON Verifier Policy Profile,
   * such packages are treated as malformed rather than silently matched
   * or unmatched.
   */
  | { status: "malformed"; code: "NUMERIC_CONDITION_UNPARSEABLE" | "POLICY_INVALID"; message: string };

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export type ProposerGateResult =
  | { allowed: true }
  | { allowed: false; code: "PROPOSER_NOT_AUTHORIZED"; message: string };

/**
 * Validates the executable subset of the MPAS JSON Verifier Policy Profile.
 *
 * TypeScript types alone are not validation: deployment policy arrives as
 * JSON, so a conforming adapter must reject malformed requirement expressions
 * before evaluating an Action Package. This function deliberately does not
 * apply an organization's approval policy; it only enforces profile shape and
 * deterministic requirement semantics.
 */
export function validatePolicyConfig(policy: PolicyConfig): PolicyConfigValidationResult {
  if (!isRecord(policy) || !isRecord(policy.signerGroups)) {
    return { ok: false, message: "Policy must define signerGroups." };
  }
  const rawPolicy = policy as unknown as Record<string, unknown>;
  if ("context" in rawPolicy && rawPolicy.context !== undefined && !isRecord(rawPolicy.context)) {
    return { ok: false, message: "Policy context must be an object." };
  }

  const signerGroups = policy.signerGroups;
  if (!isDidArray(signerGroups.all)) {
    return { ok: false, message: "Policy signerGroups.all must be a non-empty array of unique DIDs." };
  }

  for (const [groupName, signers] of Object.entries(signerGroups)) {
    if (!isDidArray(signers)) {
      return { ok: false, message: `Policy signerGroups.${groupName} must be a non-empty array of unique DIDs.` };
    }
  }

  const defaultError = validateRequirement(policy.defaultRequirement, signerGroups, "defaultRequirement");
  if (defaultError) return { ok: false, message: defaultError };

  if (policy.policies !== undefined) {
    if (!isRecord(policy.policies)) {
      return { ok: false, message: "Policy policies must be an object keyed by operation name." };
    }
    for (const [operation, entries] of Object.entries(policy.policies)) {
      if (!Array.isArray(entries)) {
        return { ok: false, message: `Policy policies.${operation} must be an array.` };
      }
      for (const [index, entry] of entries.entries()) {
        const entryError = validatePolicyEntry(entry, signerGroups, `policies.${operation}[${index}]`);
        if (entryError) return { ok: false, message: entryError };
      }
    }
  }

  return { ok: true };
}

function validatePolicyEntry(
  entry: unknown,
  signerGroups: Record<string, Did[]>,
  path: string,
): string | null {
  if (!isRecord(entry)) return `${path} must be an object.`;
  if (hasUnexpectedKeys(entry, ["reject", "description", "match", "requirements", "context"])) {
    return `${path} has unsupported fields.`;
  }
  const isReject = entry.reject === true;
  const hasRequirements = "requirements" in entry;
  if (isReject === hasRequirements) {
    return `${path} must contain either reject: true or requirements, but not both.`;
  }
  if (entry.reject !== undefined && entry.reject !== true && entry.reject !== false) {
    return `${path}.reject must be a boolean.`;
  }
  if (entry.description !== undefined && typeof entry.description !== "string") {
    return `${path}.description must be a string.`;
  }
  if (entry.context !== undefined && !isRecord(entry.context)) {
    return `${path}.context must be an object.`;
  }
  if (!isReject) {
    if (entry.reject === true) return `${path}.reject must be false when requirements are present.`;
    const requirementError = validateRequirement(entry.requirements, signerGroups, `${path}.requirements`);
    if (requirementError) return requirementError;
  }
  return validateMatch(entry.match, `${path}.match`);
}

function validateMatch(value: unknown, path: string): string | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return `${path} must be an object.`;
  if (hasUnexpectedKeys(value, ["conditions"])) return `${path} has unsupported fields.`;
  if (value.conditions !== undefined && !Array.isArray(value.conditions)) {
    return `${path}.conditions must be an array.`;
  }
  for (const [index, condition] of ((value.conditions as unknown[] | undefined) ?? []).entries()) {
    if (!isRecord(condition)) return `${path}.conditions[${index}] must be an object.`;
    if (hasUnexpectedKeys(condition, ["source", "path", "op", "value"])) {
      return `${path}.conditions[${index}] has unsupported fields.`;
    }
    if (condition.source !== "executionPayload" && condition.source !== "actionEnvelope") {
      return `${path}.conditions[${index}].source is invalid.`;
    }
    if (typeof condition.op !== "string" || !CONDITION_OPERATORS.has(condition.op as ConditionOp)) {
      return `${path}.conditions[${index}].op is invalid.`;
    }
    if (condition.op !== "exists" && condition.op !== "notExists" && typeof condition.path !== "string") {
      return `${path}.conditions[${index}].path is required.`;
    }
  }
  return null;
}

function validateRequirement(
  requirement: unknown,
  signerGroups: Record<string, Did[]>,
  path: string,
): string | null {
  if (!isRecord(requirement) || typeof requirement.type !== "string") {
    return `${path} must be an approval requirement object.`;
  }
  switch (requirement.type) {
    case "proposerOnly":
      return Object.keys(requirement).length === 1 ? null : `${path}.proposerOnly has unsupported fields.`;
    case "threshold": {
      if (hasUnexpectedKeys(requirement, ["type", "threshold", "eligibleSignerGroup", "eligibleSigners", "decision", "description"])) {
        return `${path}.threshold has unsupported fields.`;
      }
      if (!Number.isInteger(requirement.threshold) || (requirement.threshold as number) < 1) {
        return `${path}.threshold must be a positive integer.`;
      }
      const hasGroup = typeof requirement.eligibleSignerGroup === "string" && requirement.eligibleSignerGroup.length > 0;
      const hasSigners = isDidArray(requirement.eligibleSigners);
      if (hasGroup === hasSigners) {
        return `${path} must define exactly one of eligibleSignerGroup or eligibleSigners.`;
      }
      if (hasGroup && !signerGroups[requirement.eligibleSignerGroup as string]) {
        return `${path}.eligibleSignerGroup does not exist in signerGroups.`;
      }
      if (requirement.decision === "reject" ||
          (requirement.decision !== undefined && !["approve", "propose", "abstain"].includes(requirement.decision as string))) {
        return `${path}.decision is invalid.`;
      }
      if (requirement.description !== undefined && typeof requirement.description !== "string") {
        return `${path}.description must be a string.`;
      }
      return null;
    }
    case "allOf":
    case "anyOf": {
      if (hasUnexpectedKeys(requirement, ["type", "requirements"])) {
        return `${path}.${requirement.type} has unsupported fields.`;
      }
      if (!Array.isArray(requirement.requirements) || requirement.requirements.length === 0) {
        return `${path}.requirements must be a non-empty array.`;
      }
      for (const [index, nested] of requirement.requirements.entries()) {
        const nestedError = validateRequirement(nested, signerGroups, `${path}.requirements[${index}]`);
        if (nestedError) return nestedError;
      }
      return null;
    }
    default:
      return `${path}.type is invalid.`;
  }
}

const CONDITION_OPERATORS = new Set<ConditionOp>([
  "eq", "neq", "in", "notIn", "gt", "gte", "lt", "lte", "exists", "notExists", "contains", "prefix",
]);

function isDidArray(value: unknown): value is Did[] {
  return Array.isArray(value) && value.length > 0 && value.every((did) => typeof did === "string" && did.length > 0) &&
    new Set(value).size === value.length;
}

function hasUnexpectedKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).some((key) => !allowed.includes(key));
}

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
    try {
      for (const entry of policyEntries) {
        if (!entry.match?.conditions || entry.match.conditions.length === 0 || matchesConditions(entry.match.conditions, actionPackage)) {
          matchedEntries.push(entry);
        }
      }
    } catch (error) {
      if (error instanceof UnparseableNumericValueError) {
        return { status: "malformed", code: "NUMERIC_CONDITION_UNPARSEABLE", message: error.message };
      }
      throw error;
    }
  }

  // A matching reject entry is final and overrides all positive requirements.
  if (matchedEntries.some((entry) => entry.reject === true)) {
    return {
      status: "rejected",
      code: "ACTION_BLOCKED_BY_POLICY",
      message: `Action ${actionName ?? "(unknown)"} is blocked by policy.`,
    };
  }

  // Determine the effective requirement.
  let effectiveRequirement: Requirement;

  if (matchedEntries.length > 0) {
    // All matching entries apply — combine with allOf.
    const matchedRequirements = matchedEntries
      .filter((entry): entry is RequirementPolicyEntry => entry.reject !== true)
      .map((entry) => entry.requirements);
    if (matchedEntries.length === 1) {
      effectiveRequirement = matchedRequirements[0];
    } else {
      effectiveRequirement = {
        type: "allOf",
        requirements: matchedRequirements,
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
      // All nested requirements must be satisfied (vacuously true when empty).
      return (Array.isArray(requirement.requirements) ? requirement.requirements : []).flatMap((r) =>
        evaluateRequirement(r, verifiedApprovals, policy, proposerDid),
      );

    case "anyOf": {
      // An anyOf over zero requirements is unsatisfiable. Policy validation
      // should reject such policies at load time; evaluation fails closed.
      if (!Array.isArray(requirement.requirements) || requirement.requirements.length === 0) {
        return [unsatisfiableRequirement()];
      }
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
    }

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

  // Count distinct Signers, not Approvals: duplicate Approvals from the same
  // Signer MUST NOT be counted more than once for the same threshold
  // requirement (JSON Verifier Policy Profile §6.5).
  const found = new Set(
    verifiedApprovals.approvals
      .filter((approval) => {
        // Never count the proposer's own approval.
        if (approval.signerDid === proposerDid) return false;
        // Must have the required decision.
        if (approval.decision !== decision) return false;

        // Check DID membership in eligible set.
        return eligibleSet !== null && eligibleSet.has(approval.signerDid);
      })
      .map((approval) => approval.signerDid),
  ).size;

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

/** Synthetic unsatisfied entry for structurally unsatisfiable requirements (fail closed). */
function unsatisfiableRequirement(): UnsatisfiedThreshold {
  return {
    requirement: { type: "threshold", threshold: 1 },
    requiredRole: "(unsatisfiable requirement)",
    requiredDecision: "approve",
    threshold: 1,
    found: 0,
    eligibleSigners: [],
  };
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
      return toNumber(actual, condition) > toNumber(condition.value, condition);

    case "gte":
      return toNumber(actual, condition) >= toNumber(condition.value, condition);

    case "lt":
      return toNumber(actual, condition) < toNumber(condition.value, condition);

    case "lte":
      return toNumber(actual, condition) <= toNumber(condition.value, condition);

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

export class UnparseableNumericValueError extends Error {
  constructor(condition: PolicyCondition, value: unknown) {
    super(
      `Value at ${condition.source}${condition.path} (${JSON.stringify(value)}) cannot be parsed as a number for the "${condition.op}" comparison. ` +
        "Numeric conditions over unparseable values make the Action Package malformed (JSON Verifier Policy Profile §5.4).",
    );
    this.name = "UnparseableNumericValueError";
  }
}

function toNumber(value: unknown, condition: PolicyCondition): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (!Number.isNaN(n)) return n;
  }
  // A missing path evaluates false for non-existence operators per the
  // profile; undefined therefore short-circuits to "no match" rather than
  // malformed.
  if (value === undefined) return NaN;
  throw new UnparseableNumericValueError(condition, value);
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
