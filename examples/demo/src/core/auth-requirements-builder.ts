import type { UnsatisfiedThreshold } from "./policy-engine.js";
import type { ActionEnvelope, AuthorizationRequirements, Decision, Did } from "./types.js";
import { computeJsonHash } from "./verification.js";

export function buildAuthorizationRequirements(
  envelope: ActionEnvelope,
  unsatisfiedRules: UnsatisfiedThreshold[],
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
      anyOf: unsatisfiedRules.map((unsatisfied) => ({
        type: "threshold",
        threshold: unsatisfied.threshold,
        eligibleSigners: unsatisfied.eligibleSigners,
        decision: unsatisfied.requiredDecision as Decision,
        description:
          unsatisfied.requirement.description ??
          `Requires ${unsatisfied.threshold} ${unsatisfied.requiredRole} approval(s).`,
      })),
    },
    createdAt: new Date().toISOString(),
    expiresAt: envelope.expiresAt,
  };
}
