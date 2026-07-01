import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { canTrust, extractTargetUrl, type TrustContext } from "../../src/adapter/trust.js";
import type { MpasApplicationPlugin } from "../../src/core/plugin-loader.js";
import type { DeploymentConfig } from "../../src/adapter/config-loader.js";

// Mock the sub-modules so we can control check results without network calls.
vi.mock("../../src/adapter/trust-attestation.js", () => ({
  checkAttestation: vi.fn(),
}));
vi.mock("../../src/adapter/trust-linkage.js", () => ({
  checkLinkage: vi.fn(),
}));

import { checkAttestation } from "../../src/adapter/trust-attestation.js";
import { checkLinkage } from "../../src/adapter/trust-linkage.js";

const mockCheckAttestation = vi.mocked(checkAttestation);
const mockCheckLinkage = vi.mocked(checkLinkage);

const fakePlugin: MpasApplicationPlugin = {
  version: "1",
  type: "MpasApplicationPlugin",
  pluginDid: "did:web:plugins.example.com:github-repo",
  pluginVersion: "1.0.0",
  publisherDid: "did:web:publisher.example",
  applicationDid: "did:web:github.example",
  executionProfile: { id: "did:web:profiles.oma3.org:mcp" },
  operations: { create_issue: { executionPayloadSchema: {} } },
};

const fakeConfig: DeploymentConfig = {
  version: "1",
  type: "MpasAdapterDeploymentConfig",
  name: "github-test",
  target: { applicationDid: "did:web:github.example" },
  plugin: {
    pluginDid: "did:web:plugins.example.com:github-repo",
    pluginVersion: "1.0.0",
    artifactDid: "did:artifact:bafkreibfakeartifactdid",
    path: "../plugins/github-repo.json",
  },
  credentialBindings: [{ credentialHandle: "gh-token", provider: "file" }],
  executionTarget: { type: "mcp.stdio", command: "node", args: ["server.js"], env: {} },
  policy: {
    version: "1",
    type: "MpasApplicationPolicy",
    policyProfileUrl: "https://oma3.org/specs/mpas/policy-json/v1",
    applicationDid: "did:web:github.example",
    executionProfile: { id: "did:web:profiles.oma3.org:mcp", format: "mcp.toolsCall" },
    defaultRequirement: { type: "proposerOnly" },
    signerGroups: { all: ["did:web:agent.example"], proposers: ["did:web:agent.example"] },
  },
  signerKeys: [{ did: "did:web:agent.example", label: "Agent", publicJwk: {} }],
} as unknown as DeploymentConfig;

const fakeTrustContext: TrustContext = {
  backendUrl: "https://backend.omatrust.example",
  approvedIssuers: [{ address: "0xApproved1", label: "OMA3 Security Lab" }],
  schemas: {
    securityAssessment: "0xschema1",
    certification: "0xschema2",
    userReview: "0xschema3",
    linkedIdentifier: "0xschema4",
    controllerWitness: "0xschema5",
  },
  rpcUrl: "https://rpc.example",
  easContractAddress: "0xEAS",
};

