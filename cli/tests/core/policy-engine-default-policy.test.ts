import { describe, expect, it } from "vitest";
import { evaluatePolicy, type PolicyConfig, type Requirement } from "../../src/core/policy-engine.js";
import type { ActionPackage, Decision, Did } from "../../src/core/types.js";
import type { VerifiedApprovals } from "../../src/core/verification.js";

// Helpers to build minimal test data without requiring fixture files or real signatures.

function makeActionPackage(operationName: string, extraArgs: Record<string, unknown> = {}): ActionPackage {
  return {
    version: "1",
    type: "ActionPackage",
    executionPayload: {
      name: operationName,
      arguments: { owner: "org", repo: "repo", ...extraArgs },
    },
    actionEnvelope: {
      version: "1",
      type: "ActionEnvelope",
      proposer: { did: "did:web:agents.example:proposer" as Did },
      target: { applicationDid: "did:web:github-mirror.example" as Did },
      executionProfile: { id: "did:web:profiles.oma3.org:mcp" as Did, format: "mcp.toolsCall" },
      executionPayloadHash: { alg: "sha-256", value: "fake-hash" },
      actionId: { value: "test-action-id" },
      createdAt: "2026-06-01T00:00:00.000Z",
      expiresAt: "2026-06-02T00:00:00.000Z",
    },
    approvalBundle: { actionEnvelopeHash: { alg: "sha-256", value: "fake-hash" }, approvals: [] },
  } as unknown as ActionPackage;
}

function makeApprovals(count: number, signerGroupDids: Did[], decision: Decision = "approve"): VerifiedApprovals {
  const approvals = signerGroupDids.slice(0, count).map((did) => ({
    approval: {} as never,
    signerDid: did,
    decision,
    createdAt: "2026-06-01T00:00:00.000Z",
  }));
  return { actionEnvelopeHash: { alg: "sha-256" as const, value: "fake-hash" }, approvals };
}

const MAINTAINER_A: Did = "did:web:agents.example:maintainera";
const MAINTAINER_B: Did = "did:web:agents.example:maintainerb";
const SEC_REVIEWER: Did = "did:web:agents.example:secreviewer";

// Policy: default requires 1 maintainer approval. Action-keyed policies override the default.
const policyWithDefaultRequirement: PolicyConfig = {
  defaultRequirement: {
    type: "threshold",
    threshold: 1,
    eligibleSignerGroup: "maintainers",
    decision: "approve",
  },
  policies: {
    create_issue_mirror: [
      {
        description: "create_issue_mirror is exempt (auto-approved).",
        requirements: { type: "threshold", threshold: 0, eligibleSignerGroup: "maintainers", decision: "approve" },
      },
    ],
    merge_pull_request_mirror: [
      {
        description: "merge_pull_request_mirror into main requires 2 maintainers.",
        match: {
          conditions: [
            { source: "executionPayload", path: "/arguments/baseRef", op: "eq", value: "main" },
          ],
        },
        requirements: { type: "threshold", threshold: 2, eligibleSignerGroup: "maintainers", decision: "approve" },
      },
      {
        description: "merge_pull_request_mirror into main also requires 1 security reviewer.",
        match: {
          conditions: [
            { source: "executionPayload", path: "/arguments/baseRef", op: "eq", value: "main" },
          ],
        },
        requirements: { type: "threshold", threshold: 1, eligibleSignerGroup: "security-reviewers", decision: "approve" },
      },
    ],
  },
  signerGroups: {
    maintainers: [MAINTAINER_A, MAINTAINER_B],
    "security-reviewers": [SEC_REVIEWER],
  },
};

