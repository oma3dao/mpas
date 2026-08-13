import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluatePolicy, type PolicyConfig } from "../../src/lib/policy-engine.js";
import { verifyActionPackage, type TrustedSigner, type VerificationConfig } from "../../src/lib/verification.js";
import type { ActionPackage, Did } from "../../src/types/mpas.js";

const fixturesDir = fileURLToPath(new URL("../../../../examples/demo/tests/fixtures/", import.meta.url));

interface KeyFixture {
  did: Did;
  publicJwk: TrustedSigner["publicJwk"];
}

interface DeploymentConfig {
  policy: {
    defaultRequirement: PolicyConfig["defaultRequirement"];
    signerGroups: Record<string, Did[]>;
    policies?: PolicyConfig["policies"];
  };
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
    trustedApplicationDids: ["did:web:github-mirror.example"],
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
    policies: config.policy.policies,
    signerGroups: config.policy.signerGroups,
  };
}

describe("evaluatePolicy fixtures (sdk)", () => {
  it("satisfies valid-no-approval-required.json with auto-approve config", async () => {
    const { actionPackage, verifiedApprovals } = await verifiedFixture("valid-no-approval-required.json");

    expect(
      evaluatePolicy(actionPackage, verifiedApprovals, await policyFromConfig("policy-fixtures/github-auto-approve.json")),
    ).toEqual({
      status: "satisfied",
    });
  });

  it("requires additional approvals for insufficient-approvals.json", async () => {
    const { actionPackage, verifiedApprovals } = await verifiedFixture("insufficient-approvals.json");
    const result = evaluatePolicy(
      actionPackage,
      verifiedApprovals,
      await policyFromConfig("github-mirror-adapter-config.json"),
    );

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

    expect(
      evaluatePolicy(actionPackage, verifiedApprovals, await policyFromConfig("github-mirror-adapter-config.json")),
    ).toEqual({
      status: "satisfied",
    });
  });

  it("does not count self-approvals toward threshold", async () => {
    const { actionPackage, verifiedApprovals } = await verifiedFixture("insufficient-approvals.json");
    const proposerDid = actionPackage.actionEnvelope.proposer.did;

    verifiedApprovals.approvals.push({
      approval: {} as never,
      signerDid: proposerDid,
      decision: "approve",
      createdAt: "2026-06-05T18:03:00.000Z",
    });

    const result = evaluatePolicy(
      actionPackage,
      verifiedApprovals,
      await policyFromConfig("github-mirror-adapter-config.json"),
    );

    expect(result).toMatchObject({
      status: "additionalApprovalsRequired",
      unsatisfiedRules: [
        {
          requiredRole: "maintainers",
          threshold: 2,
          found: 0,
        },
      ],
    });
  });
});
