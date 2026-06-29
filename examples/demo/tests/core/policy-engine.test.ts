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
  enabledOperations: string[];
  resourceRestrictions: PolicyConfig["resourceRestrictions"];
  policy: Pick<PolicyConfig, "defaultPolicy" | "rules">;
  trustedSigners: Array<{ did: Did; roles: string[] }>;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function trustedSigners(): Promise<TrustedSigner[]> {
  const proposer = await readJson<KeyFixture>(join(fixturesDir, "test-keys", "proposer.json"));
  const maintainerA = await readJson<KeyFixture>(join(fixturesDir, "test-keys", "maintainer-a.json"));
  const maintainerB = await readJson<KeyFixture>(join(fixturesDir, "test-keys", "maintainer-b.json"));

  return [
    { did: proposer.did, roles: ["proposer"], publicJwk: proposer.publicJwk },
    { did: maintainerA.did, roles: ["maintainer"], publicJwk: maintainerA.publicJwk },
    { did: maintainerB.did, roles: ["maintainer"], publicJwk: maintainerB.publicJwk },
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
  const eligibleSignersByRole: Record<string, Did[]> = {};
  for (const signer of config.trustedSigners) {
    for (const role of signer.roles) {
      eligibleSignersByRole[role] ??= [];
      eligibleSignersByRole[role].push(signer.did);
    }
  }

  return {
    ...config.policy,
    enabledOperations: config.enabledOperations,
    resourceRestrictions: config.resourceRestrictions,
    eligibleSignersByRole,
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
          requiredRole: "maintainer",
          requiredDecision: "approve",
          threshold: 1,
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

  it("denies disabled operations", async () => {
    const { actionPackage, verifiedApprovals } = await verifiedFixture("invalid-disabled-operation.json");

    expect(evaluatePolicy(actionPackage, verifiedApprovals, await policyFromConfig("github-auto-approve.json"))).toMatchObject({
      status: "denied",
      code: "OPERATION_DISABLED",
    });
  });

  it("denies restricted resources", async () => {
    const { actionPackage, verifiedApprovals } = await verifiedFixture("invalid-resource-restricted.json");

    expect(evaluatePolicy(actionPackage, verifiedApprovals, await policyFromConfig("github-strict.json"))).toMatchObject({
      status: "denied",
      code: "RESOURCE_RESTRICTED",
    });
  });

  it("does not count self-approvals toward threshold (defense in depth)", async () => {
    const { actionPackage, verifiedApprovals } = await verifiedFixture("insufficient-approvals.json");
    const proposerDid = actionPackage.actionEnvelope.proposer.did;

    // Inject a fake self-approval from the proposer with role "maintainer"
    verifiedApprovals.approvals.push({
      approval: {} as never,
      signerDid: proposerDid,
      roles: ["maintainer"],
      decision: "approve",
      createdAt: "2026-06-05T18:03:00.000Z",
    });

    const result = evaluatePolicy(actionPackage, verifiedApprovals, await policyFromConfig("github-strict.json"));

    // The self-approval should not satisfy the threshold — still requires additional approvals
    expect(result).toMatchObject({
      status: "additionalApprovalsRequired",
      unsatisfiedRules: [
        {
          requiredRole: "maintainer",
          requiredDecision: "approve",
          threshold: 1,
          found: 0,
        },
      ],
    });
  });
});