describe("evaluatePolicy — defaultRequirement", () => {
  describe("operation with no matching policy entry hits the default", () => {
    it("requires approvals for delete_branch_mirror when none provided", () => {
      const result = evaluatePolicy(
        makeActionPackage("delete_branch_mirror"),
        makeApprovals(0, []),
        policyWithDefaultRequirement,
      );

      expect(result).toMatchObject({
        status: "additionalApprovalsRequired",
        unsatisfiedRules: [
          {
            requiredRole: "maintainers",
            requiredDecision: "approve",
            threshold: 1,
            found: 0,
          },
        ],
      });
    });

    it("satisfies delete_branch_mirror when 1 maintainer approves", () => {
      const result = evaluatePolicy(
        makeActionPackage("delete_branch_mirror"),
        makeApprovals(1, [MAINTAINER_A]),
        policyWithDefaultRequirement,
      );

      expect(result).toEqual({ status: "satisfied" });
    });
  });

  describe("operation with a matching policy entry — default does not apply", () => {
    it("satisfies create_issue_mirror with zero approvals (threshold: 0 exemption)", () => {
      const result = evaluatePolicy(
        makeActionPackage("create_issue_mirror"),
        makeApprovals(0, []),
        policyWithDefaultRequirement,
      );

      expect(result).toEqual({ status: "satisfied" });
    });

    it("the default requirement does NOT apply to create_issue_mirror even with no approvals", () => {
      const result = evaluatePolicy(
        makeActionPackage("create_issue_mirror"),
        { actionEnvelopeHash: { alg: "sha-256", value: "fake-hash" }, approvals: [] },
        policyWithDefaultRequirement,
      );

      expect(result.status).not.toBe("additionalApprovalsRequired");
      expect(result).toEqual({ status: "satisfied" });
    });
  });

  describe("operation with two matching entries in its policy array — both must be satisfied, default does not apply", () => {
    it("requires both entries satisfied for merge_pull_request_mirror into main", () => {
      const result = evaluatePolicy(
        makeActionPackage("merge_pull_request_mirror", { baseRef: "main" }),
        makeApprovals(0, []),
        policyWithDefaultRequirement,
      );

      expect(result.status).toBe("additionalApprovalsRequired");
      if (result.status === "additionalApprovalsRequired") {
        expect(result.unsatisfiedRules).toHaveLength(2);
        expect(result.unsatisfiedRules).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ requiredRole: "maintainers", threshold: 2, found: 0 }),
            expect.objectContaining({ requiredRole: "security-reviewers", threshold: 1, found: 0 }),
          ]),
        );
      }
    });

    it("partially satisfied — 2 maintainers but no security reviewer", () => {
      const approvals: VerifiedApprovals = {
        actionEnvelopeHash: { alg: "sha-256", value: "fake-hash" },
        approvals: [
          { approval: {} as never, signerDid: MAINTAINER_A, decision: "approve", createdAt: "2026-06-01T00:00:00.000Z" },
          { approval: {} as never, signerDid: MAINTAINER_B, decision: "approve", createdAt: "2026-06-01T00:00:00.000Z" },
        ],
      };

      const result = evaluatePolicy(
        makeActionPackage("merge_pull_request_mirror", { baseRef: "main" }),
        approvals,
        policyWithDefaultRequirement,
      );

      expect(result.status).toBe("additionalApprovalsRequired");
      if (result.status === "additionalApprovalsRequired") {
        expect(result.unsatisfiedRules).toHaveLength(1);
        expect(result.unsatisfiedRules[0]).toMatchObject({
          requiredRole: "security-reviewers",
          threshold: 1,
          found: 0,
        });
      }
    });

    it("fully satisfied — 2 maintainers and 1 security reviewer", () => {
      const approvals: VerifiedApprovals = {
        actionEnvelopeHash: { alg: "sha-256", value: "fake-hash" },
        approvals: [
          { approval: {} as never, signerDid: MAINTAINER_A, decision: "approve", createdAt: "2026-06-01T00:00:00.000Z" },
          { approval: {} as never, signerDid: MAINTAINER_B, decision: "approve", createdAt: "2026-06-01T00:00:00.000Z" },
          { approval: {} as never, signerDid: SEC_REVIEWER, decision: "approve", createdAt: "2026-06-01T00:00:00.000Z" },
        ],
      };

      const result = evaluatePolicy(
        makeActionPackage("merge_pull_request_mirror", { baseRef: "main" }),
        approvals,
        policyWithDefaultRequirement,
      );

      expect(result).toEqual({ status: "satisfied" });
    });

    it("the default (1 maintainer) does NOT apply since explicit policy entries matched", () => {
      const approvals: VerifiedApprovals = {
        actionEnvelopeHash: { alg: "sha-256", value: "fake-hash" },
        approvals: [
          { approval: {} as never, signerDid: MAINTAINER_A, decision: "approve", createdAt: "2026-06-01T00:00:00.000Z" },
          { approval: {} as never, signerDid: SEC_REVIEWER, decision: "approve", createdAt: "2026-06-01T00:00:00.000Z" },
        ],
      };

      const result = evaluatePolicy(
        makeActionPackage("merge_pull_request_mirror", { baseRef: "main" }),
        approvals,
        policyWithDefaultRequirement,
      );

      expect(result.status).toBe("additionalApprovalsRequired");
      if (result.status === "additionalApprovalsRequired") {
        expect(result.unsatisfiedRules).toHaveLength(1);
        expect(result.unsatisfiedRules[0]).toMatchObject({
          requiredRole: "maintainers",
          threshold: 2,
          found: 1,
        });
      }
    });
  });
});

