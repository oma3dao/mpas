#!/usr/bin/env node
/**
 * MPAS Signer Server — a standalone MCP server that enables agents to act as
 * Signers. It polls the Coordination Service for pending approval requests and
 * exposes review/approve/reject tools.
 *
 * This is NOT an SDK component — it is a consumer of the SDK's protocol primitives
 * (CoordinationServiceClient, ApprovalBuilder, KeyManager, types). One instance per agent,
 * handling approvals across all applications.
 */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import type { JWK } from "jose";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { KeyManager } from "@oma3/mpas/key-manager";
import {
  CoordinationResponseError,
  CoordinationServiceClient,
  CoordinationUnavailableError,
  MpasAuthError,
} from "@oma3/mpas/coordination-service-client";
import { RoutingValidationError } from "@oma3/mpas/routing";
import { ApprovalBuilder } from "@oma3/mpas/approval-builder";
import { verifyJsonHash } from "@oma3/mpas/hash";
import type {
  ActionEnvelope,
  Approval,
  ApprovalRequest,
  CoordinationApprovalResponse,
  Decision,
  Did,
  SignerReviewSet,
} from "@oma3/mpas";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SignerServerConfig {
  signerKey: KeySource;
  coordinationUrl: string;
  signerDid?: Did;
  /** Trusted clock used for expiry checks. */
  now?: () => number;
}

export type KeySource = string | JWK;

interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

type ToolCallResult = CallToolResult;

type SignerErrorCode =
  | "SIGNER_INPUT_INVALID"
  | "APPROVAL_REQUEST_NOT_FOUND"
  | "REVIEW_SET_INTEGRITY_ERROR"
  | "SIGNER_NOT_ELIGIBLE"
  | "ACTION_EXPIRED"
  | "COORDINATION_APPROVAL_REJECTED"
  | "COORDINATION_RESPONSE_INVALID"
  | "COORDINATION_UNAVAILABLE"
  | "UNKNOWN_TOOL";

interface SignerError {
  code: SignerErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

// ─── Signer Server ───────────────────────────────────────────────────────────

export class SignerServer {
  private readonly coordinationService: CoordinationServiceClient;
  private readonly keyManagerPromise: Promise<KeyManager>;

  constructor(private readonly config: SignerServerConfig) {
    this.keyManagerPromise = loadKeyManager(config.signerKey).then((keyManager) => {
      if (config.signerDid && config.signerDid !== keyManager.did) {
        throw new Error(`Configured signer DID ${config.signerDid} does not match derived DID ${keyManager.did}.`);
      }
      return keyManager;
    });
    this.coordinationService = new CoordinationServiceClient({
      url: config.coordinationUrl,
      signer: this.keyManagerPromise,
    });
  }

