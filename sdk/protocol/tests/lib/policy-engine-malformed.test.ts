import { describe, expect, it } from "vitest";
import { evaluatePolicy, type PolicyConfig } from "../../src/lib/policy-engine.js";
import type { ActionPackage, Did } from "../../src/types/mpas.js";
import type { VerifiedApprovals } from "../../src/lib/verification.js";

const proposerDid = "did:web:agents.example:proposer" as Did;

function pkg(payloadArguments: Record<string, string | number>): ActionPackage {
  return {
    version: "1",
    type: "ActionPackage",
    executionPayload: { name: "send_payment", arguments: payloadArguments },
    actionEnvelope: {
      version: "1",
      type: "ActionEnvelope",
      proposer: { did: proposerDid },
      target: { applicationDid: "did:web:app.example" as Did },
      executionProfile: { id: "did:web:profiles.oma3.org:mcp" as Did, format: "mcp.toolsCall" },
      executionPayloadHash: { alg: "sha-256", value: "x" },
      actionId: { value: "urn:uuid:00000000-0000-4000-8000-000000000000" },
      createdAt: "2026-06-05T18:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
    },
    approvalBundle: {
      version: "1",
      type: "ApprovalBundle",
      actionEnvelopeHash: { alg: "sha-256", value: "y" },
      approvals: [],
    },
  };
}

const noApprovals: VerifiedApprovals = { actionEnvelopeHash: { alg: "sha-256", value: "y" }, approvals: [] };

function policyWithCondition(value: unknown): PolicyConfig {
  return {
    defaultRequirement: { type: "proposerOnly" },
    signerGroups: { all: [proposerDid] },
    policies: {
      send_payment: [
        {
          match: {
            conditions: [{ source: "executionPayload", path: "/arguments/amount", op: "gt", value: "100" }],
          },
          requirements: { type: "threshold", threshold: 1, eligibleSigners: ["did:web:agents.example:cfo" as Did] },
        },
      ],
    },
  };
}

describe("evaluatePolicy — numeric condition handling (§5.4)", () => {
  it("treats an unparseable numeric value as malformed, not as a silent non-match", () => {
    const result = evaluatePolicy(pkg({ amount: "not-a-number" }), noApprovals, policyWithCondition("100"));
    expect(result.status).toBe("malformed");
    if (result.status === "malformed") {
      expect(result.code).toBe("NUMERIC_CONDITION_UNPARSEABLE");
    }
  });

  it("matches parseable numeric strings normally", () => {
    const result = evaluatePolicy(pkg({ amount: "250" }), noApprovals, policyWithCondition("100"));
    // Condition matches -> threshold applies -> additional approvals required.
    expect(result.status).toBe("additionalApprovalsRequired");
  });

  it("a missing path evaluates false for numeric operators (no match, not malformed)", () => {
    const result = evaluatePolicy(pkg({}), noApprovals, policyWithCondition("100"));
    // Condition does not match -> defaultRequirement (proposerOnly) -> satisfied.
    expect(result.status).toBe("satisfied");
  });
});

describe("evaluatePolicy — degenerate requirement composition", () => {
  it("an empty anyOf is unsatisfiable (fail closed), not a crash", () => {
    const policy: PolicyConfig = {
      defaultRequirement: { type: "anyOf", requirements: [] },
      signerGroups: { all: [proposerDid] },
    };
    const result = evaluatePolicy(pkg({}), noApprovals, policy);
    expect(result.status).toBe("additionalApprovalsRequired");
  });

  it("an empty allOf is vacuously satisfied", () => {
    const policy: PolicyConfig = {
      defaultRequirement: { type: "allOf", requirements: [] },
      signerGroups: { all: [proposerDid] },
    };
    expect(evaluatePolicy(pkg({}), noApprovals, policy).status).toBe("satisfied");
  });
});

describe("evaluatePolicy — reject entries", () => {
  it("rejects an action matched by an unconditional reject entry", () => {
    const policy: PolicyConfig = {
      defaultRequirement: { type: "proposerOnly" },
      policies: {
        send_payment: [{ reject: true, description: "Payments are disabled." }],
      },
    };

    expect(evaluatePolicy(pkg({ amount: "10" }), noApprovals, policy)).toEqual({
      status: "rejected",
      code: "ACTION_BLOCKED_BY_POLICY",
      message: "Action send_payment is blocked by policy.",
    });
  });

  it("uses the default requirement when a conditional reject entry does not match", () => {
    const policy: PolicyConfig = {
      defaultRequirement: { type: "proposerOnly" },
      policies: {
        send_payment: [
          {
            reject: true,
            match: {
              conditions: [{ source: "executionPayload", path: "/arguments/amount", op: "gt", value: "100" }],
            },
          },
        ],
      },
    };

    expect(evaluatePolicy(pkg({ amount: "10" }), noApprovals, policy)).toEqual({ status: "satisfied" });
  });

  it("lets a matching reject override an otherwise satisfied requirement", () => {
    const policy: PolicyConfig = {
      defaultRequirement: { type: "proposerOnly" },
      policies: {
        send_payment: [
          { requirements: { type: "proposerOnly" } },
          { reject: true },
        ],
      },
    };

    expect(evaluatePolicy(pkg({ amount: "10" }), noApprovals, policy).status).toBe("rejected");
  });

  it("lets a matching reject override an unsatisfied requirement instead of requesting approvals", () => {
    const policy: PolicyConfig = {
      defaultRequirement: { type: "proposerOnly" },
      policies: {
        send_payment: [
          {
            reject: false,
            requirements: {
              type: "threshold",
              threshold: 1,
              eligibleSigners: ["did:web:agents.example:cfo" as Did],
            },
          },
          { reject: true },
        ],
      },
    };

    expect(evaluatePolicy(pkg({ amount: "10" }), noApprovals, policy).status).toBe("rejected");
  });
});
