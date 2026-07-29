import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTrustReport, canTrust, type TrustContext } from "../../src/adapter/trust.js";
import type { MpasApplicationPlugin } from "../../src/core/plugin-loader.js";
import type { DeploymentConfig } from "../../src/adapter/config-loader.js";

vi.mock("../../src/adapter/trust-attestation.js", () => ({
  checkAttestation: vi.fn(),
}));
vi.mock("../../src/adapter/trust-linkage.js", () => ({
  listLinkedIdentifiers: vi.fn(),
}));
vi.mock("../../src/adapter/artifact-trust-client.js", () => ({
  DEFAULT_ARTIFACT_TRUST_API_URL:
    "https://api.omatrust.org/v1/artifact-trust",
  fetchArtifactTrust: vi.fn(),
}));

import { checkAttestation } from "../../src/adapter/trust-attestation.js";
import { listLinkedIdentifiers } from "../../src/adapter/trust-linkage.js";
import { fetchArtifactTrust } from "../../src/adapter/artifact-trust-client.js";
import { makeArtifactTrustResponse } from "./artifact-trust-fixture.js";

const mockCheckAttestation = vi.mocked(checkAttestation);
const mockListLinkedIdentifiers = vi.mocked(listLinkedIdentifiers);
const mockFetchArtifactTrust = vi.mocked(fetchArtifactTrust);

const fakePlugin: MpasApplicationPlugin = {
  version: "1",
  type: "MpasApplicationPlugin",
  pluginDid: "did:web:plugins.oma3.example:github-mirror-plugin",
  pluginVersion: "0.1.0",
  publisherDid: "did:web:publisher.example",
  applicationDid: "did:web:github-mirror.example",
  executionProfile: {
    id: "did:web:profiles.oma3.org:mcp",
    protocolVersion: "2024-11-05",
  },
  operations: { create_issue_mirror: { executionPayloadSchema: {} } },
};

const fakeConfig: DeploymentConfig = {
  version: "1",
  type: "MpasAdapterDeploymentConfig",
  name: "github-test",
  target: { applicationDid: "did:web:github-mirror.example" },
  plugin: {
    pluginDid: "did:web:plugins.oma3.example:github-mirror-plugin",
    pluginVersion: "0.1.0",
    artifactDid: "did:artifact:bafkreibfakeartifactdid",
    path: "../plugins/github-mirror-plugin.json",
  },
  credentialBindings: [{ credentialHandle: "gh-token", provider: "file" }],
  executionTarget: { type: "mcp.stdio", command: "node", args: ["server.js"], env: {} },
  policy: {
    version: "1",
    type: "MpasApplicationPolicy",
    policyProfileUrl: "https://github.com/oma3dao/mpas/blob/main/specs/mpas-profile-policy-json.md",
    applicationDid: "did:web:github-mirror.example",
    executionProfile: { id: "did:web:profiles.oma3.org:mcp", format: "mcp.toolsCall" },
    defaultRequirement: { type: "proposerOnly" },
    signerGroups: { all: ["did:web:agent.example"], proposers: ["did:web:agent.example"] },
  },
  signerKeys: [{ did: "did:web:agent.example", label: "Agent", publicJwk: {} }],
} as unknown as DeploymentConfig;

const fakeTrustContext: TrustContext = {
  artifactTrustApiUrl: "https://backend.omatrust.example/artifact-trust",
};

function makeAttestationResult(
  overrides: Partial<Awaited<ReturnType<typeof checkAttestation>>> = {},
) {
  return {
    primaryEvidenceFound: false,
    message: "No verified trust-bearing evidence.",
    responsibilityClaim: false,
    cybersecurityAssessment: false,
    responsibilityClaims: [],
    attestations: [],
    ...overrides,
  };
}

