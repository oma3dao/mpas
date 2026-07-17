// Types
export * from "./types/config.js";
export * from "./types/mcp.js";
export * from "./types/mpas.js";

// Utilities
export * from "./utils/hash.js";
export * from "./utils/strict-json.js";

// Protocol primitives — Proposer side
export * from "./lib/action-package-builder.js";
export * from "./lib/adapter-client.js";
export * from "./lib/approval-builder.js";
export * from "./lib/coordination-client.js";
export * from "./lib/key-manager.js";

// Protocol primitives — Verifier side
export * from "./lib/verification.js";
export * from "./lib/mcp-payload.js";
export {
  evaluatePolicy,
  type PolicyConfig,
  type PolicyEntry,
  type PolicyCondition,
  type ConditionSource,
  type ConditionOp,
  type PolicyResult,
  type UnsatisfiedThreshold,
  type Requirement,
  type ProposerOnlyRequirement,
  type AllOfRequirement,
  type AnyOfRequirement,
} from "./lib/policy-engine.js";
export {
  loadPlugin,
  validatePayloadAgainstPlugin,
  type LoadError,
  type LoadPluginResult,
  type OperationMatch,
  type PayloadValidationError,
  type PayloadValidationResult,
} from "./lib/plugin-loader.js";
export * from "./lib/receipt-builder.js";
export * from "./lib/auth-requirements-builder.js";
export * from "./lib/did-key.js";
export * from "./lib/trace.js";
