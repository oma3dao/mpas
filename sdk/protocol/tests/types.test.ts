import { describe, expect, it } from "vitest";
import type { ActionPackage, AdapterResponse, McpToolDefinition } from "../src/index.js";

describe("MPAS Bridge types", () => {
  it("allows a fully typed sample Action Package", () => {
    const actionPackage: ActionPackage = {
      version: "1",
      type: "ActionPackage",
      executionPayload: {
        name: "create_issue",
        arguments: {
          owner: "oma3dao",
          repo: "app-registry",
          title: "Add MPAS bridge fixture coverage",
        },
      },
      actionEnvelope: {
        version: "1",
        type: "ActionEnvelope",
        proposer: {
          did: "did:web:agents.example:proposer",
        },
        target: {
          applicationDid: "did:web:github.example",
          resource: "repo:oma3dao/app-registry",
        },
        executionProfile: {
          id: "did:web:profiles.oma3.org:mcp",
          format: "mcp.toolsCall",
        },
        executionPayloadHash: {
          alg: "sha-256",
          value: "base64url-encoded-digest",
        },
        actionId: {
          value: "urn:uuid:3f82f6e1-135e-44c5-90a9-58f760f6d9f1",
        },
        createdAt: "2026-06-05T18:00:00Z",
        expiresAt: "2026-06-05T18:30:00Z",
      },
      approvalBundle: {
        version: "1",
        type: "ApprovalBundle",
        actionEnvelopeHash: {
          alg: "sha-256",
          value: "base64url-encoded-envelope-digest",
        },
        approvals: [
          {
            version: "1",
            type: "Approval",
            actionEnvelopeHash: {
              alg: "sha-256",
              value: "base64url-encoded-envelope-digest",
            },
            decision: "propose",
            signature: {
              format: "jws",
              value: "eyJhbGciOiJFZERTQSJ9.eyJ0eXBlIjoiQXBwcm92YWxQYXlsb2FkIn0.signature",
            },
            createdAt: "2026-06-05T18:01:00Z",
          },
        ],
        assembledBy: "did:web:agents.example:proposer",
        createdAt: "2026-06-05T18:10:00Z",
      },
      createdAt: "2026-06-05T18:10:00Z",
    };

    expect((actionPackage.executionPayload as { name?: string }).name).toBe("create_issue");
  });

  it("models adapter responses and MCP tool definitions", () => {
    const tool: McpToolDefinition = {
      name: "create_issue",
      description: "Create a new issue in a repository.",
      inputSchema: {
        type: "object",
        required: ["owner", "repo", "title"],
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          title: { type: "string" },
        },
      },
    };

    const response: AdapterResponse = {
      version: "1",
      type: "ActionResponse",
      result: "additionalApprovalsRequired",
      authorizationRequirements: {
        version: "1",
        type: "AuthorizationRequirements",
        actionEnvelopeHash: {
          alg: "sha-256",
          value: "base64url-encoded-envelope-digest",
        },
        result: "additionalApprovalsRequired",
        verifier: {
          did: "did:web:agents.example:adapter",
        },
        approvalRequirements: {
          anyOf: [
            {
              type: "threshold",
              threshold: 1,
              eligibleSigners: ["did:web:agents.example:signer"],
              decision: "approve",
            },
          ],
        },
      },
    };

    expect(tool.name).toBe("create_issue");
    expect(response.result).toBe("additionalApprovalsRequired");
  });
});
