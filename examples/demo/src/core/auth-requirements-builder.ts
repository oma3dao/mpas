import type { UnsatisfiedRule } from "./policy-engine.js";
import type { ActionEnvelope, AuthorizationRequirements, Decision, Did } from "./types.js";
import { computeJsonHash } from "./verification.js";

export function buildAuthorizationRequirements(
  envelope: ActionEnvelope,
  unsatisfiedRules: UnsatisfiedRule[],
  adapterDid: Did,
): AuthorizationRequirements {
  return {
    version: "1",
    type: "AuthorizationRequirements",
    actionEnvelopeHash: computeJsonHash(envelope),
    result: "additionalApprovalsRequired",
    verifier: {
      did: adapterDid,
    },
    approvalRequirements: {
      anyOf: unsatisfiedRules.map((unsatisfiedRule) => ({
        type: "threshold",
        threshold: unsatisfiedRule.threshold,
        eligibleSigners: unsatisfiedRule.eligibleSigners,
        decision: unsatisfiedRule.requiredDecision as Decision,
        description:
          unsatisfiedRule.rule.description ??
          `Requires ${unsatisfiedRule.threshold} ${unsatisfiedRule.requiredRole} approval(s).`,
      })),
    },
    createdAt: new Date().toISOString(),
    expiresAt: envelope.expiresAt,
  };
}
