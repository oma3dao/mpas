/**
 * Re-exports all policy engine primitives from @oma3/mpas.
 * This file exists so that existing imports from "../core/policy-engine.js" continue to work.
 */
export {
  evaluatePolicy,
  checkProposerAuthorization,
} from "@oma3/mpas/policy-engine";

export type {
  ProposerGateResult,
  PolicyConfig,
  PolicyEntry,
  RequirementPolicyEntry,
  RejectPolicyEntry,
  PolicyCondition,
  ConditionSource,
  ConditionOp,
  PolicyResult,
  UnsatisfiedThreshold,
  Requirement,
  ProposerOnlyRequirement,
  ThresholdRequirement,
  AllOfRequirement,
  AnyOfRequirement,
} from "@oma3/mpas/policy-engine";
