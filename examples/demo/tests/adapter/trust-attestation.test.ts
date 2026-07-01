import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { checkAttestation } from "../../src/adapter/trust-attestation.js";
import type { TrustContext } from "../../src/adapter/trust.js";

// Mock the SDK and ethers imports that trust-attestation uses dynamically
vi.mock("@oma3/omatrust/identity", () => ({
  didToAddress: vi.fn().mockReturnValue("0xfakeDidAddress"),
}));

vi.mock("@oma3/omatrust/reputation", () => ({
  getAttestationsForDid: vi.fn(),
}));

vi.mock("ethers", () => ({
  JsonRpcProvider: vi.fn().mockImplementation(() => ({
    getBlockNumber: vi.fn().mockResolvedValue(100000),
  })),
}));

import { getAttestationsForDid } from "@oma3/omatrust/reputation";
const mockGetAttestations = vi.mocked(getAttestationsForDid);

const fakeTrustContext: TrustContext = {
  backendUrl: "https://backend.omatrust.example",
  approvedIssuers: [
    { address: "0xApprovedIssuer1", label: "OMA3 Security Lab" },
    { address: "0xApprovedIssuer2", label: "Audit Co" },
  ],
  schemas: {
    securityAssessment: "0xschema-security",
    certification: "0xschema-cert",
    userReview: "0xschema-review",
    linkedIdentifier: "0xschema-linked",
    controllerWitness: "0xschema-controller",
  },
  schemaLabels: new Map([
    ["0xschema-security", "security-assessment"],
    ["0xschema-cert", "certification"],
    ["0xschema-review", "user-review"],
  ]),
  rpcUrl: "https://rpc.example",
  easContractAddress: "0xEAS",
};

describe("checkAttestation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns passed: false when no attestations exist", async () => {
    mockGetAttestations.mockResolvedValue([]);

    const result = await checkAttestation("did:artifact:bafkfake", fakeTrustContext);

    expect(result.passed).toBe(false);
    expect(result.message).toContain("Zero attestations");
    expect(result.attestations).toHaveLength(0);
  });

  it("returns passed: true when a valid attestation from an approved issuer exists", async () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    mockGetAttestations.mockResolvedValue([
      {
        uid: "0xuid1" as `0x${string}`,
        attester: "0xApprovedIssuer1" as `0x${string}`,
        schema: "0xschema-security" as `0x${string}`,
        recipient: "0xfakeDidAddress" as `0x${string}`,
        time: now - 3600n,
        expirationTime: 0n,
        revocationTime: 0n,
        revocable: true,
        refUID: "0x0" as `0x${string}`,
        data: {},
      },
    ]);

    const result = await checkAttestation("did:artifact:bafkfake", fakeTrustContext);

    expect(result.passed).toBe(true);
    expect(result.message).toContain("OMA3 Security Lab");
    expect(result.message).toContain("security-assessment");
    expect(result.attestations).toHaveLength(1);
    expect(result.attestations[0].isApprovedIssuer).toBe(true);
  });

  it("returns passed: false when attestations exist but none from an approved issuer", async () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    mockGetAttestations.mockResolvedValue([
      {
        uid: "0xuid2" as `0x${string}`,
        attester: "0xRandomAttester" as `0x${string}`,
        schema: "0xschema-review" as `0x${string}`,
        recipient: "0xfakeDidAddress" as `0x${string}`,
        time: now - 3600n,
        expirationTime: 0n,
        revocationTime: 0n,
        revocable: true,
        refUID: "0x0" as `0x${string}`,
        data: {},
      },
    ]);

    const result = await checkAttestation("did:artifact:bafkfake", fakeTrustContext);

    expect(result.passed).toBe(false);
    expect(result.message).toContain("none are from an approved issuer");
  });

  it("returns passed: false when approved issuer attestation is revoked", async () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    mockGetAttestations.mockResolvedValue([
      {
        uid: "0xuid3" as `0x${string}`,
        attester: "0xApprovedIssuer1" as `0x${string}`,
        schema: "0xschema-cert" as `0x${string}`,
        recipient: "0xfakeDidAddress" as `0x${string}`,
        time: now - 7200n,
        expirationTime: 0n,
        revocationTime: now - 3600n, // revoked
        revocable: true,
        refUID: "0x0" as `0x${string}`,
        data: {},
      },
    ]);

    const result = await checkAttestation("did:artifact:bafkfake", fakeTrustContext);

    expect(result.passed).toBe(false);
    expect(result.message).toContain("revoked or expired");
  });

  it("returns passed: false when approved issuer attestation is expired", async () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    mockGetAttestations.mockResolvedValue([
      {
        uid: "0xuid4" as `0x${string}`,
        attester: "0xApprovedIssuer2" as `0x${string}`,
        schema: "0xschema-security" as `0x${string}`,
        recipient: "0xfakeDidAddress" as `0x${string}`,
        time: now - 86400n,
        expirationTime: now - 3600n, // expired
        revocationTime: 0n,
        revocable: true,
        refUID: "0x0" as `0x${string}`,
        data: {},
      },
    ]);

    const result = await checkAttestation("did:artifact:bafkfake", fakeTrustContext);

    expect(result.passed).toBe(false);
    expect(result.message).toContain("revoked or expired");
  });

  it("is case-insensitive when matching approved issuers", async () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    mockGetAttestations.mockResolvedValue([
      {
        uid: "0xuid5" as `0x${string}`,
        attester: "0xapprovedissuer1" as `0x${string}`, // lowercase
        schema: "0xschema-security" as `0x${string}`,
        recipient: "0xfakeDidAddress" as `0x${string}`,
        time: now - 3600n,
        expirationTime: 0n,
        revocationTime: 0n,
        revocable: true,
        refUID: "0x0" as `0x${string}`,
        data: {},
      },
    ]);

    const result = await checkAttestation("did:artifact:bafkfake", fakeTrustContext);

    expect(result.passed).toBe(true);
    expect(result.attestations[0].isApprovedIssuer).toBe(true);
  });
});