describe("evaluatePolicy — allOf and anyOf requirements", () => {
  it("allOf requires all nested requirements satisfied", () => {
    const policy: PolicyConfig = {
      defaultRequirement: {
        type: "allOf",
        requirements: [
          { type: "threshold", threshold: 2, eligibleSignerGroup: "agents", decision: "approve" },
          { type: "threshold", threshold: 1, eligibleSignerGroup: "humans", decision: "approve" },
        ],
      },
      signerGroups: {
        agents: ["did:web:agents.example:agent0" as Did, "did:web:agents.example:agent1" as Did],
        humans: ["did:web:agents.example:human0" as Did],
      },
    };

    // No approvals → both unsatisfied
    const result = evaluatePolicy(makeActionPackage("anything"), makeApprovals(0, []), policy);
    expect(result.status).toBe("additionalApprovalsRequired");
    if (result.status === "additionalApprovalsRequired") {
      expect(result.unsatisfiedRules).toHaveLength(2);
    }
  });

  it("anyOf is satisfied if any one nested requirement passes", () => {
    const policy: PolicyConfig = {
      defaultRequirement: {
        type: "anyOf",
        requirements: [
          { type: "threshold", threshold: 2, eligibleSignerGroup: "agents", decision: "approve" },
          { type: "threshold", threshold: 1, eligibleSignerGroup: "humans", decision: "approve" },
        ],
      },
      signerGroups: {
        agents: ["did:web:agents.example:agent0" as Did, "did:web:agents.example:agent1" as Did],
        humans: ["did:web:agents.example:human0" as Did],
      },
    };

    // 1 human is enough (satisfies second branch)
    const approvals: VerifiedApprovals = {
      actionEnvelopeHash: { alg: "sha-256", value: "fake-hash" },
      approvals: [
        { approval: {} as never, signerDid: "did:web:agents.example:human0" as Did, decision: "approve" as Decision, createdAt: "2026-06-01T00:00:00.000Z" },
      ],
    };

    const result = evaluatePolicy(makeActionPackage("anything"), approvals, policy);
    expect(result).toEqual({ status: "satisfied" });
  });

  it("anyOf fails when no branch is satisfied", () => {
    const policy: PolicyConfig = {
      defaultRequirement: {
        type: "anyOf",
        requirements: [
          { type: "threshold", threshold: 2, eligibleSignerGroup: "agents", decision: "approve" },
          { type: "threshold", threshold: 1, eligibleSignerGroup: "humans", decision: "approve" },
        ],
      },
      signerGroups: {
        agents: ["did:web:agents.example:agent0" as Did, "did:web:agents.example:agent1" as Did],
        humans: ["did:web:agents.example:human0" as Did],
      },
    };

    // 1 agent is not enough for either branch
    const approvals: VerifiedApprovals = {
      actionEnvelopeHash: { alg: "sha-256", value: "fake-hash" },
      approvals: [
        { approval: {} as never, signerDid: "did:web:agents.example:agent0" as Did, decision: "approve" as Decision, createdAt: "2026-06-01T00:00:00.000Z" },
      ],
    };
    const result = evaluatePolicy(makeActionPackage("anything"), approvals, policy);
    expect(result.status).toBe("additionalApprovalsRequired");
  });

  it("proposerOnly always satisfies", () => {
    const policy: PolicyConfig = {
      defaultRequirement: { type: "proposerOnly" },
    };

    const result = evaluatePolicy(
      makeActionPackage("anything"),
      { actionEnvelopeHash: { alg: "sha-256", value: "fake-hash" }, approvals: [] },
      policy,
    );

    expect(result).toEqual({ status: "satisfied" });
  });
});

