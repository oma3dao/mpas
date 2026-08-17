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

  it("rejects missing signerGroups", () => {
    expect(validatePolicyConfig({ defaultRequirement: { type: "proposerOnly" } } as PolicyConfig)).toMatchObject({
      ok: false,
      message: expect.stringContaining("signerGroups"),
    });
  });

  it("rejects non-object policy context", () => {
    const policy = { ...validPolicy(), context: "nope" } as unknown as PolicyConfig;
    expect(validatePolicyConfig(policy)).toMatchObject({
      ok: false,
      message: expect.stringContaining("context must be an object"),
    });
  });

  it("rejects duplicate DIDs in signerGroups", () => {
    const policy = validPolicy();
    policy.signerGroups = {
      all: [proposer, proposer],
      maintainers: [maintainer],
    };
    expect(validatePolicyConfig(policy)).toMatchObject({
      ok: false,
      message: expect.stringContaining("unique DIDs"),
    });
  });

  it("rejects policies that are not an object keyed by operation", () => {
    const policy = { ...validPolicy(), policies: [] as unknown as PolicyConfig["policies"] };
    expect(validatePolicyConfig(policy)).toMatchObject({
      ok: false,
      message: expect.stringContaining("keyed by operation name"),
    });
  });

  it("rejects a non-array policy entry list", () => {
    const policy = {
      ...validPolicy(),
      policies: { create_issue: { requirements: { type: "proposerOnly" } } },
    } as unknown as PolicyConfig;
    expect(validatePolicyConfig(policy)).toMatchObject({
      ok: false,
      message: expect.stringContaining("must be an array"),
    });
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

  it("rejects invalid match source and op", () => {
    const policy = validPolicy();
    policy.policies = {
      create_issue: [
        {
          match: {
            conditions: [{ source: "payload", path: "/x", op: "eq", value: 1 }],
          },
          requirements: { type: "proposerOnly" },
        },
      ],
    };
    expect(validatePolicyConfig(policy)).toMatchObject({
      ok: false,
      message: expect.stringContaining("source is invalid"),
    });

    policy.policies = {
      create_issue: [
        {
          match: {
            conditions: [{ source: "executionPayload", path: "/x", op: "regex", value: "a" }],
          },
          requirements: { type: "proposerOnly" },
        },
      ],
    };
    expect(validatePolicyConfig(policy)).toMatchObject({
      ok: false,
      message: expect.stringContaining("op is invalid"),
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

  it("rejects threshold with both group and eligibleSigners", () => {
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

  it("accepts allOf nesting and reject-only entries", () => {
    const policy = validPolicy();
    policy.defaultRequirement = {
      type: "allOf",
      requirements: [
        { type: "threshold", threshold: 1, eligibleSignerGroup: "maintainers", decision: "approve" },
        { type: "proposerOnly" },
      ],
    };
    policy.policies = {
      dangerous: [
        {
          reject: true,
          description: "blocked",
          match: {
            conditions: [{ source: "actionEnvelope", path: "/proposer/did", op: "eq", value: proposer }],
          },
        },
      ],
    };
    expect(validatePolicyConfig(policy)).toEqual({ ok: true });
  });

  it("rejects unsupported fields on proposerOnly", () => {
    const policy = validPolicy();
    policy.defaultRequirement = { type: "proposerOnly", decision: "approve" } as unknown as PolicyConfig["defaultRequirement"];
    expect(validatePolicyConfig(policy)).toMatchObject({
      ok: false,
      message: expect.stringContaining("unsupported fields"),
    });
  });

  it.each([
    [{ policies: { op: [null] } }, "must be an object"],
    [{ policies: { op: [{ reject: true, extra: 1 }] } }, "unsupported"],
    [{ policies: { op: [{ reject: true, description: 1 }] } }, "description"],
    [{ policies: { op: [{ reject: true, match: "x" }] } }, "match"],
    [{ policies: { op: [{ reject: true, match: { conditions: "x" } }] } }, "conditions"],
    [
      {
        policies: {
          op: [
            {
              reject: true,
              match: { conditions: [{ source: "executionPayload", op: "eq", value: 1 }] },
            },
          ],
        },
      },
      "path is required",
    ],
    [{ defaultRequirement: { type: "mystery" } }, "type is invalid"],
    [
      {
        defaultRequirement: {
          type: "threshold",
          threshold: 1,
          eligibleSignerGroup: "maintainers",
          extra: true,
        },
      },
      "unsupported",
    ],
    [{ signerGroups: { all: [proposer, maintainer], maintainers: [] } }, "signerGroups.maintainers"],
    [{ policies: { op: [{ reject: "yes", requirements: { type: "proposerOnly" } }] } }, "reject must be a boolean"],
    [{ policies: { op: [{ reject: true, context: "nope" }] } }, "context must be an object"],
    [
      {
        policies: {
          op: [
            {
              reject: true,
              match: { conditions: [{ source: "executionPayload", path: "/x", op: "eq", value: 1, extra: 1 }] },
            },
          ],
        },
      },
      "unsupported fields",
    ],
    [
      {
        defaultRequirement: {
          type: "threshold",
          threshold: 1,
          eligibleSignerGroup: "maintainers",
          decision: "approve",
          description: 1,
        },
      },
      "description must be a string",
    ],
    [
      {
        defaultRequirement: {
          type: "allOf",
          requirements: [{ type: "proposerOnly" }],
          extra: true,
        },
      },
      "allOf has unsupported fields",
    ],
  ])("rejects malformed policy shape %#", (patch, needle) => {
    const policy = { ...validPolicy(), ...patch } as ReturnType<typeof validPolicy>;
    expect(validatePolicyConfig(policy)).toMatchObject({
      ok: false,
      message: expect.stringMatching(new RegExp(needle, "i")),
    });
  });

  it("accepts notExists conditions without a path", () => {
    const policy = validPolicy();
    policy.policies = {
      op: [
        {
          match: {
            conditions: [{ source: "executionPayload", op: "notExists" }],
          },
          requirements: { type: "proposerOnly" },
        },
      ],
    };
    expect(validatePolicyConfig(policy)).toEqual({ ok: true });
  });

  it("rejects non-object defaultRequirement values", () => {
    const base = validPolicy();
    expect(validatePolicyConfig({ ...base, defaultRequirement: null } as unknown as PolicyConfig)).toMatchObject({
      ok: false,
      message: expect.stringContaining("approval requirement object"),
    });
    expect(validatePolicyConfig({ ...base, defaultRequirement: "x" } as unknown as PolicyConfig)).toMatchObject({
      ok: false,
      message: expect.stringContaining("approval requirement object"),
    });
  });
});
