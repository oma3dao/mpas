import { describe, expect, it } from "vitest";
import { trustContextFromEnvironment } from "../../src/adapter/trust-environment.js";
import { DEFAULT_TRUST_CONTEXT } from "../../src/adapter/trust.js";
const valid = {
  MPAS_ARTIFACT_TRUST_API_URL: "https://trust.example/v1/artifact-trust",
  MPAS_ARTIFACT_TRUST_CHAIN_ID: "66238",
  MPAS_ARTIFACT_TRUST_EAS_CONTRACT: "0x8835AF90f1537777F52E482C8630cE4e947eCa32",
};
describe("operator artifact trust override", () => {
  it("preserves the mainnet default without overrides", () => {
    expect(trustContextFromEnvironment({})).toEqual(DEFAULT_TRUST_CONTEXT);
    expect(trustContextFromEnvironment({}).expectedChain.chainId).toBe(6623);
  });
  it("binds an explicit endpoint to its chain and contract", () => {
    expect(trustContextFromEnvironment(valid)).toEqual({
      artifactTrustApiUrl: valid.MPAS_ARTIFACT_TRUST_API_URL,
      expectedChain: { chainId: 66238, easContract: valid.MPAS_ARTIFACT_TRUST_EAS_CONTRACT },
    });
  });
  it.each(Object.keys(valid))("rejects a partial tuple missing %s", key => {
    const env: NodeJS.ProcessEnv = { ...valid }; delete env[key];
    expect(() => trustContextFromEnvironment(env)).toThrow("requires all");
  });
  it.each(["http://trust.example", "https://user:secret@trust.example", "https://trust.example?a=b", "https://trust.example/#x", "not a URL"])("rejects unsafe endpoint %s", url => {
    expect(() => trustContextFromEnvironment({ ...valid, MPAS_ARTIFACT_TRUST_API_URL: url })).toThrow();
  });
  it.each(["0", "-1", "1.5", "1e3", "9007199254740993"])("rejects invalid chain %s", chain => {
    expect(() => trustContextFromEnvironment({ ...valid, MPAS_ARTIFACT_TRUST_CHAIN_ID: chain })).toThrow();
  });
  it("rejects malformed EAS addresses", () => {
    expect(() => trustContextFromEnvironment({ ...valid, MPAS_ARTIFACT_TRUST_EAS_CONTRACT: "0x123" })).toThrow();
  });
});