describe("canTrust", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns trusted: true when attestation check passes (linkage fails)", async () => {
    mockCheckAttestation.mockResolvedValue({
      passed: true,
      message: "Attested by: OMA3 Security Lab (security-assessment)",
      attestations: [],
    });
    mockCheckLinkage.mockResolvedValue({
      passed: false,
      message: "No linkage found.",
      linkedIdentifier: false,
      controllerWitness: false,
      dnsTxt: false,
      wellKnownDid: false,
    });

    const verdict = await canTrust(fakePlugin, fakeConfig, fakeTrustContext);

    expect(verdict.trusted).toBe(true);
    expect(verdict.reasons).toHaveLength(2);
    expect(verdict.reasons[0]).toMatchObject({ check: "attestation", passed: true });
    expect(verdict.reasons[1]).toMatchObject({ check: "linkage", passed: false });
  });

  it("returns trusted: true when linkage check passes (attestation fails)", async () => {
    mockCheckAttestation.mockResolvedValue({
      passed: false,
      message: "Zero attestations: No attestations found.",
      attestations: [],
    });
    mockCheckLinkage.mockResolvedValue({
      passed: true,
      message: "Linked to: github.example (DNS TXT)",
      linkedIdentifier: false,
      controllerWitness: false,
      dnsTxt: true,
      wellKnownDid: false,
    });

    const verdict = await canTrust(fakePlugin, fakeConfig, fakeTrustContext);

    expect(verdict.trusted).toBe(true);
    expect(verdict.reasons[0]).toMatchObject({ check: "attestation", passed: false });
    expect(verdict.reasons[1]).toMatchObject({ check: "linkage", passed: true });
  });

  it("returns trusted: true when both checks pass", async () => {
    mockCheckAttestation.mockResolvedValue({
      passed: true,
      message: "Attested by: OMA3 Security Lab",
      attestations: [],
    });
    mockCheckLinkage.mockResolvedValue({
      passed: true,
      message: "Linked to: github.example (controller-witness)",
      linkedIdentifier: false,
      controllerWitness: true,
      dnsTxt: false,
      wellKnownDid: false,
    });

    const verdict = await canTrust(fakePlugin, fakeConfig, fakeTrustContext);

    expect(verdict.trusted).toBe(true);
  });

  it("returns trusted: false when both checks fail", async () => {
    mockCheckAttestation.mockResolvedValue({
      passed: false,
      message: "Zero attestations: No attestations found for this artifact on OMATrust.",
      attestations: [],
    });
    mockCheckLinkage.mockResolvedValue({
      passed: false,
      message: "No linkage: did:artifact is not linked to the URL this plugin targets (github.example).",
      linkedIdentifier: false,
      controllerWitness: false,
      dnsTxt: false,
      wellKnownDid: false,
    });

    const verdict = await canTrust(fakePlugin, fakeConfig, fakeTrustContext);

    expect(verdict.trusted).toBe(false);
    expect(verdict.reasons).toHaveLength(2);
    expect(verdict.reasons[0]).toMatchObject({ check: "attestation", passed: false });
    expect(verdict.reasons[1]).toMatchObject({ check: "linkage", passed: false });
  });

  it("handles attestation check throwing (network error) gracefully", async () => {
    mockCheckAttestation.mockRejectedValue(new Error("Network timeout"));
    mockCheckLinkage.mockResolvedValue({
      passed: true,
      message: "Linked to: github.example (.well-known/did.json)",
      linkedIdentifier: false,
      controllerWitness: false,
      dnsTxt: false,
      wellKnownDid: true,
    });

    const verdict = await canTrust(fakePlugin, fakeConfig, fakeTrustContext);

    // Linkage passed, so overall trusted
    expect(verdict.trusted).toBe(true);
    expect(verdict.reasons[0]).toMatchObject({
      check: "attestation",
      passed: false,
      message: "Attestation check failed: Network timeout",
    });
  });

  it("handles both checks throwing as untrusted", async () => {
    mockCheckAttestation.mockRejectedValue(new Error("RPC down"));
    mockCheckLinkage.mockRejectedValue(new Error("DNS failed"));

    const verdict = await canTrust(fakePlugin, fakeConfig, fakeTrustContext);

    expect(verdict.trusted).toBe(false);
    expect(verdict.reasons[0]).toMatchObject({ check: "attestation", passed: false });
    expect(verdict.reasons[1]).toMatchObject({ check: "linkage", passed: false });
  });
});

describe("extractTargetUrl", () => {
  it("extracts domain from did:web:domain", () => {
    expect(extractTargetUrl("did:web:github.example")).toBe("github.example");
  });

  it("extracts domain with path from did:web:domain:path:segments", () => {
    expect(extractTargetUrl("did:web:api.example.com:v1:repos")).toBe("api.example.com/v1/repos");
  });

  it("handles percent-encoded domains", () => {
    expect(extractTargetUrl("did:web:example.com%3A8080")).toBe("example.com:8080");
  });
});
