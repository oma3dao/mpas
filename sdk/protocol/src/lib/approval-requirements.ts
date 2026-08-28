import type { ApprovalRequirements, Decision, Did, ThresholdRequirement } from "../types/mpas.js";

/** One Signer's final decision for one Action Envelope. */
export interface SignerDecision {
  signerDid: Did;
  decision: Decision;
}

/** Deterministic coordination view of an approval expression. */
export type ApprovalRequirementsStatus = "satisfied" | "pending" | "unreachable";

/**
 * Evaluates whether immutable Signer decisions satisfy an approval expression,
 * could still satisfy it, or have made it unreachable.
 *
 * The first decision supplied for a Signer is final. Repeating that decision is
 * harmless; supplying a different decision for the same DID is invalid input.
 * Ordinary `anyOf` and `allOf` threshold paths are evaluated together. An
 * `overrideSigners` entry with matching `approve` or `reject` permission is also
 * honored as unilateral authority; an undecided approve override keeps an
 * otherwise unreachable expression pending.
 *
 * This is a coordination-state helper. A Verifier still performs authoritative
 * Approval verification and policy evaluation.
 *
 * @throws {Error} If one Signer has conflicting decisions in `decisions`.
 */
export function evaluateApprovalRequirements(
  requirements: ApprovalRequirements,
  decisions: Iterable<SignerDecision>,
): ApprovalRequirementsStatus {
  const decisionsBySigner = immutableDecisionMap(decisions);
  const overrides = requirements.overrideSigners ?? [];

  if (overrides.some((entry) =>
    entry.permissions.includes("reject") && decisionsBySigner.get(entry.signer) === "reject")) {
    return "unreachable";
  }
  if (overrides.some((entry) =>
    entry.permissions.includes("approve") && decisionsBySigner.get(entry.signer) === "approve")) {
    return "satisfied";
  }

  const anyOf = requirements.anyOf ?? [];
  const allOf = requirements.allOf ?? [];
  const anyOfSatisfied = anyOf.length === 0 || anyOf.some((entry) => thresholdStatus(entry, decisionsBySigner) === "satisfied");
  const allOfSatisfied = allOf.every((entry) => thresholdStatus(entry, decisionsBySigner) === "satisfied");
  if (anyOfSatisfied && allOfSatisfied) return "satisfied";

  const anyOfReachable = anyOf.length === 0 || anyOf.some((entry) => thresholdStatus(entry, decisionsBySigner) !== "unreachable");
  const allOfReachable = allOf.every((entry) => thresholdStatus(entry, decisionsBySigner) !== "unreachable");
  if (anyOfReachable && allOfReachable) return "pending";

  const pendingApproveOverride = overrides.some((entry) =>
    entry.permissions.includes("approve") && !decisionsBySigner.has(entry.signer));
  return pendingApproveOverride ? "pending" : "unreachable";
}

function immutableDecisionMap(decisions: Iterable<SignerDecision>): Map<Did, Decision> {
  const result = new Map<Did, Decision>();
  for (const entry of decisions) {
    const existing = result.get(entry.signerDid);
    if (existing !== undefined && existing !== entry.decision) {
      throw new Error(`Signer ${entry.signerDid} has conflicting decisions for one Action Envelope.`);
    }
    result.set(entry.signerDid, entry.decision);
  }
  return result;
}

function thresholdStatus(
  requirement: ThresholdRequirement,
  decisions: ReadonlyMap<Did, Decision>,
): ApprovalRequirementsStatus {
  const expected = requirement.decision ?? "approve";
  const eligible = new Set(requirement.eligibleSigners);
  let matching = 0;
  let undecided = 0;
  for (const did of eligible) {
    const decision = decisions.get(did);
    if (decision === expected) matching += 1;
    else if (decision === undefined) undecided += 1;
  }
  if (matching >= requirement.threshold) return "satisfied";
  return matching + undecided >= requirement.threshold ? "pending" : "unreachable";
}