describe("canTrust", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchArtifactTrust.mockResolvedValue(makeArtifactTrustResponse());
  });

  it("suppresses the warning when a verified responsibility claim exists", async () => {
    mockCheckAttestation.mockResolvedValue(makeAttestationResult({
      primaryEvidenceFound: true,
      message: "Responsibility claimed by: did:web:publisher.example",
      responsibilityClaim: true,
    }));

    const verdict = await canTrust(fakePlugin, fakeConfig, fakeTrustContext);

    expect(verdict.primaryEvidenceFound).toBe(true);
    expect(verdict.warningRequired).toBe(false);
    expect(verdict.reasons).toEqual([
      expect.objectContaining({ check: "responsibility-claim", passed: true }),
      expect.objectContaining({ check: "cybersecurity-assessment", passed: false }),
    ]);
  });

  it("suppresses the warning when an approved-issuer cybersecurity assessment exists", async () => {
    mockCheckAttestation.mockResolvedValue(makeAttestationResult({
      primaryEvidenceFound: true,
      message: "Cybersecurity assessed by: OMA3 Security Lab",
      cybersecurityAssessment: true,
      attestations: [{
        uid: `0x${"1".repeat(64)}`,
        attester: "0x3333333333333333333333333333333333333333",
        attesterLabel: "OMA3 Security Lab",
        isApprovedIssuer: true,
        schemaUid: `0x${"2".repeat(64)}`,
        schemaLabel: "security-assessment",
        time: "1700000000",
        expirationTime: "0",
        verificationBasis: ["approved-issuer"],
        data: { subject: fakeConfig.plugin.artifactDid },
      }],
    }));

    const verdict = await canTrust(fakePlugin, fakeConfig, fakeTrustContext);

    expect(verdict.primaryEvidenceFound).toBe(true);
    expect(verdict.warningRequired).toBe(false);
    expect(verdict.reasons).toEqual([
      expect.objectContaining({ check: "responsibility-claim", passed: false }),
      expect.objectContaining({ check: "cybersecurity-assessment", passed: true }),
    ]);
  });

  it("requires a warning when neither primary signal exists", async () => {
    mockCheckAttestation.mockResolvedValue(makeAttestationResult());

    const verdict = await canTrust(fakePlugin, fakeConfig, fakeTrustContext);

    expect(verdict.primaryEvidenceFound).toBe(false);
    expect(verdict.warningRequired).toBe(true);
    expect(verdict.reasons.every((reason) => !reason.passed)).toBe(true);
  });

  it("does not use linked identifiers to determine the verdict", async () => {
    mockCheckAttestation.mockResolvedValue(makeAttestationResult());
    mockListLinkedIdentifiers.mockResolvedValue([{
      uid: `0x${"1".repeat(64)}`,
      linkedId: "did:web:github-mirror.example",
      attester: "0x3333333333333333333333333333333333333333",
      verificationBasis: ["proof"],
    }]);

    const verdict = await canTrust(fakePlugin, fakeConfig, fakeTrustContext);

    expect(verdict.primaryEvidenceFound).toBe(false);
    expect(verdict.warningRequired).toBe(true);
    expect(mockListLinkedIdentifiers).not.toHaveBeenCalled();
  });

  it("propagates backend failure so callers can report trust as unavailable", async () => {
    mockFetchArtifactTrust.mockRejectedValue(new Error("Artifact trust API unavailable"));

    await expect(
      canTrust(fakePlugin, fakeConfig, fakeTrustContext),
    ).rejects.toThrow("Artifact trust API unavailable");
    expect(mockCheckAttestation).not.toHaveBeenCalled();
  });
});

describe("buildTrustReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchArtifactTrust.mockResolvedValue(makeArtifactTrustResponse());
    mockCheckAttestation.mockResolvedValue(makeAttestationResult());
    mockListLinkedIdentifiers.mockResolvedValue([]);
  });

  it("fetches once, preserves the target Application DID, and lists linked identifiers", async () => {
    const linkedIdentifiers = [{
      uid: `0x${"1".repeat(64)}`,
      linkedId: "did:web:some-associated-service.example",
      attester: "0x3333333333333333333333333333333333333333",
      verificationBasis: ["proof", "controller-authorization"],
    }];
    mockListLinkedIdentifiers.mockResolvedValue(linkedIdentifiers);

    const report = await buildTrustReport(
      fakePlugin,
      fakeConfig,
      fakeTrustContext,
    );

    expect(mockFetchArtifactTrust).toHaveBeenCalledOnce();
    const evidence = await mockFetchArtifactTrust.mock.results[0].value;
    expect(mockCheckAttestation).toHaveBeenCalledWith(
      fakeConfig.plugin.artifactDid,
      fakeTrustContext,
      evidence,
    );
    expect(mockListLinkedIdentifiers).toHaveBeenCalledWith(
      fakeConfig.plugin.artifactDid,
      fakeTrustContext,
      evidence,
    );
    expect(report.targetApplicationDid).toBe(fakeConfig.target.applicationDid);
    expect(report.linkedIdentifiers).toEqual(linkedIdentifiers);
    expect(report.verdict.primaryEvidenceFound).toBe(false);
    expect(report.verdict.warningRequired).toBe(true);
  });
});
