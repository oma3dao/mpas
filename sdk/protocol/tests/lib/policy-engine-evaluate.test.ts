import { describe, expect, it } from "vitest";
import { evaluatePolicy, type PolicyConfig } from "../../src/lib/policy-engine.js";
import type { ActionPackage, Approval, Decision, Did } from "../../src/types/mpas.js";
import type { VerifiedApproval, VerifiedApprovals } from "../../src/lib/verification.js";

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

function stubApproval(signerDid: Did, decision: Decision = "approve"): VerifiedApproval {
  const approval: Approval = {
    version: "1",
    type: "Approval",
    actionEnvelopeHash: { alg: "sha-256", value: "fake-hash" },
    decision,
    signature: { format: "jws", value: "test" },
    createdAt: "2026-06-01T00:00:00.000Z",
  };
  return { approval, signerDid, decision, createdAt: approval.createdAt };
}

function makeApprovals(count: number, signerGroupDids: Did[], decision: Decision = "approve"): VerifiedApprovals {
  return {
    actionEnvelopeHash: { alg: "sha-256", value: "fake-hash" },
    approvals: signerGroupDids.slice(0, count).map((did) => stubApproval(did, decision)),
  };
}

const MAINTAINER_A: Did = "did:web:agents.example:maintainera";
const MAINTAINER_B: Did = "did:web:agents.example:maintainerb";
const SEC_REVIEWER: Did = "did:web:agents.example:secreviewer";

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
          conditions: [{ source: "executionPayload", path: "/arguments/baseRef", op: "eq", value: "main" }],
        },
        requirements: { type: "threshold", threshold: 2, eligibleSignerGroup: "maintainers", decision: "approve" },
      },
      {
        description: "merge_pull_request_mirror into main also requires 1 security reviewer.",
        match: {
          conditions: [{ source: "executionPayload", path: "/arguments/baseRef", op: "eq", value: "main" }],
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

describe("evaluatePolicy — authorization thresholds", () => {
  it("requires approvals for delete_branch_mirror when none provided", () => {
    const result = evaluatePolicy(
      makeActionPackage("delete_branch_mirror"),
      makeApprovals(0, []),
      policyWithDefaultRequirement,
    );

    expect(result).toMatchObject({
      status: "additionalApprovalsRequired",
      unsatisfiedRules: [{ requiredRole: "maintainers", requiredDecision: "approve", threshold: 1, found: 0 }],
    });
  });

  it("satisfies delete_branch_mirror when 1 maintainer approves", () => {
    expect(
      evaluatePolicy(
        makeActionPackage("delete_branch_mirror"),
        makeApprovals(1, [MAINTAINER_A]),
        policyWithDefaultRequirement,
      ),
    ).toEqual({ status: "satisfied" });
  });

  it("satisfies create_issue_mirror with a threshold-0 exemption", () => {
    expect(
      evaluatePolicy(makeActionPackage("create_issue_mirror"), makeApprovals(0, []), policyWithDefaultRequirement),
    ).toEqual({ status: "satisfied" });
  });

  it("requires both matching merge entries for merge into main", () => {
    const result = evaluatePolicy(
      makeActionPackage("merge_pull_request_mirror", { baseRef: "main" }),
      makeApprovals(0, []),
      policyWithDefaultRequirement,
    );

    expect(result.status).toBe("additionalApprovalsRequired");
    if (result.status === "additionalApprovalsRequired") {
      expect(result.unsatisfiedRules).toHaveLength(2);
    }
  });

  it("fully satisfies merge with 2 maintainers and 1 security reviewer", () => {
    const approvals: VerifiedApprovals = {
      actionEnvelopeHash: { alg: "sha-256", value: "fake-hash" },
      approvals: [stubApproval(MAINTAINER_A), stubApproval(MAINTAINER_B), stubApproval(SEC_REVIEWER)],
    };

    expect(
      evaluatePolicy(
        makeActionPackage("merge_pull_request_mirror", { baseRef: "main" }),
        approvals,
        policyWithDefaultRequirement,
      ),
    ).toEqual({ status: "satisfied" });
  });

  it("excludes proposer self-approvals from threshold counts", () => {
    const proposerDid = "did:web:agents.example:proposer" as Did;
    const result = evaluatePolicy(
      makeActionPackage("delete_branch_mirror"),
      { actionEnvelopeHash: { alg: "sha-256", value: "fake-hash" }, approvals: [stubApproval(proposerDid)] },
      {
        ...policyWithDefaultRequirement,
        signerGroups: { maintainers: [proposerDid, MAINTAINER_A] },
      },
    );

    expect(result.status).toBe("additionalApprovalsRequired");
  });

  it("ignores abstain decisions when the threshold requires approve", () => {
    const policy: PolicyConfig = {
      defaultRequirement: {
        type: "threshold",
        threshold: 1,
        eligibleSignerGroup: "maintainers",
        decision: "approve",
      },
      signerGroups: { maintainers: [MAINTAINER_A] },
    };

    const result = evaluatePolicy(
      makeActionPackage("transfer"),
      makeApprovals(1, [MAINTAINER_A], "abstain"),
      policy,
    );
    expect(result.status).toBe("additionalApprovalsRequired");
  });
});

describe("evaluatePolicy — composition and reject", () => {
  it("allOf requires all nested requirements", () => {
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

    const result = evaluatePolicy(makeActionPackage("anything"), makeApprovals(0, []), policy);
    expect(result.status).toBe("additionalApprovalsRequired");
    if (result.status === "additionalApprovalsRequired") {
      expect(result.unsatisfiedRules).toHaveLength(2);
    }
  });

  it("anyOf is satisfied if any nested requirement passes", () => {
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

    expect(
      evaluatePolicy(
        makeActionPackage("anything"),
        {
          actionEnvelopeHash: { alg: "sha-256", value: "fake-hash" },
          approvals: [stubApproval("did:web:agents.example:human0" as Did)],
        },
        policy,
      ),
    ).toEqual({ status: "satisfied" });
  });

  it("fails closed when anyOf has zero nested requirements", () => {
    const policy: PolicyConfig = {
      defaultRequirement: { type: "anyOf", requirements: [] },
      signerGroups: { all: [MAINTAINER_A] },
    };

    expect(evaluatePolicy(makeActionPackage("transfer"), makeApprovals(1, [MAINTAINER_A]), policy)).toMatchObject({
      status: "additionalApprovalsRequired",
    });
  });

  it("proposerOnly always satisfies", () => {
    expect(
      evaluatePolicy(
        makeActionPackage("anything"),
        { actionEnvelopeHash: { alg: "sha-256", value: "fake-hash" }, approvals: [] },
        { defaultRequirement: { type: "proposerOnly" } },
      ),
    ).toEqual({ status: "satisfied" });
  });

  it("rejects an action when a matching policy entry sets reject", () => {
    const policy: PolicyConfig = {
      defaultRequirement: { type: "proposerOnly" },
      policies: {
        transfer: [
          {
            reject: true,
            description: "blocked",
            match: { conditions: [{ source: "executionPayload", path: "/arguments/repo", op: "eq", value: "repo" }] },
          },
        ],
      },
    };

    expect(evaluatePolicy(makeActionPackage("transfer"), makeApprovals(0, []), policy)).toMatchObject({
      status: "rejected",
    });
  });
});
