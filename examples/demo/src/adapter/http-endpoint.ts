import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { JWK } from "jose";
import { buildAuthorizationRequirements } from "../core/auth-requirements-builder.js";
import { evaluatePolicy, checkResourceRestrictions, type PolicyConfig } from "../core/policy-engine.js";
import { validatePayloadAgainstPlugin } from "../core/plugin-loader.js";
import { buildAndSignReceipt } from "../core/receipt-builder.js";
import type { ActionPackage, Did, ExecutionReceipt, Hash, ReceiptResult } from "../core/types.js";
import { TraceLogger } from "../core/trace.js";
import {
  DEFAULT_MAX_ENVELOPE_VALIDITY_MS,
  computeJsonHash,
  exceedsMaxEnvelopeValidity,
  isEnvelopeExpired,
  parseActionPackage,
  validateActionEnvelope,
  verifyActionPackage,
} from "../core/verification.js";
import { DispatchLedger } from "./dispatch-ledger.js";
import type { LoadedDeploymentConfig } from "./config-loader.js";
import type { FileCredentialProvider } from "./credential-provider.js";
import { prepareMcpHttp } from "./dispatch/mcp-http.js";
import { prepareMcpStdio, type DispatchPrepareResult, type McpDispatchResult } from "./dispatch/mcp-stdio.js";

export interface HttpEndpointOptions {
  configsByApplicationDid: Map<Did, LoadedDeploymentConfig>;
  credentialProvider: FileCredentialProvider;
  adapterDid: Did;
  adapterSigningKey: JWK;
  ledger?: DispatchLedger;
  maxEnvelopeValidityMs?: number;
  traceLogger?: TraceLogger;
}

