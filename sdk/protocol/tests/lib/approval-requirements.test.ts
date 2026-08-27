import { describe, expect, it } from "vitest";
import {
  evaluateApprovalRequirements,
  type ApprovalRequirements,
  type Did,
} from "../../src/index.js";

const alice = "did:jwk:alice" as Did;
const bob = "did:jwk:bob" as Did;
const carol = "did:jwk:carol" as Did;

describe("evaluateApprovalRequirements", () => {
  const twoOfThree: ApprovalRequirements = {
    anyOf: [{ type: "threshold", threshold: 2, eligibleSigners: [alice, bob, carol] }],
  };

  it("distinguishes satisfied, pending, and unreachable threshold expressions", () => {
    expect(evaluateApprovalRequirements(twoOfThree, [])).toBe("pending");
    expect(evaluateApprovalRequirements(twoOfThree, [
      { signerDid: alice, decision: "approve" },
      { signerDid: bob, decision: "approve" },
    ])).toBe("satisfied");
    expect(evaluateApprovalRequirements(twoOfThree, [
      { signerDid: alice, decision: "reject" },
      { signerDid: bob, decision: "abstain" },
    ])).toBe("unreachable");
  });

  it("requires one reachable anyOf path and every reachable allOf path", () => {
    const requirements: ApprovalRequirements = {
      anyOf: [
        { type: "threshold", threshold: 1, eligibleSigners: [alice] },
        { type: "threshold", threshold: 1, eligibleSigners: [bob] },
      ],
      allOf: [{ type: "threshold", threshold: 1, eligibleSigners: [carol] }],
    };
    expect(evaluateApprovalRequirements(requirements, [
      { signerDid: alice, decision: "reject" },
      { signerDid: bob, decision: "approve" },
    ])).toBe("pending");
    expect(evaluateApprovalRequirements(requirements, [
      { signerDid: alice, decision: "reject" },
      { signerDid: bob, decision: "approve" },
      { signerDid: carol, decision: "reject" },
    ])).toBe("unreachable");
  });

  it("honors approval and rejection overrides", () => {
    const requirements: ApprovalRequirements = {
      anyOf: [{ type: "threshold", threshold: 1, eligibleSigners: [alice] }],
      overrideSigners: [{ signer: carol, permissions: ["approve", "reject"] }],
    };
    expect(evaluateApprovalRequirements(requirements, [{ signerDid: alice, decision: "reject" }])).toBe("pending");
    expect(evaluateApprovalRequirements(requirements, [{ signerDid: carol, decision: "approve" }])).toBe("satisfied");
    expect(evaluateApprovalRequirements(requirements, [{ signerDid: carol, decision: "reject" }])).toBe("unreachable");
  });

  it("accepts duplicate identical decisions and rejects conflicting decisions", () => {
    expect(evaluateApprovalRequirements(twoOfThree, [
      { signerDid: alice, decision: "approve" },
      { signerDid: alice, decision: "approve" },
    ])).toBe("pending");
    expect(() => evaluateApprovalRequirements(twoOfThree, [
      { signerDid: alice, decision: "approve" },
      { signerDid: alice, decision: "reject" },
    ])).toThrow("conflicting decisions");
  });

  it("reports a structurally unachievable threshold as unreachable immediately", () => {
    expect(evaluateApprovalRequirements({
      anyOf: [{ type: "threshold", threshold: 2, eligibleSigners: [alice] }],
    }, [])).toBe("unreachable");
  });
});
