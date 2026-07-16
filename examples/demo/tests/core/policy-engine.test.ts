import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluatePolicy, type PolicyConfig } from "../../src/core/policy-engine.js";
import { verifyActionPackage, type TrustedSigner, type VerificationConfig } from "../../src/core/verification.js";
import type { ActionPackage, Did } from "../../src/core/types.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

interface KeyFixture {
  did: Did;
  publicJwk: TrustedSigner["publicJwk"];
}

interface DeploymentConfig {
  policy: {
    version: "1";
    type: "MpasApplicationPolicy";
    defaultRequirement: PolicyConfig["defaultRequirement"];
    signerGroups: Record<string, Did[]>;
    policies?: Record<string, Array<{
      description?: string;
      match?: { conditions?: Array<{ source: string; path: string; op: string; value?: unknown }> };
      requirements: PolicyConfig["defaultRequirement"];
    }>>;
  };
  signerKeys: Array<{ did: Did; label?: string; publicJwk: unknown }>;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function trustedSigners(): Promise<TrustedSigner[]> {
  const proposer = await readJson<KeyFixture>(join(fixturesDir, "test-keys", "proposer.json"));
  const maintainerA = await readJson<KeyFixture>(join(fixturesDir, "test-keys", "maintainer-a.json"));
  const maintainerB = await readJson<KeyFixture>(join(fixturesDir, "test-keys", "maintainer-b.json"));

  return [
    { did: proposer.did, publicJwk: proposer.publicJwk },
    { did: maintainerA.did, publicJwk: maintainerA.publicJwk },
    { did: maintainerB.did, publicJwk: maintainerB.publicJwk },
  ];
}

async function verificationConfig(): Promise<VerificationConfig> {
  return {
    trustedSigners: await trustedSigners(),
    trustedApplicationDids: ["did:web:github.example"],
  };
}

async function verifiedFixture(file: string) {
  const actionPackage = await readJson<ActionPackage>(join(fixturesDir, "core", file));
  const verification = await verifyActionPackage(actionPackage, await verificationConfig());
  if (verification.status !== "verified") {
    throw new Error(`Fixture did not verify: ${file}`);
  }

  return { actionPackage, verifiedApprovals: verification.verifiedApprovals };
}

async function policyFromConfig(file: string): Promise<PolicyConfig> {
  const config = await readJson<DeploymentConfig>(join(fixturesDir, "configs", file));

  return {
    defaultRequirement: config.policy.defaultRequirement,
    policies: config.policy.policies as PolicyConfig["policies"],
    signerGroups: config.policy.signerGroups,
  };
}

describe("evaluatePolicy", () => {
  it("satisfies valid-no-approval-required.json with auto-approve config", async () => {
    const { actionPackage, verifiedApprovals } = await verifiedFixture("valid-no-approval-required.json");

    expect(evaluatePolicy(actionPackage, verifiedApprovals, await policyFromConfig("github-auto-approve.json"))).toEqual({
      status: "satisfied",
    });
  });

  it("requires additional approvals for insufficient-approvals.json with strict config", async () => {
    const { actionPackage, verifiedApprovals } = await verifiedFixture("insufficient-approvals.json");
    const result = evaluatePolicy(actionPackage, verifiedApprovals, await policyFromConfig("github-strict.json"));

    expect(result).toMatchObject({
      status: "additionalApprovalsRequired",
      unsatisfiedRules: [
        {
          requiredRole: "maintainers",
          requiredDecision: "approve",
          threshold: 2,
          found: 0,
        },
      ],
    });
  });

  it("satisfies valid-two-approvals.json with strict config", async () => {
    const { actionPackage, verifiedApprovals } = await verifiedFixture("valid-two-approvals.json");

    expect(evaluatePolicy(actionPackage, verifiedApprovals, await policyFromConfig("github-strict.json"))).toEqual({
      status: "satisfied",
    });
  });

  it("satisfies operations that were previously gated by enabledOperations (now removed)", async () => {
    const { actionPackage, verifiedApprovals } = await verifiedFixture("invalid-disabled-operation.json");

    // With enabledOperations removed, the policy engine no longer rejects operations
    // not in an allowlist. The auto-approve config has proposerOnly default, so any
    // operation passes through policy evaluation.
    expect(evaluatePolicy(actionPackage, verifiedApprovals, await policyFromConfig("github-auto-approve.json"))).toMatchObject({
      status: "satisfied",
    });
  });

  it("does not count self-approvals toward threshold (defense in depth)", async () => {
    const { actionPackage, verifiedApprovals } = await verifiedFixture("insufficient-approvals.json");
    const proposerDid = actionPackage.actionEnvelope.proposer.did;

    // Inject a fake self-approval from the proposer
    verifiedApprovals.approvals.push({
      approval: {} as never,
      signerDid: proposerDid,
      decision: "approve",
      createdAt: "2026-06-05T18:03:00.000Z",
    });

    const result = evaluatePolicy(actionPackage, verifiedApprovals, await policyFromConfig("github-strict.json"));

    // The self-approval should not satisfy the threshold — still requires additional approvals
    expect(result).toMatchObject({
      status: "additionalApprovalsRequired",
      unsatisfiedRules: [
        {
          requiredRole: "maintainers",
          requiredDecision: "approve",
          threshold: 2,
          found: 0,
        },
      ],
    });
  });
});
