import { describe, expect, it } from "vitest";
import { evaluatePolicy, type PolicyConfig } from "../../src/lib/policy-engine.js";
import type { ActionPackage, Decision, Did } from "../../src/types/mpas.js";
import type { VerifiedApprovals } from "../../src/lib/verification.js";

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

describe("evaluatePolicy — defaultRequirement (sdk)", () => {
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

  it("satisfies create_issue_mirror with zero approvals (threshold: 0 exemption)", () => {
    const result = evaluatePolicy(
      makeActionPackage("create_issue_mirror"),
      makeApprovals(0, []),
      policyWithDefaultRequirement,
    );

    expect(result).toEqual({ status: "satisfied" });
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

  it("excludes proposer self-approvals from threshold counts", () => {
    const proposerDid = "did:web:agents.example:proposer" as Did;
    const approvals: VerifiedApprovals = {
      actionEnvelopeHash: { alg: "sha-256", value: "fake-hash" },
      approvals: [
        { approval: {} as never, signerDid: proposerDid, decision: "approve", createdAt: "2026-06-01T00:00:00.000Z" },
      ],
    };

    const result = evaluatePolicy(
      makeActionPackage("delete_branch_mirror"),
      approvals,
      {
        ...policyWithDefaultRequirement,
        signerGroups: {
          maintainers: [proposerDid, MAINTAINER_A],
        },
      },
    );

    expect(result.status).toBe("additionalApprovalsRequired");
  });
});

describe("evaluatePolicy — allOf / anyOf / proposerOnly (sdk)", () => {
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

    const approvals: VerifiedApprovals = {
      actionEnvelopeHash: { alg: "sha-256", value: "fake-hash" },
      approvals: [
        {
          approval: {} as never,
          signerDid: "did:web:agents.example:human0" as Did,
          decision: "approve",
          createdAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    };

    expect(evaluatePolicy(makeActionPackage("anything"), approvals, policy)).toEqual({ status: "satisfied" });
  });

  it("proposerOnly always satisfies", () => {
    const policy: PolicyConfig = {
      defaultRequirement: { type: "proposerOnly" },
    };

    expect(
      evaluatePolicy(
        makeActionPackage("anything"),
        { actionEnvelopeHash: { alg: "sha-256", value: "fake-hash" }, approvals: [] },
        policy,
      ),
    ).toEqual({ status: "satisfied" });
  });
});

describe("evaluatePolicy — condition operators (sdk)", () => {
  const basePolicy = (op: string, value: unknown): PolicyConfig => ({
    defaultRequirement: { type: "proposerOnly" },
    policies: {
      transfer: [
        {
          description: `${op} operator test`,
          match: { conditions: [{ source: "executionPayload", path: "/arguments/amount", op: op as never, value }] },
          requirements: { type: "threshold", threshold: 1, eligibleSignerGroup: "admins", decision: "approve" },
        },
      ],
    },
    signerGroups: { admins: ["did:web:agents.example:admin" as Did] },
  });

  it("gt matches when actual > expected", () => {
    expect(
      evaluatePolicy(makeActionPackage("transfer", { amount: 150 }), makeApprovals(0, []), basePolicy("gt", 100)).status,
    ).toBe("additionalApprovalsRequired");
  });

  it("gt falls through to default when actual <= expected", () => {
    expect(
      evaluatePolicy(makeActionPackage("transfer", { amount: 50 }), makeApprovals(0, []), basePolicy("gt", 100)),
    ).toEqual({ status: "satisfied" });
  });

  it("eq matches string equality", () => {
    const policy: PolicyConfig = {
      defaultRequirement: { type: "proposerOnly" },
      policies: {
        transfer: [
          {
            match: { conditions: [{ source: "executionPayload", path: "/arguments/repo", op: "eq", value: "special" }] },
            requirements: { type: "threshold", threshold: 1, eligibleSignerGroup: "admins", decision: "approve" },
          },
        ],
      },
      signerGroups: { admins: ["did:web:agents.example:admin" as Did] },
    };

    expect(
      evaluatePolicy(makeActionPackage("transfer", { repo: "special" }), makeApprovals(0, []), policy).status,
    ).toBe("additionalApprovalsRequired");
    expect(
      evaluatePolicy(makeActionPackage("transfer", { repo: "other" }), makeApprovals(0, []), policy),
    ).toEqual({ status: "satisfied" });
  });

  it("neq / in / notIn / exists / contains / prefix operators", () => {
    const cases: Array<{ op: string; value?: unknown; args: Record<string, unknown>; matches: boolean }> = [
      { op: "neq", value: "main", args: { amount: "dev" }, matches: true },
      { op: "neq", value: "main", args: { amount: "main" }, matches: false },
      { op: "in", value: ["a", "b"], args: { amount: "a" }, matches: true },
      { op: "in", value: ["a", "b"], args: { amount: "c" }, matches: false },
      { op: "notIn", value: ["a", "b"], args: { amount: "c" }, matches: true },
      { op: "exists", args: { amount: 1 }, matches: true },
      { op: "notExists", args: {}, matches: true },
      { op: "contains", value: "sec", args: { amount: ["sec", "other"] }, matches: true },
      { op: "prefix", value: "sec", args: { amount: "security" }, matches: true },
      { op: "gte", value: 10, args: { amount: 10 }, matches: true },
      { op: "lt", value: 10, args: { amount: 9 }, matches: true },
      { op: "lte", value: 10, args: { amount: 10 }, matches: true },
    ];

    for (const testCase of cases) {
      const policy = basePolicy(testCase.op, testCase.value);
      // For exists/notExists the path is /arguments/amount — adjust args accordingly.
      const pkg = makeActionPackage("transfer", testCase.args);
      if (testCase.op === "notExists") {
        delete (pkg.executionPayload as { arguments: Record<string, unknown> }).arguments.amount;
        delete (pkg.executionPayload as { arguments: Record<string, unknown> }).arguments.owner;
        delete (pkg.executionPayload as { arguments: Record<string, unknown> }).arguments.repo;
      }
      const result = evaluatePolicy(pkg, makeApprovals(0, []), policy);
      if (testCase.matches) {
        expect(result.status, testCase.op).toBe("additionalApprovalsRequired");
      } else {
        expect(result, testCase.op).toEqual({ status: "satisfied" });
      }
    }
  });

  it("matches conditions against actionEnvelope source", () => {
    const policy: PolicyConfig = {
      defaultRequirement: { type: "proposerOnly" },
      policies: {
        transfer: [
          {
            match: {
              conditions: [
                { source: "actionEnvelope", path: "/proposer/did", op: "eq", value: "did:web:agents.example:proposer" },
              ],
            },
            requirements: { type: "threshold", threshold: 1, eligibleSignerGroup: "admins", decision: "approve" },
          },
        ],
      },
      signerGroups: { admins: ["did:web:agents.example:admin" as Did] },
    };

    expect(evaluatePolicy(makeActionPackage("transfer"), makeApprovals(0, []), policy).status).toBe(
      "additionalApprovalsRequired",
    );
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

  it("resolves eligibleSigners without a signer group", () => {
    const admin = "did:web:agents.example:admin" as Did;
    const policy: PolicyConfig = {
      defaultRequirement: {
        type: "threshold",
        threshold: 1,
        eligibleSigners: [admin],
        decision: "approve",
      },
    };

    expect(
      evaluatePolicy(
        makeActionPackage("transfer"),
        {
          actionEnvelopeHash: { alg: "sha-256", value: "fake-hash" },
          approvals: [
            { approval: {} as never, signerDid: admin, decision: "approve", createdAt: "2026-06-01T00:00:00.000Z" },
          ],
        },
        policy,
      ),
    ).toEqual({ status: "satisfied" });
  });

  it("treats a threshold with neither group nor signers as an empty eligible set", () => {
    const policy: PolicyConfig = {
      defaultRequirement: {
        type: "threshold",
        threshold: 1,
        decision: "approve",
      } as PolicyConfig["defaultRequirement"],
    };

    expect(evaluatePolicy(makeActionPackage("transfer"), makeApprovals(0, []), policy)).toMatchObject({
      status: "additionalApprovalsRequired",
    });
  });

  it("decodes JSON Pointer escapes in condition paths", () => {
    const policy: PolicyConfig = {
      defaultRequirement: { type: "proposerOnly" },
      policies: {
        transfer: [
          {
            match: {
              conditions: [
                { source: "executionPayload", path: "/arguments/a~1b", op: "eq", value: "escaped" },
              ],
            },
            requirements: { type: "threshold", threshold: 1, eligibleSigners: ["did:web:agents.example:admin" as Did], decision: "approve" },
          },
        ],
      },
    };

    const pkg = makeActionPackage("transfer");
    (pkg.executionPayload as { arguments: Record<string, unknown> }).arguments["a/b"] = "escaped";

    expect(evaluatePolicy(pkg, makeApprovals(0, []), policy).status).toBe("additionalApprovalsRequired");
  });

  it("treats an unknown signer group as an empty eligible set", () => {
    const policy: PolicyConfig = {
      defaultRequirement: {
        type: "threshold",
        threshold: 1,
        eligibleSignerGroup: "missing",
        decision: "approve",
      },
      signerGroups: {
        all: [MAINTAINER_A],
        maintainers: [MAINTAINER_A],
      },
    };

    expect(evaluatePolicy(makeActionPackage("transfer"), makeApprovals(1, [MAINTAINER_A]), policy)).toMatchObject({
      status: "additionalApprovalsRequired",
    });
  });

  it("falls back to defaultRequirement when the payload has no operation name", () => {
    const policy: PolicyConfig = {
      defaultRequirement: { type: "proposerOnly" },
      policies: {
        transfer: [
          {
            requirements: {
              type: "threshold",
              threshold: 1,
              eligibleSigners: [MAINTAINER_A],
              decision: "approve",
            },
          },
        ],
      },
    };
    const pkg = makeActionPackage("transfer");
    delete (pkg.executionPayload as { name?: string }).name;

    expect(evaluatePolicy(pkg, makeApprovals(0, []), policy)).toEqual({ status: "satisfied" });
  });

  it("ignores abstain decisions when the threshold requires approve", () => {
    const policy: PolicyConfig = {
      defaultRequirement: {
        type: "threshold",
        threshold: 1,
        eligibleSignerGroup: "maintainers",
        decision: "approve",
      },
      signerGroups: {
        all: [MAINTAINER_A],
        maintainers: [MAINTAINER_A],
      },
    };

    const result = evaluatePolicy(
      makeActionPackage("transfer"),
      makeApprovals(1, [MAINTAINER_A], "abstain"),
      policy,
    );
    expect(result.status).toBe("additionalApprovalsRequired");
    if (result.status === "additionalApprovalsRequired") {
      expect(result.unsatisfiedRules[0]).toMatchObject({ found: 0, threshold: 1 });
    }
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

  it("returns unsatisfied rules from the first anyOf branch when none succeed", () => {
    const policy: PolicyConfig = {
      defaultRequirement: {
        type: "anyOf",
        requirements: [
          { type: "threshold", threshold: 2, eligibleSignerGroup: "maintainers", decision: "approve" },
          { type: "threshold", threshold: 1, eligibleSignerGroup: "security", decision: "approve" },
        ],
      },
      signerGroups: {
        all: [MAINTAINER_A, SEC_REVIEWER],
        maintainers: [MAINTAINER_A],
        security: [SEC_REVIEWER],
      },
    };

    const result = evaluatePolicy(makeActionPackage("transfer"), makeApprovals(0, []), policy);
    expect(result.status).toBe("additionalApprovalsRequired");
    if (result.status === "additionalApprovalsRequired") {
      expect(result.unsatisfiedRules[0]).toMatchObject({ threshold: 2, found: 0 });
    }
  });

  it("treats an unknown requirement type as vacuously satisfied at evaluate time", () => {
    const policy: PolicyConfig = {
      defaultRequirement: { type: "mystery" } as never,
      signerGroups: { all: [MAINTAINER_A] },
    };
    expect(evaluatePolicy(makeActionPackage("transfer"), makeApprovals(0, []), policy)).toEqual({
      status: "satisfied",
    });
  });

  it("treats an unknown condition operator as a non-match", () => {
    const policy: PolicyConfig = {
      defaultRequirement: { type: "proposerOnly" },
      policies: {
        transfer: [
          {
            match: {
              conditions: [
                { source: "executionPayload", path: "/arguments/owner", op: "regex" as never, value: "org" },
              ],
            },
            requirements: {
              type: "threshold",
              threshold: 1,
              eligibleSignerGroup: "maintainers",
              decision: "approve",
            },
          },
        ],
      },
      signerGroups: {
        all: [MAINTAINER_A],
        maintainers: [MAINTAINER_A],
      },
    };

    expect(evaluatePolicy(makeActionPackage("transfer"), makeApprovals(0, []), policy)).toEqual({
      status: "satisfied",
    });
  });

  it("resolves an empty JSON pointer to the whole source document", () => {
    const policy: PolicyConfig = {
      defaultRequirement: {
        type: "threshold",
        threshold: 1,
        eligibleSignerGroup: "maintainers",
        decision: "approve",
      },
      policies: {
        transfer: [
          {
            match: {
              conditions: [{ source: "executionPayload", path: "", op: "exists" }],
            },
            requirements: { type: "proposerOnly" },
          },
        ],
      },
      signerGroups: {
        all: [MAINTAINER_A],
        maintainers: [MAINTAINER_A],
      },
    };

    expect(evaluatePolicy(makeActionPackage("transfer"), makeApprovals(0, []), policy)).toEqual({
      status: "satisfied",
    });
  });

  it("returns undefined when a JSON pointer descends into a scalar", () => {
    const policy: PolicyConfig = {
      defaultRequirement: { type: "proposerOnly" },
      policies: {
        transfer: [
          {
            match: {
              conditions: [
                { source: "executionPayload", path: "/arguments/owner/nope", op: "eq", value: "x" },
              ],
            },
            requirements: {
              type: "threshold",
              threshold: 1,
              eligibleSignerGroup: "maintainers",
              decision: "approve",
            },
          },
        ],
      },
      signerGroups: {
        all: [MAINTAINER_A],
        maintainers: [MAINTAINER_A],
      },
    };

    expect(evaluatePolicy(makeActionPackage("transfer"), makeApprovals(0, []), policy)).toEqual({
      status: "satisfied",
    });
  });

  it("compares bigint values in numeric conditions", () => {
    const policy: PolicyConfig = {
      defaultRequirement: { type: "proposerOnly" },
      policies: {
        transfer: [
          {
            match: {
              conditions: [{ source: "executionPayload", path: "/arguments/amount", op: "gt", value: 5 }],
            },
            requirements: {
              type: "threshold",
              threshold: 1,
              eligibleSignerGroup: "maintainers",
              decision: "approve",
            },
          },
        ],
      },
      signerGroups: {
        all: [MAINTAINER_A],
        maintainers: [MAINTAINER_A],
      },
    };

    const result = evaluatePolicy(
      makeActionPackage("transfer", { amount: 10n as unknown as number }),
      makeApprovals(0, []),
      policy,
    );
    expect(result.status).toBe("additionalApprovalsRequired");
  });

  it("rethrows non-numeric condition evaluation errors", () => {
    const explodingPayload = {
      name: "transfer",
      get arguments() {
        throw new Error("pointer boom");
      },
    };

    const policy: PolicyConfig = {
      defaultRequirement: { type: "proposerOnly" },
      policies: {
        transfer: [
          {
            match: {
              conditions: [{ source: "executionPayload", path: "/arguments/amount", op: "eq", value: 1 }],
            },
            requirements: { type: "proposerOnly" },
          },
        ],
      },
      signerGroups: {
        all: [MAINTAINER_A],
        maintainers: [MAINTAINER_A],
      },
    };

    expect(() =>
      evaluatePolicy(
        {
          executionPayload: explodingPayload,
          actionEnvelope: { proposer: { did: MAINTAINER_A }, actionId: { value: "urn:uuid:x" } },
        } as never,
        makeApprovals(0, []),
        policy,
      ),
    ).toThrow(/pointer boom/);
  });
});