describe("evaluatePolicy — condition operators", () => {
  const policy: PolicyConfig = {
    defaultRequirement: { type: "proposerOnly" },
    policies: {
      transfer: [
        {
          description: "gt operator test",
          match: { conditions: [{ source: "executionPayload", path: "/arguments/amount", op: "gt", value: "100" }] },
          requirements: { type: "threshold", threshold: 1, eligibleSignerGroup: "admins", decision: "approve" },
        },
      ],
    },
    signerGroups: { admins: ["did:web:agents.example:admin" as Did] },
  };

  it("gt operator matches when actual > expected", () => {
    const result = evaluatePolicy(
      makeActionPackage("transfer", { amount: 150 }),
      makeApprovals(0, []),
      policy,
    );
    expect(result.status).toBe("additionalApprovalsRequired");
  });

  it("gt operator does not match when actual <= expected", () => {
    const result = evaluatePolicy(
      makeActionPackage("transfer", { amount: 50 }),
      makeApprovals(0, []),
      policy,
    );
    // Condition not met → no entry matches → but the action IS in policies so entry didn't match → defaultRequirement
    // Wait: the action "transfer" IS in policies, but the condition doesn't match,
    // so no entries match within the array → fallback to defaultRequirement (proposerOnly)
    expect(result).toEqual({ status: "satisfied" });
  });
});

describe("evaluatePolicy — signerGroups", () => {
  it("resolves eligible signers from signerGroups", () => {
    const policy: PolicyConfig = {
      defaultRequirement: {
        type: "threshold",
        threshold: 1,
        eligibleSignerGroup: "treasuryOperators",
        decision: "approve",
      },
      signerGroups: {
        treasuryOperators: ["did:web:agents.example:alice" as Did, "did:web:agents.example:bob" as Did],
      },
    };

    // Alice approves
    const approvals: VerifiedApprovals = {
      actionEnvelopeHash: { alg: "sha-256", value: "fake-hash" },
      approvals: [
        { approval: {} as never, signerDid: "did:web:agents.example:alice" as Did, decision: "approve" as Decision, createdAt: "2026-06-01T00:00:00.000Z" },
      ],
    };

    const result = evaluatePolicy(makeActionPackage("anything"), approvals, policy);
    expect(result).toEqual({ status: "satisfied" });
  });

  it("rejects approval from non-member of signerGroup", () => {
    const policy: PolicyConfig = {
      defaultRequirement: {
        type: "threshold",
        threshold: 1,
        eligibleSignerGroup: "treasuryOperators",
        decision: "approve",
      },
      signerGroups: {
        treasuryOperators: ["did:web:agents.example:alice" as Did, "did:web:agents.example:bob" as Did],
      },
    };

    // Eve (not in group) approves
    const approvals: VerifiedApprovals = {
      actionEnvelopeHash: { alg: "sha-256", value: "fake-hash" },
      approvals: [
        { approval: {} as never, signerDid: "did:web:agents.example:eve" as Did, decision: "approve" as Decision, createdAt: "2026-06-01T00:00:00.000Z" },
      ],
    };

    const result = evaluatePolicy(makeActionPackage("anything"), approvals, policy);
    expect(result.status).toBe("additionalApprovalsRequired");
  });
});
