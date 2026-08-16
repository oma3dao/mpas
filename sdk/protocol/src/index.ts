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
export * from "./lib/rfc9421.js";

// Protocol primitives — Verifier side
export * from "./lib/verification.js";
export * from "./lib/mcp-tasks-extension.js";
export * from "./lib/mcp-tasks-server.js";
export * from "./lib/mpas-task-meta.js";
export * from "./lib/bridge-tasks.js";
// Workflow contract + engine are spec-compliance behavior with no storage
// dependency: the SDK ships the WorkflowStore interface and an in-memory
// reference. Durable stores (e.g. SQLite) are implementation-specific and
// live in the repository (examples/demo), not in this package.
export * from "./lib/workflow-store.js";
export * from "./lib/workflow-engine.js";
export * from "./lib/bridge-runtime.js";
export * from "./lib/mcp-payload.js";
export {
  evaluatePolicy,
  checkProposerAuthorization,
  validatePolicyConfig,
  UnparseableNumericValueError,
  type ProposerGateResult,
  type PolicyConfig,
  type PolicyEntry,
  type RequirementPolicyEntry,
  type RejectPolicyEntry,
  type PolicyCondition,
  type ConditionSource,
  type ConditionOp,
  type PolicyResult,
  type PolicyConfigValidationResult,
  type UnsatisfiedThreshold,
  type Requirement,
  type ProposerOnlyRequirement,
  type AllOfRequirement,
  type AnyOfRequirement,
} from "./lib/policy-engine.js";
export {
  loadPlugin,
  validatePayloadAgainstPlugin,
  applyFailClosedDefaults,
  type LoadError,
  type LoadPluginResult,
  type OperationMatch,
  type PayloadValidationError,
  type PayloadValidationResult,
} from "./lib/plugin-loader.js";
export * from "./lib/receipt-builder.js";
export * from "./lib/auth-requirements-builder.js";
export * from "./lib/did-jwk.js";
export * from "./lib/trace.js";
