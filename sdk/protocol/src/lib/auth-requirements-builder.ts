import type { UnsatisfiedThreshold } from "./policy-engine.js";
import type { ActionEnvelope, AuthorizationRequirements, Decision, Did } from "../types/mpas.js";
import { computeJsonHash } from "./verification.js";

/** Input for constructing Verifier-authored Authorization Requirements. */
export interface BuildAuthorizationRequirementsInput {
  /** Action Envelope whose exact hash the requirements authorize. */
  actionEnvelope: ActionEnvelope;
  /** Policy thresholds that remain unsatisfied. */
  unsatisfiedRules: UnsatisfiedThreshold[];
  /** DID of the Verifier that evaluated the Action. */
  verifierDid: Did;
}

/** Constructs Authorization Requirements from the unmet result of Verifier policy evaluation. */
export function buildAuthorizationRequirements(
  input: BuildAuthorizationRequirementsInput,
): AuthorizationRequirements;
/** @deprecated Use the input-object overload. */
export function buildAuthorizationRequirements(
  actionEnvelope: ActionEnvelope,
  unsatisfiedRules: UnsatisfiedThreshold[],
  verifierDid: Did,
): AuthorizationRequirements;
export function buildAuthorizationRequirements(
  inputOrEnvelope: BuildAuthorizationRequirementsInput | ActionEnvelope,
  legacyUnsatisfiedRules?: UnsatisfiedThreshold[],
  legacyVerifierDid?: Did,
): AuthorizationRequirements {
  const { actionEnvelope, unsatisfiedRules, verifierDid } = "actionEnvelope" in inputOrEnvelope
    ? inputOrEnvelope
    : {
        actionEnvelope: inputOrEnvelope,
        unsatisfiedRules: legacyUnsatisfiedRules ?? [],
        verifierDid: legacyVerifierDid as Did,
      };
  return {
    version: "1",
    type: "AuthorizationRequirements",
    actionEnvelopeHash: computeJsonHash(actionEnvelope),
    result: "additionalApprovalsRequired",
    verifier: {
      did: verifierDid,
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
    expiresAt: actionEnvelope.expiresAt,
  };
}