  getToolDefinitions(): McpToolDefinition[] {
    return [
      {
        name: "mpas_list_pending",
        description: "List actions pending this maintainer's approval.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: successOutputSchema(["approvalRequests"], {
          approvalRequests: { type: "array", items: { type: "object" } },
        }),
      },
      {
        name: "mpas_review_action",
        description: "Fetch and verify the review set for a pending action.",
        inputSchema: actionIdSchema(),
        outputSchema: successOutputSchema(["approvalRequest", "reviewSet"], {
          approvalRequest: { type: "object" },
          reviewSet: { type: "object" },
        }),
      },
      {
        name: "mpas_approve",
        description: "Approve a pending action.",
        inputSchema: actionIdSchema(),
        outputSchema: decisionOutputSchema(),
      },
      {
        name: "mpas_reject",
        description: "Reject a pending action.",
        inputSchema: actionIdSchema(),
        outputSchema: decisionOutputSchema(),
      },
    ];
  }

  async handleToolCall(toolName: string, args: unknown): Promise<ToolCallResult> {
    if (!this.getToolDefinitions().some((tool) => tool.name === toolName)) {
      return errorResult("UNKNOWN_TOOL", `Unknown signer tool: ${toolName}`);
    }

    const inputError = signerInputError(toolName, args);
    if (inputError) return errorResult(inputError.code, inputError.message, inputError.details);

    try {
      switch (toolName) {
        case "mpas_list_pending": {
          const poll = await this.coordinationService.pollWork();
          return textResult("Pending actions fetched.", { approvalRequests: poll.approvalRequests });
        }
        case "mpas_review_action": {
          const actionId = requiredStringArg(args, "actionId");
          const approvalRequest = await this.findApprovalRequest(actionId);
          if (!approvalRequest) {
            return errorResult(
              "APPROVAL_REQUEST_NOT_FOUND",
              `No pending approval request found for action: ${actionId}`,
              { actionId },
            );
          }
          const keyManager = await this.keyManagerPromise;
          const reviewError = reviewSetIntegrityError(
            approvalRequest,
            actionId,
            approvalRequest.requestedDecision,
            keyManager.did,
            this.config.now?.() ?? Date.now(),
          );
          if (reviewError) return errorResult(reviewError.code, reviewError.message, reviewError.details);
          return textResult("Review set fetched.", {
            approvalRequest,
            reviewSet: approvalRequest.signerReviewSet,
          });
        }
        case "mpas_approve":
        case "mpas_reject": {
          const actionId = requiredStringArg(args, "actionId");
          const approvalRequest = await this.findApprovalRequest(actionId);
          if (!approvalRequest) {
            return errorResult(
              "APPROVAL_REQUEST_NOT_FOUND",
              `No pending approval request found for action: ${actionId}`,
              { actionId },
            );
          }
          const keyManager = await this.keyManagerPromise;
          const decision = toolName === "mpas_approve" ? "approve" : "reject";
          const reviewError = reviewSetIntegrityError(
            approvalRequest,
            actionId,
            decision,
            keyManager.did,
            this.config.now?.() ?? Date.now(),
          );
          if (reviewError) return errorResult(reviewError.code, reviewError.message, reviewError.details);

          const approvalBuilder = new ApprovalBuilder({ signer: keyManager });
          const approval = await approvalBuilder.buildApproval(approvalRequest.signerReviewSet.actionEnvelope, decision);
          const coordinationResponse: CoordinationApprovalResponse = await this.coordinationService.submitApproval({
            actionEnvelopeHash: approvalRequest.actionRef.actionEnvelopeHash,
            approval,
          });
          if (!coordinationResponse.accepted) {
            return errorResult(
              "COORDINATION_APPROVAL_REJECTED",
              "The Coordination Service did not accept the signed decision.",
              { approval, coordinationResponse },
            );
          }
          if (!sameActionReference(coordinationResponse, approvalRequest)) {
            return errorResult(
              "COORDINATION_RESPONSE_INVALID",
              "The Coordination response does not reference the approved Action.",
              { approval, coordinationResponse },
            );
          }
          return textResult(
            toolName === "mpas_approve" ? "Approval submitted." : "Rejection submitted.",
            { approval, coordinationResponse },
          );
        }
        default:
          return errorResult("UNKNOWN_TOOL", `Unknown signer tool: ${toolName}`);
      }
    } catch (error) {
      if (error instanceof MpasAuthError) {
        return errorResult("COORDINATION_RESPONSE_INVALID", "Coordination authentication failed.");
      }
      if (error instanceof RoutingValidationError) {
        // Field-specific review failures retain their profile codes through MCP.
        // Listing never returns an incomplete object as successful pending data.
        if (toolName !== "mpas_list_pending" && /^\$\.approvalRequests\[\d+\]\./.test(error.path)) {
          if (error.path.includes(".signerReviewSet.") && error.path.endsWith(".expiresAt")) {
            return errorResult("ACTION_EXPIRED", "The Action or review material has an invalid expiry.");
          }
          if (/\.(executionPayloadHash|actionEnvelopeHash|authorizationRequirements|requestedDecision)(\.|$)/.test(error.path)) {
            return errorResult("REVIEW_SET_INTEGRITY_ERROR", "Review hash or approval metadata is invalid.");
          }
        }
        return errorResult("COORDINATION_RESPONSE_INVALID", "Coordination returned malformed approval work.");
      }
      if (error instanceof CoordinationUnavailableError) {
        return errorResult("COORDINATION_UNAVAILABLE", error.message);
      }
      if (error instanceof CoordinationResponseError) {
        return errorResult("COORDINATION_RESPONSE_INVALID", error.message);
      }
      throw error;
    }
  }

  buildMcpServer(): Server {
    const server = new Server(
      { name: "@oma3/mpas-signer-server", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.getToolDefinitions(),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) =>
      this.handleToolCall(request.params.name, request.params.arguments),
    );

    return server;
  }

  private async findApprovalRequest(actionId: string): Promise<ApprovalRequest | undefined> {
    const poll = await this.coordinationService.pollWork();
    return poll.approvalRequests.find((request) => request.actionRef.actionId.value === actionId);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function actionIdSchema(): McpToolDefinition["inputSchema"] {
  return {
    type: "object",
    required: ["actionId"],
    properties: { actionId: { type: "string", minLength: 1 } },
    additionalProperties: false,
  };
}

function successOutputSchema(required: string[], properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", required, properties, additionalProperties: false };
}

function decisionOutputSchema(): Record<string, unknown> {
  return successOutputSchema(["approval", "coordinationResponse"], {
    approval: { type: "object" },
    coordinationResponse: { type: "object" },
  });
}

function loadKeyManager(signerKey: KeySource): Promise<KeyManager> {
  if (typeof signerKey === "string") {
    return KeyManager.fromFile(signerKey);
  }
  return Promise.resolve(KeyManager.fromJwk(signerKey as JWK));
}

function reviewSetIntegrityError(
  approvalRequest: ApprovalRequest,
  actionId: string,
  decision: Decision | undefined,
  signerDid: Did,
  now: number,
): SignerError | undefined {
  const reviewSet: SignerReviewSet = approvalRequest.signerReviewSet;
  if (
    approvalRequest.actionRef.actionId.value !== actionId ||
    reviewSet.actionEnvelope.actionId.value !== actionId ||
    reviewSet.actionEnvelope.actionId.scope !== approvalRequest.actionRef.actionId.scope
  ) {
    return signerError("REVIEW_SET_INTEGRITY_ERROR", "Action IDs do not match across the request and review set.", actionId);
  }
  if (!verifyJsonHash(reviewSet.actionEnvelope, approvalRequest.actionRef.actionEnvelopeHash)) {
    return signerError("REVIEW_SET_INTEGRITY_ERROR", "Action Envelope hash does not match the Action reference.", actionId);
  }
  if (!verifyJsonHash(reviewSet.executionPayload, reviewSet.actionEnvelope.executionPayloadHash)) {
    return signerError("REVIEW_SET_INTEGRITY_ERROR", "Execution Payload hash does not match the Action Envelope.", actionId);
  }
  const authorizationRequirements = reviewSet.authorizationRequirements;
  if (
    !authorizationRequirements ||
    authorizationRequirements.result !== "additionalApprovalsRequired" ||
    !verifyJsonHash(reviewSet.actionEnvelope, authorizationRequirements.actionEnvelopeHash)
  ) {
    return signerError(
      "REVIEW_SET_INTEGRITY_ERROR",
      "Authorization Requirements do not bind a usable approval path to the Action Envelope.",
      actionId,
    );
  }
  if (
    expiredAt(reviewSet.actionEnvelope.expiresAt, now, true) ||
    expiredAt(reviewSet.expiresAt, now) ||
    expiredAt(authorizationRequirements.expiresAt, now)
  ) {
    return signerError("ACTION_EXPIRED", "The Action or review material has expired.", actionId);
  }
  if (decision !== "approve" && decision !== "reject") {
    return signerError("REVIEW_SET_INTEGRITY_ERROR", "The requested decision must be approve or reject.", actionId);
  }
  if (approvalRequest.requestedDecision && approvalRequest.requestedDecision !== decision) {
    return signerError("REVIEW_SET_INTEGRITY_ERROR", "The tool decision does not match the requested decision.", actionId);
  }
  const requirements = authorizationRequirements.approvalRequirements;
  const thresholdPaths = [...(requirements.anyOf ?? []), ...(requirements.allOf ?? [])];
  const matchesThreshold = thresholdPaths.some(
    (requirement) =>
      requirement.eligibleSigners.includes(signerDid) &&
      (requirement.decision ?? "approve") === decision,
  );
  const matchesOverride = (requirements.overrideSigners ?? []).some(
    (override) => override.signer === signerDid && override.permissions.includes(decision),
  );
  if (!matchesThreshold && !matchesOverride) {
    return signerError("SIGNER_NOT_ELIGIBLE", "The configured Signer is not eligible for the requested decision.", actionId);
  }
  return undefined;
}

function signerError(code: SignerErrorCode, message: string, actionId: string): SignerError {
  return { code, message, details: { actionId } };
}

function expiredAt(value: string | undefined, now: number, required = false): boolean {
  if (value === undefined) return required;
  const parsed = Date.parse(value);
  return !Number.isFinite(parsed) || parsed <= now;
}

function sameActionReference(
  response: CoordinationApprovalResponse,
  request: ApprovalRequest,
): boolean {
  return (
    response.actionRef.actionId.value === request.actionRef.actionId.value &&
    response.actionRef.actionId.scope === request.actionRef.actionId.scope &&
    response.actionRef.actionEnvelopeHash.alg === request.actionRef.actionEnvelopeHash.alg &&
    response.actionRef.actionEnvelopeHash.value === request.actionRef.actionEnvelopeHash.value
  );
}

function signerInputError(toolName: string, args: unknown): SignerError | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { code: "SIGNER_INPUT_INVALID", message: "Signer tool arguments must be a JSON object." };
  }
  const keys = Object.keys(args);
  if (toolName === "mpas_list_pending") {
    return keys.length === 0
      ? undefined
      : { code: "SIGNER_INPUT_INVALID", message: "mpas_list_pending accepts only an empty object." };
  }
  if (
    keys.length !== 1 ||
    keys[0] !== "actionId" ||
    typeof (args as Record<string, unknown>).actionId !== "string" ||
    (args as Record<string, unknown>).actionId === ""
  ) {
    return {
      code: "SIGNER_INPUT_INVALID",
      message: `${toolName} requires exactly one non-empty actionId string.`,
    };
  }
  return undefined;
}

