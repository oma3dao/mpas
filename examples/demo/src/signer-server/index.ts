#!/usr/bin/env node
/**
 * MPAS Signer Server — a standalone MCP server that enables agents to act as
 * Signers. It polls the Coordination Service for pending approval requests and
 * exposes review/approve/reject tools.
 *
 * This is NOT an SDK component — it is a consumer of the SDK's protocol primitives
 * (CoordinationClient, ApprovalBuilder, KeyManager, types). One instance per agent,
 * handling approvals across all applications.
 */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import type { JWK } from "jose";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { KeyManager } from "@oma3/mpas/key-manager";
import { CoordinationClient } from "@oma3/mpas/coordination-client";
import { ApprovalBuilder } from "@oma3/mpas/approval-builder";
import { computeHash, verifyHash } from "@oma3/mpas/hash";
import type {
  ActionEnvelope,
  Approval,
  ApprovalRequest,
  CanonicalApprovalPayload,
  CoordinationApprovalResponse,
  CoordinationPollResponse,
  Decision,
  Did,
  HashObject,
  SignerReviewSet,
} from "@oma3/mpas";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SignerServerConfig {
  signerKey: KeySource;
  coordinationUrl: string;
  signerDid?: Did;
}

export type KeySource = string | JWK;

interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

type ToolCallResult = CallToolResult;

// ─── Signer Server ───────────────────────────────────────────────────────────

export class SignerServer {
  private readonly coordinationClient: CoordinationClient;
  private readonly keyManagerPromise: Promise<KeyManager>;

  constructor(private readonly config: SignerServerConfig) {
    this.keyManagerPromise = loadKeyManager(config.signerKey).then((keyManager) => {
      if (config.signerDid && config.signerDid !== keyManager.did) {
        throw new Error(`Configured signer DID ${config.signerDid} does not match derived DID ${keyManager.did}.`);
      }
      return keyManager;
    });
    this.coordinationClient = new CoordinationClient({
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
      },
      {
        name: "mpas_review_action",
        description: "Fetch and verify the review set for a pending action.",
        inputSchema: actionIdSchema(),
      },
      {
        name: "mpas_approve",
        description: "Approve a pending action.",
        inputSchema: actionIdSchema(),
      },
      {
        name: "mpas_reject",
        description: "Reject a pending action.",
        inputSchema: actionIdSchema(),
      },
    ];
  }

  async handleToolCall(toolName: string, args: object): Promise<ToolCallResult> {
    const keyManager = await this.keyManagerPromise;

    switch (toolName) {
      case "mpas_list_pending": {
        const poll = await this.coordinationClient.poll(keyManager.did);
        return textResult("Pending actions fetched.", { approvalRequests: poll.approvalRequests });
      }
      case "mpas_review_action": {
        const actionId = requiredStringArg(args, "actionId");
        const approvalRequest = await this.findApprovalRequest(keyManager.did, actionId);
        if (!approvalRequest) {
          return errorResult("APPROVAL_REQUEST_NOT_FOUND", `No pending approval request found for action: ${actionId}`, { actionId });
        }
        const reviewSet = approvalRequest.signerReviewSet;
        const integrityError = reviewSetIntegrityError(reviewSet);
        if (integrityError) {
          return errorResult("REVIEW_SET_INTEGRITY_ERROR", integrityError, { actionId });
        }
        return textResult("Review set fetched.", { approvalRequest, reviewSet });
      }
      case "mpas_approve":
      case "mpas_reject": {
        const actionId = requiredStringArg(args, "actionId");
        const approvalRequest = await this.findApprovalRequest(keyManager.did, actionId);
        if (!approvalRequest) {
          return errorResult("APPROVAL_REQUEST_NOT_FOUND", `No pending approval request found for action: ${actionId}`, { actionId });
        }
        const reviewSet = approvalRequest.signerReviewSet;
        const integrityError = reviewSetIntegrityError(reviewSet);
        if (integrityError) {
          return errorResult("REVIEW_SET_INTEGRITY_ERROR", integrityError, { actionId });
        }

        const approvalBuilder = new ApprovalBuilder({ keyManager });
        const approval = await approvalBuilder.buildApproval(
          reviewSet.actionEnvelope,
          toolName === "mpas_approve" ? "approve" : "reject",
        );
        await this.coordinationClient.submitApproval(approvalRequest.actionRef.actionEnvelopeHash, approval);
        return textResult(toolName === "mpas_approve" ? "Approval submitted." : "Rejection submitted.", { approval });
      }
      default:
        return errorResult("UNKNOWN_TOOL", `Unknown signer tool: ${toolName}`);
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
      this.handleToolCall(request.params.name, toArgsObject(request.params.arguments)),
    );

    return server;
  }

  private async findApprovalRequest(did: Did, actionId: string): Promise<ApprovalRequest | undefined> {
    const poll = await this.coordinationClient.poll(did);
    return poll.approvalRequests.find((request) => request.actionRef.actionId.value === actionId);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function actionIdSchema(): McpToolDefinition["inputSchema"] {
  return {
    type: "object",
    required: ["actionId"],
    properties: { actionId: { type: "string" } },
    additionalProperties: false,
  };
}

function loadKeyManager(signerKey: KeySource): Promise<KeyManager> {
  if (typeof signerKey === "string") {
    return KeyManager.fromFile(signerKey);
  }
  return Promise.resolve(KeyManager.fromJwk(signerKey as JWK));
}

function reviewSetIntegrityError(reviewSet: SignerReviewSet): string | undefined {
  if (!verifyHash(reviewSet.executionPayload, reviewSet.actionEnvelope.executionPayloadHash)) {
    return "Execution Payload hash does not match the Action Envelope.";
  }
  return undefined;
}

function requiredStringArg(args: object, name: string): string {
  const value = (args as Record<string, unknown>)[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required argument: ${name}`);
  }
  return value;
}

function toArgsObject(args: unknown): object {
  if (args && typeof args === "object" && !Array.isArray(args)) return args;
  return {};
}

function textResult(message: string, structuredContent: Record<string, unknown>): ToolCallResult {
  return { content: [{ type: "text", text: message }], structuredContent };
}

function errorResult(code: string, message: string, structuredContent?: Record<string, unknown>): ToolCallResult {
  return { isError: true, content: [{ type: "text", text: `${code}: ${message}` }], structuredContent };
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
