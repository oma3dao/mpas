import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAuthorizationRequirements } from "../../src/lib/auth-requirements-builder.js";
import { evaluatePolicy, type PolicyConfig } from "../../src/lib/policy-engine.js";
import { computeJsonHash, verifyActionPackage, type TrustedSigner } from "../../src/lib/verification.js";
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

describe("buildAuthorizationRequirements (sdk)", () => {
  it("builds well-formed requirements bound to the Action Envelope hash", async () => {
    const actionPackage = await readJson<ActionPackage>(join(fixturesDir, "core", "insufficient-approvals.json"));
    const verification = await verifyActionPackage(actionPackage, {
      trustedSigners: await trustedSigners(),
      trustedApplicationDids: ["did:web:github-mirror.example"],
    });
    if (verification.status !== "verified") {
      throw new Error("fixture should verify before policy evaluation");
    }

    const config = await readJson<DeploymentConfig>(
      join(fixturesDir, "configs", "github-mirror-adapter-config.json"),
    );
    const policy: PolicyConfig = {
      defaultRequirement: config.policy.defaultRequirement,
      policies: config.policy.policies,
      signerGroups: config.policy.signerGroups,
    };
    const policyResult = evaluatePolicy(actionPackage, verification.verifiedApprovals, policy);
    if (policyResult.status !== "additionalApprovalsRequired") {
      throw new Error("fixture should require additional approvals");
    }

    const adapter = await readJson<KeyFixture>(join(fixturesDir, "test-keys", "adapter.json"));
    const requirements = buildAuthorizationRequirements(
      actionPackage.actionEnvelope,
      policyResult.unsatisfiedRules,
      adapter.did,
    );

    expect(requirements).toMatchObject({
      version: "1",
      type: "AuthorizationRequirements",
      actionEnvelopeHash: computeJsonHash(actionPackage.actionEnvelope),
      result: "additionalApprovalsRequired",
      verifier: {
        did: adapter.did,
      },
      approvalRequirements: {
        anyOf: [
          {
            type: "threshold",
            threshold: 2,
            decision: "approve",
          },
        ],
      },
      expiresAt: actionPackage.actionEnvelope.expiresAt,
    });
    if (requirements.result !== "additionalApprovalsRequired") {
      throw new Error("requirements should request additional approvals");
    }
    expect(requirements.approvalRequirements.anyOf?.[0].eligibleSigners).toHaveLength(2);
  });
});
