import { describe, expect, it } from "vitest";
import { validatePolicyConfig, type PolicyConfig } from "../../src/lib/policy-engine.js";
import type { Did } from "../../src/types/mpas.js";

const proposer = "did:web:agents.example:proposer" as Did;
const maintainer = "did:web:agents.example:maintainer" as Did;

function validPolicy(): PolicyConfig {
  return {
    defaultRequirement: {
      type: "threshold",
      threshold: 1,
      eligibleSignerGroup: "maintainers",
      decision: "approve",
    },
    signerGroups: {
      all: [proposer, maintainer],
      proposers: [proposer],
      maintainers: [maintainer],
    },
  };
}

describe("validatePolicyConfig", () => {
  it("accepts a conforming threshold policy", () => {
    expect(validatePolicyConfig(validPolicy())).toEqual({ ok: true });
  });

  it("rejects a zero threshold, which the profile does not permit", () => {
    const policy = validPolicy();
    policy.defaultRequirement = {
      type: "threshold",
      threshold: 0,
      eligibleSignerGroup: "maintainers",
    };

    expect(validatePolicyConfig(policy)).toMatchObject({ ok: false, message: expect.stringContaining("positive integer") });
  });

  it("rejects threshold requirements that name an unknown signer group", () => {
    const policy = validPolicy();
    policy.defaultRequirement = {
      type: "threshold",
      threshold: 1,
      eligibleSignerGroup: "missing",
    };

    expect(validatePolicyConfig(policy)).toMatchObject({ ok: false, message: expect.stringContaining("does not exist") });
  });

  it("rejects empty composed requirements", () => {
    const policy = validPolicy();
    policy.defaultRequirement = { type: "anyOf", requirements: [] };

    expect(validatePolicyConfig(policy)).toMatchObject({ ok: false, message: expect.stringContaining("non-empty") });
  });

  it("rejects reject decisions in approval requirements", () => {
    const policy = validPolicy();
    policy.defaultRequirement = {
      type: "threshold",
      threshold: 1,
      eligibleSignerGroup: "maintainers",
      decision: "reject",
    };

    expect(validatePolicyConfig(policy)).toMatchObject({ ok: false, message: expect.stringContaining("decision is invalid") });
  });

  it("rejects entries that both reject and require approvals", () => {
    const policy = validPolicy();
    policy.policies = {
      create_issue: [
        {
          reject: true,
          requirements: { type: "proposerOnly" },
        } as unknown as (typeof policy.policies)[string][number],
      ],
    };

    expect(validatePolicyConfig(policy)).toMatchObject({
      ok: false,
      message: expect.stringContaining("either reject: true or requirements"),
    });
  });

  it("accepts eligibleSigners instead of a group name", () => {
    const policy = validPolicy();
    policy.defaultRequirement = {
      type: "threshold",
      threshold: 1,
      eligibleSigners: [maintainer],
      decision: "approve",
    };

    expect(validatePolicyConfig(policy)).toEqual({ ok: true });
  });

  it("rejects a threshold that names both a group and eligibleSigners", () => {
    const policy = validPolicy();
    policy.defaultRequirement = {
      type: "threshold",
      threshold: 1,
      eligibleSignerGroup: "maintainers",
      eligibleSigners: [maintainer],
      decision: "approve",
    };

    expect(validatePolicyConfig(policy)).toMatchObject({
      ok: false,
      message: expect.stringContaining("exactly one of eligibleSignerGroup or eligibleSigners"),
    });
  });
});
