import { describe, expect, it } from "vitest";
import { checkProposerAuthorization, type PolicyConfig } from "../../src/lib/policy-engine.js";
import { applyFailClosedDefaults } from "../../src/lib/plugin-loader.js";
import type { Did } from "../../src/types/mpas.js";

const proposer = "did:web:agents.example:proposer" as Did;
const maintainer = "did:web:agents.example:maintainer" as Did;
const stranger = "did:web:agents.example:stranger" as Did;

function policy(signerGroups?: PolicyConfig["signerGroups"]): PolicyConfig {
  return { defaultRequirement: { type: "proposerOnly" }, signerGroups };
}

describe("checkProposerAuthorization", () => {
  it("allows a proposer listed in signerGroups.proposers", () => {
    expect(checkProposerAuthorization(proposer, policy({ proposers: [proposer], all: [proposer, maintainer] }))).toEqual({
      allowed: true,
    });
  });

  it("rejects a DID not in the proposers group even if in all", () => {
    const result = checkProposerAuthorization(maintainer, policy({ proposers: [proposer], all: [proposer, maintainer] }));
    expect(result.allowed).toBe(false);
  });

  it("falls back to signerGroups.all when proposers is absent", () => {
    expect(checkProposerAuthorization(maintainer, policy({ all: [proposer, maintainer] })).allowed).toBe(true);
    expect(checkProposerAuthorization(stranger, policy({ all: [proposer, maintainer] })).allowed).toBe(false);
  });

  it("fails closed when no proposer set is defined", () => {
    expect(checkProposerAuthorization(proposer, policy()).allowed).toBe(false);
    expect(checkProposerAuthorization(proposer, policy({})).allowed).toBe(false);
  });
});

describe("applyFailClosedDefaults", () => {
  it("injects additionalProperties: false where the schema is silent", () => {
    const result = applyFailClosedDefaults({
      type: "object",
      properties: { arguments: { type: "object", properties: { a: { type: "string" } } } },
    }) as Record<string, unknown>;

    expect(result.additionalProperties).toBe(false);
    const args = (result.properties as Record<string, Record<string, unknown>>).arguments;
    expect(args.additionalProperties).toBe(false);
  });

  it("leaves explicit additionalProperties untouched", () => {
    const result = applyFailClosedDefaults({ type: "object", additionalProperties: true }) as Record<string, unknown>;
    expect(result.additionalProperties).toBe(true);
  });

  it("does not mistake a property named 'properties' for a schema keyword map", () => {
    const result = applyFailClosedDefaults({
      type: "object",
      properties: {
        properties: { type: "string" },
      },
    }) as { properties: { properties: Record<string, unknown> } };

    // The inner value is a subschema for a property literally named "properties";
    // it declares type string, so no additionalProperties injection.
    expect(result.properties.properties).toEqual({ type: "string" });
  });

  it("recurses through composition keywords", () => {
    const result = applyFailClosedDefaults({
      allOf: [{ type: "object", properties: { a: { type: "string" } } }],
    }) as { allOf: Array<Record<string, unknown>> };

    expect(result.allOf[0].additionalProperties).toBe(false);
  });

  it("does not modify non-object leaf values or unknown keywords", () => {
    const schema = { type: "string", enum: ["a", "b"], description: "leaf" };
    expect(applyFailClosedDefaults(schema)).toEqual(schema);
  });
});
