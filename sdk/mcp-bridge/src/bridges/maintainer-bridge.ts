import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { JWK } from "jose";
import { ApprovalBuilder } from "../lib/approval-builder.js";
import { CoordinationClient } from "../lib/coordination-client.js";
import { KeyManager } from "../lib/key-manager.js";
import type { MaintainerConfig } from "../types/config.js";
import type { McpToolDefinition, ToolCallResult } from "../types/mcp.js";
import type { ApprovalRequest, Did, SignerReviewSet } from "../types/mpas.js";
import { verifyHash } from "../utils/hash.js";

export class MaintainerBridge {
  private readonly coordinationClient: CoordinationClient;
  private readonly keyManagerPromise: Promise<KeyManager>;

  constructor(private readonly config: MaintainerConfig) {
    this.coordinationClient = new CoordinationClient({ url: config.coordinationUrl });
    this.keyManagerPromise = loadKeyManager(config.maintainerKey).then((keyManager) => {
      if (config.signerDid && config.signerDid !== keyManager.did) {
        throw new Error(`Configured signer DID ${config.signerDid} does not match derived DID ${keyManager.did}.`);
      }

      return keyManager;
    });
  }

  getToolDefinitions(): McpToolDefinition[] {
    return [
      {
        name: "mpas_list_pending",
        description: "List actions pending this maintainer's approval.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
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
          return errorResult("APPROVAL_REQUEST_NOT_FOUND", `No pending approval request found for action: ${actionId}`, {
            actionId,
          });
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
          return errorResult("APPROVAL_REQUEST_NOT_FOUND", `No pending approval request found for action: ${actionId}`, {
            actionId,
          });
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
        return errorResult("UNKNOWN_TOOL", `Unknown maintainer tool: ${toolName}`);
    }
  }

  buildMcpServer(): Server {
    const server = new Server(
      {
        name: "@oma3/mpas-coordination",
        version: "0.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.getToolDefinitions(),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) =>
      this.handleToolCall(request.params.name, toArgsObject(request.params.arguments)),
    );

    return server;
  }

  private async findApprovalRequest(did: Did, actionId: string): Promise<ApprovalRequest | undefined> {
    const poll = await this.coordinationClient.poll(did);
    return poll.approvalRequests.find((request) => request.actionRef.actionId.value === actionId);
  }
}

function actionIdSchema(): McpToolDefinition["inputSchema"] {
  return {
    type: "object",
    required: ["actionId"],
    properties: {
      actionId: {
        type: "string",
      },
    },
    additionalProperties: false,
  };
}

function loadKeyManager(maintainerKey: MaintainerConfig["maintainerKey"]): Promise<KeyManager> {
  if (typeof maintainerKey === "string") {
    return KeyManager.fromFile(maintainerKey);
  }

  return Promise.resolve(KeyManager.fromJwk(maintainerKey as JWK));
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
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return args;
  }

  return {};
}

function textResult(message: string, structuredContent: Record<string, unknown>): ToolCallResult {
  return {
    content: [
      {
        type: "text",
        text: message,
      },
    ],
    structuredContent,
  };
}

function errorResult(code: string, message: string, structuredContent?: Record<string, unknown>): ToolCallResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `${code}: ${message}`,
      },
    ],
    structuredContent,
  };
}