function requiredStringArg(args: unknown, name: string): string {
  const value = (args as Record<string, unknown>)[name];
  return value as string;
}

function textResult(message: string, structuredContent: Record<string, unknown>): ToolCallResult {
  return { content: [{ type: "text", text: message }], structuredContent };
}

function errorResult(
  code: SignerErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ToolCallResult {
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: { code, message, ...(details ? { details } : {}) },
  };
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

export async function runSignerServer(args = process.argv.slice(2)): Promise<void> {
  const configPath = extractConfigPath(args);
  if (!configPath) {
    process.stderr.write("Usage: mpas signer-server --config <path>\n");
    process.exitCode = 1;
    return;
  }

  const rawConfig = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  const config: SignerServerConfig = {
    signerKey: (rawConfig.agent as Record<string, unknown>)?.keyFile as string ?? rawConfig.maintainerKey as string,
    coordinationUrl: (rawConfig.coordination as Record<string, unknown>)?.url as string ?? rawConfig.coordinationUrl as string,
    signerDid: (rawConfig.agent as Record<string, unknown>)?.did as Did | undefined,
  };

  const signerServer = new SignerServer(config);
  const server = signerServer.buildMcpServer();

  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function extractConfigPath(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && args[i + 1]) {
      return args[i + 1];
    }
  }
  return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSignerServer();
}
