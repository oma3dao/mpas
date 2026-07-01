import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAuthorizationRequirements } from "../../src/core/auth-requirements-builder.js";
import { evaluatePolicy, type PolicyConfig } from "../../src/core/policy-engine.js";
import { computeJsonHash, verifyActionPackage, type TrustedSigner } from "../../src/core/verification.js";
import type { ActionPackage, Did } from "../../src/core/types.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

interface KeyFixture {
  did: Did;
  publicJwk: TrustedSigner["publicJwk"];
}

interface DeploymentConfig {
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
    resourceRestrictions: config.resourceRestrictions,
    eligibleSignersByRole,
  };
}

describe("buildAuthorizationRequirements", () => {
  it("builds well-formed requirements bound to the Action Envelope hash", async () => {
    const actionPackage = await readJson<ActionPackage>(join(fixturesDir, "core", "insufficient-approvals.json"));
    const verification = await verifyActionPackage(actionPackage, {
      trustedSigners: await trustedSigners(),
      trustedApplicationDids: ["did:web:github.example"],
    });
    if (verification.status !== "verified") {
      throw new Error("fixture should verify before policy evaluation");
    }

    const policyResult = evaluatePolicy(actionPackage, verification.verifiedApprovals, await policyFromConfig("github-strict.json"));
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
            threshold: 1,
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