export function createHttpEndpoint(options: HttpEndpointOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const ledger = options.ledger ?? new DispatchLedger();
  const maxEnvelopeValidityMs = options.maxEnvelopeValidityMs ?? DEFAULT_MAX_ENVELOPE_VALIDITY_MS;
  const trace = options.traceLogger ?? new TraceLogger("adapter");

  // Accept the canonical MPAS media type as well as application/json (profile MAY).
  app.addContentTypeParser("application/mpas+json", { parseAs: "string" }, (_request, body, done) => {
    try {
      done(null, body === "" ? undefined : JSON.parse(body as string));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  app.get("/mpas/v1/health", async () => ({
    status: "ok",
    loadedConfigs: Array.from(options.configsByApplicationDid.values()).map((entry) => ({
      name: entry.config.name,
      applicationDid: entry.config.target.applicationDid,
    })),
  }));

  app.post("/mpas/v1/action", async (request, reply) => {
    // The submission body is an ActionRequest wrapping the Action Package.
    const actionPackage = unwrapActionPackage(request.body);

    // Cannot parse far enough to compute actionEnvelopeHash -> 400 MpasHttpError.
    const parseResult = parseActionPackage(actionPackage);
    if (!parseResult.ok) {
      trace.emit("incoming_action", { endpoint: "/mpas/v1/action", result: "parse_error", error: parseResult.error.message });
      return mpasHttpError(reply, 400, "artifact_malformed", parseResult.error.message);
    }

    const pkg = parseResult.actionPackage;
    const envelopeHash = computeJsonHash(pkg.actionEnvelope);
    const actionId = pkg.actionEnvelope.actionId.value;

    trace.emit("incoming_action", {
      actionId,
      endpoint: "/mpas/v1/action",
      did: pkg.actionEnvelope.proposer.did,
      applicationDid: pkg.actionEnvelope.target.applicationDid,
      actionEnvelopeHash: envelopeHash.value,
    });

    // Structural validation (no expiry — the ledger check must run before any
    // stateless expiry rejection). A hashable-but-malformed package is a 200 result.
    const structural = validateActionEnvelope(pkg.actionEnvelope, { checkExpiry: false });
    if (!structural.ok) {
      trace.emit("verification_step", { actionId, step: "structural_validation", passed: false, code: structural.error.code });
      return actionResponse(options, { result: "malformed", actionEnvelopeHash: envelopeHash, error: { code: structural.error.code, message: structural.error.message } });
    }
    trace.emit("verification_step", { actionId, step: "structural_validation", passed: true });

    // Action Lifecycle: dispatch-ledger check. An actionId already in the ledger is
    // never dispatched again.
    const ledgerCheck = ledger.check(pkg.actionEnvelope.actionId, envelopeHash.value);
    if (ledgerCheck.kind === "pending") {
      trace.emit("dispatch", { actionId, result: "pending", reason: "ledger_pending" });
      return actionResponse(options, { result: "pending", actionEnvelopeHash: envelopeHash });
    }
    if (ledgerCheck.kind === "reject") {
      trace.emit("dispatch", { actionId, result: "rejected", reason: "ledger_reject", code: ledgerCheck.code });
      return rejection(pkg, options, envelopeHash, "rejected", ledgerCheck.code, ledgerCheck.message);
    }

    const loadedConfig = options.configsByApplicationDid.get(pkg.actionEnvelope.target.applicationDid);
    if (!loadedConfig) {
      trace.emit("dispatch", { actionId, result: "rejected", code: "UNKNOWN_APPLICATION" });
      return rejection(pkg, options, envelopeHash, "rejected", "UNKNOWN_APPLICATION", "Unknown application.");
    }

    // Stateless deterministic rejections (record nothing, repeatable verdict).
    if (isEnvelopeExpired(pkg.actionEnvelope)) {
      trace.emit("verification_step", { actionId, step: "expiry_check", passed: false });
      return rejection(pkg, options, envelopeHash, "expired", "EXPIRED_ACTION_ENVELOPE", "Action Envelope is expired.");
    }
    trace.emit("verification_step", { actionId, step: "expiry_check", passed: true });

    if (exceedsMaxEnvelopeValidity(pkg.actionEnvelope, maxEnvelopeValidityMs)) {
      trace.emit("verification_step", { actionId, step: "max_validity_check", passed: false });
      return actionResponse(options, {
        result: "rejected",
        actionEnvelopeHash: envelopeHash,
        error: { code: "ENVELOPE_VALIDITY_TOO_LONG", message: "Action Envelope validity window exceeds the maximum permitted by this Verifier." },
      });
    }
    trace.emit("verification_step", { actionId, step: "max_validity_check", passed: true });

    const verification = await verifyActionPackage(pkg, {
      trustedSigners: loadedConfig.config.signerKeys,
      trustedApplicationDids: [loadedConfig.config.target.applicationDid],
      onStep: (step, passed, details) => {
        trace.emit("verification_step", { actionId, step, passed, ...details });
      },
    });
    if (verification.status !== "verified") {
      trace.emit("dispatch", { actionId, result: "rejected", code: verification.code });
      const result: ReceiptResult = verification.code === "EXPIRED_ACTION_ENVELOPE" ? "expired" : "rejected";
      return rejection(pkg, options, envelopeHash, result, verification.code, verification.message);
    }

    const payloadValidation = validatePayloadAgainstPlugin(pkg.executionPayload, loadedConfig.plugin);
    const opName = operationName(pkg);
    const inPolicy = opName !== undefined && loadedConfig.config.policy.policies?.[opName] !== undefined;
    const isGovernedOperation = payloadValidation.ok || payloadValidation.error.code !== "UNKNOWN_OPERATION" || inPolicy;

    // --- Routing decision: governed vs. pass-through ---
    // If the operation IS in the plugin → full governance (schema validation + policy).
    // If the operation is NOT in the plugin → pass-through (skip schema + policy, just proxy credential).
    if (isGovernedOperation) {
      // Governed path: validate schema and evaluate policy.
      if (!payloadValidation.ok) {
        trace.emit("verification_step", { actionId, step: "plugin_validation", passed: false, code: payloadValidation.error.code });
        return rejection(pkg, options, envelopeHash, "rejected", payloadValidation.error.code, payloadValidation.error.message);
      }
      trace.emit("verification_step", { actionId, step: "plugin_validation", passed: true });

      const policyResult = evaluatePolicy(pkg, verification.verifiedApprovals, policyFromLoadedConfig(loadedConfig));
      if (policyResult.status === "denied") {
        trace.emit("verification_step", { actionId, step: "policy_evaluation", passed: false, code: policyResult.code });
        return rejection(pkg, options, envelopeHash, "rejected", policyResult.code, policyResult.message);
      }
      if (policyResult.status === "additionalApprovalsRequired") {
        trace.emit("dispatch", { actionId, result: "additionalApprovalsRequired" });
        return actionResponse(options, {
          result: "additionalApprovalsRequired",
          actionEnvelopeHash: envelopeHash,
          authorizationRequirements: buildAuthorizationRequirements(pkg.actionEnvelope, policyResult.unsatisfiedRules, options.adapterDid),
        });
      }
      trace.emit("verification_step", { actionId, step: "policy_evaluation", passed: true, policyStatus: policyResult.status });
    } else {
      // Pass-through path: operation is not in the plugin, skip schema validation
      // and policy evaluation. Still check resource restrictions below.
      trace.emit("verification_step", { actionId, step: "routing_decision", passed: true, path: "pass-through", operation: operationName(pkg) });

      // Resource restrictions apply to pass-through operations too.
      if (loadedConfig.config.resourceRestrictions) {
        if (!checkResourceRestrictions(pkg.executionPayload, loadedConfig.config.resourceRestrictions)) {
          trace.emit("verification_step", { actionId, step: "resource_restrictions", passed: false });
          return rejection(pkg, options, envelopeHash, "rejected", "RESOURCE_RESTRICTED", "Execution Payload references a restricted resource.");
        }
      }
    }

    // Authorized. Fallible, side-effect-free preparation happens BEFORE the ledger
    // write (Action Lifecycle addition A): credential resolution then target launch.
    // Failures here are stateless rejections — nothing recorded, no receipt.
    const credentialHandle = loadedConfig.config.credentialBindings[0]?.credentialHandle;
    const credential = credentialHandle ? await options.credentialProvider.getCredential(credentialHandle) : undefined;
    if (!credential?.ok) {
      trace.emit("dispatch", { actionId, result: "rejected", code: credential?.error.code ?? "CREDENTIAL_NOT_FOUND" });
      return actionResponse(options, {
        result: "rejected",
        actionEnvelopeHash: envelopeHash,
        error: {
          code: credential?.error.code ?? "CREDENTIAL_NOT_FOUND",
          message: credential?.error.message ?? "No credential binding configured.",
        },
      });
    }

    const prepared = await prepareTarget(loadedConfig, credential.value);
    if (!prepared.ok) {
      trace.emit("dispatch", { actionId, result: "rejected", code: prepared.error.code, reason: "target_prepare_failed" });
      return actionResponse(options, {
        result: "rejected",
        actionEnvelopeHash: envelopeHash,
        error: { code: prepared.error.code, message: prepared.error.message },
      });
    }

    // Atomic check-and-write gate (Action Lifecycle check-and-write property): write
    // `executing` immediately before transmission. Two submissions of the same
    // actionId can never both reach transmission.
    const authorize = ledger.authorizeDispatch(pkg.actionEnvelope.actionId, envelopeHash.value, pkg.actionEnvelope.expiresAt);
    if (authorize.kind !== "absent") {
      prepared.session.close();
      if (authorize.kind === "pending") {
        trace.emit("dispatch", { actionId, result: "pending", reason: "ledger_race" });
        return actionResponse(options, { result: "pending", actionEnvelopeHash: envelopeHash });
      }
      trace.emit("dispatch", { actionId, result: "rejected", reason: "ledger_race", code: authorize.code });
      return rejection(pkg, options, envelopeHash, "rejected", authorize.code, authorize.message);
    }

    const mcpOperation = operationName(pkg);
    const mcpArguments = argumentsObject(pkg);
    trace.emit("mcp_call", {
      actionId,
      operation: mcpOperation,
      targetType: loadedConfig.config.executionTarget.type,
    });

    let dispatchResult: McpDispatchResult;
    try {
      dispatchResult = await prepared.session.transmit(mcpOperation, mcpArguments);
    } finally {
      prepared.session.close();
    }

    const classified = classifyDispatch(dispatchResult);
    trace.emit("mcp_response", { actionId, result: classified.result, error: classified.error });

    ledger.resolve(pkg.actionEnvelope.actionId, classified.result);
    const receipt = await receiptFor(pkg, options, classified.result);

    trace.emit("receipt_generated", { actionId, result: classified.result });
    trace.emit("dispatch", { actionId, result: classified.result });

    return actionResponse(options, {
      result: classified.result,
      actionEnvelopeHash: envelopeHash,
      executionReceipt: receipt,
      executionResult: classified.executionResult,
      error: classified.error,
    });
  });

  return app;
}

/**
 * Classify an MCP dispatch result into a receipt result and the verbatim execution
 * output to relay (Action Lifecycle / MCP Execution Profile §6.1):
 *   - JSON-RPC success, result.isError !== true -> executed (executionResult present)
 *   - JSON-RPC success, result.isError === true -> failed   (executionResult present, verbatim)
 *   - INVALID_RESPONSE (JSON-RPC/protocol error)  -> failed   (executionResult absent)
 *   - DISPATCH_TIMEOUT / PROCESS_EXITED           -> indeterminate (executionResult absent)
 */
export function classifyDispatch(dispatchResult: McpDispatchResult): {
  result: "executed" | "failed" | "indeterminate";
  executionResult?: unknown;
  error?: { code: string; message: string };
} {
  if (dispatchResult.ok) {
    const toolResult = dispatchResult.result;
    if (isRecord(toolResult) && toolResult.isError === true) {
      return { result: "failed", executionResult: toolResult };
    }
    return { result: "executed", executionResult: toolResult };
  }

  switch (dispatchResult.error.code) {
    case "DISPATCH_TIMEOUT":
    case "PROCESS_EXITED":
      return { result: "indeterminate", error: { code: dispatchResult.error.code, message: dispatchResult.error.message } };
    default:
      return { result: "failed", error: { code: dispatchResult.error.code, message: dispatchResult.error.message } };
  }
}

async function prepareTarget(loadedConfig: LoadedDeploymentConfig, credential: string): Promise<DispatchPrepareResult> {
  return loadedConfig.config.executionTarget.type === "mcp.http"
    ? prepareMcpHttp(loadedConfig.config.executionTarget, credential)
    : prepareMcpStdio(loadedConfig.config.executionTarget, credential);
}

export function policyFromLoadedConfig(loadedConfig: LoadedDeploymentConfig): PolicyConfig {
  return {
    defaultRequirement: loadedConfig.config.policy.defaultRequirement,
    policies: loadedConfig.config.policy.policies as PolicyConfig["policies"],
    resourceRestrictions: loadedConfig.config.resourceRestrictions,
    signerGroups: loadedConfig.config.policy.signerGroups,
  };
}

interface ActionResponseInit {
  result: string;
  actionEnvelopeHash?: Hash;
  executionReceipt?: ExecutionReceipt;
  authorizationRequirements?: unknown;
  executionResult?: unknown;
  error?: { code: string; message: string };
}

function actionResponse(options: HttpEndpointOptions, init: ActionResponseInit) {
  return {
    version: "1",
    type: "ActionResponse",
    verifier: { did: options.adapterDid },
    ...(init.actionEnvelopeHash ? { actionEnvelopeHash: init.actionEnvelopeHash } : {}),
    result: init.result,
    ...(init.authorizationRequirements ? { authorizationRequirements: init.authorizationRequirements } : {}),
    ...(init.executionReceipt ? { executionReceipt: init.executionReceipt } : {}),
    ...(init.executionResult !== undefined ? { executionResult: init.executionResult } : {}),
    ...(init.error ? { error: init.error } : {}),
    createdAt: new Date().toISOString(),
  };
}

/** Deterministic rejection that issues a repeatable (stateless) Execution Receipt. */
async function rejection(
  pkg: ActionPackage,
  options: HttpEndpointOptions,
  envelopeHash: Hash,
  result: ReceiptResult,
  code: string,
  message: string,
) {
  return actionResponse(options, {
    result,
    actionEnvelopeHash: envelopeHash,
    executionReceipt: await receiptFor(pkg, options, result),
    error: { code, message },
  });
}

function mpasHttpError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({
    version: "1",
    type: "MpasHttpError",
    error: { code, message, retryable: false },
  });
}

function unwrapActionPackage(body: unknown): unknown {
  if (isRecord(body) && body.type === "ActionRequest" && "actionPackage" in body) {
    return body.actionPackage;
  }
  return body;
}

async function receiptFor(actionPackage: ActionPackage, options: HttpEndpointOptions, result: ReceiptResult) {
  return buildAndSignReceipt(
    actionPackage.actionEnvelope,
    actionPackage.executionPayload,
    { result },
    options.adapterDid,
    options.adapterSigningKey,
  );
}

function operationName(actionPackage: ActionPackage): string {
  const payload = actionPackage.executionPayload;
  if (isRecord(payload) && typeof payload.name === "string") {
    return payload.name;
  }

  return "";
}

function argumentsObject(actionPackage: ActionPackage): object {
  const payload = actionPackage.executionPayload;
  if (isRecord(payload) && isRecord(payload.arguments)) {
    return payload.arguments;
  }

  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
