import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { checkLinkage } from "../../src/adapter/trust-linkage.js";
import type { TrustContext } from "../../src/adapter/trust.js";

// Mock SDK modules
vi.mock("@oma3/omatrust/identity", () => ({
  didToAddress: vi.fn().mockReturnValue("0xfakeDidAddress"),
}));

vi.mock("@oma3/omatrust/reputation", () => ({
  getAttestationsForDid: vi.fn().mockResolvedValue([]),
  verifyLinkedIdentifierProofs: vi.fn().mockReturnValue({ valid: true, checks: [], reasons: [] }),
}));

vi.mock("ethers", () => ({
  JsonRpcProvider: vi.fn().mockImplementation(() => ({
    getBlockNumber: vi.fn().mockResolvedValue(100000),
  })),
}));

import { getAttestationsForDid, verifyLinkedIdentifierProofs } from "@oma3/omatrust/reputation";
const mockGetAttestations = vi.mocked(getAttestationsForDid);
const mockVerifyProofs = vi.mocked(verifyLinkedIdentifierProofs);

const fakeTrustContext: TrustContext = {
  backendUrl: "https://backend.omatrust.example",
  approvedIssuers: [],
  schemas: {
    securityAssessment: "0xschema-security",
    certification: "0xschema-cert",
    userReview: "0xschema-review",
    linkedIdentifier: "0xschema-linked",
    controllerWitness: "0xschema-controller",
  },
  rpcUrl: "https://rpc.example",
  easContractAddress: "0xEAS",
};

const artifactDid = "did:artifact:bafkreibfakeartifact";
const targetDomain = "github.example";

describe("checkLinkage", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns passed: false when no linked-identifier attestation and no controller evidence", async () => {
    mockGetAttestations.mockResolvedValue([]);

    // Backend controller-confirm returns no keys
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ controllerKeys: [], evidence: [] }),
        { status: 200 },
      ),
    );

    const result = await checkLinkage(artifactDid, targetDomain, fakeTrustContext);

    expect(result.passed).toBe(false);
    expect(result.message).toContain("No linkage");
    expect(result.message).toContain(targetDomain);
  });

  it("returns passed: true when linked-identifier attestation has valid proof and issuer is authorized", async () => {
    const now = BigInt(Math.floor(Date.now() / 1000));

    // Linked-identifier attestation found
    mockGetAttestations.mockResolvedValue([
      {
        uid: "0xlinked1" as `0x${string}`,
        schema: "0xschema-linked" as `0x${string}`,
        attester: "0xControllerAddress" as `0x${string}`,
        recipient: "0xfakeDidAddress" as `0x${string}`,
        time: now - 3600n,
        expirationTime: 0n,
        revocationTime: 0n,
        revocable: true,
        refUID: "0x0" as `0x${string}`,
        data: {
          subject: artifactDid,
          linkedId: `did:web:${targetDomain}`,
          proofs: [{ proofType: "pop-eip712", proofObject: {} }],
        },
      },
    ]);

    // Proof is valid
    mockVerifyProofs.mockReturnValue({ valid: true, checks: [], reasons: [] });

    // Backend confirms issuer is a controller
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          controllerKeys: [
            { canonicalId: "did:pkh:eip155:1:0xcontrolleraddress", sources: ["dns-txt"] },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await checkLinkage(artifactDid, targetDomain, fakeTrustContext);

    expect(result.passed).toBe(true);
    expect(result.message).toContain("linked-identifier");
    expect(result.message).toContain("dns-txt");
    expect(result.linkedIdentifier).toBe(true);
    expect(result.dnsTxt).toBe(true);
  });

  it("returns passed: false when linked-identifier attestation has invalid proof", async () => {
    const now = BigInt(Math.floor(Date.now() / 1000));

    mockGetAttestations.mockResolvedValue([
      {
        uid: "0xlinked2" as `0x${string}`,
        schema: "0xschema-linked" as `0x${string}`,
        attester: "0xControllerAddress" as `0x${string}`,
        recipient: "0xfakeDidAddress" as `0x${string}`,
        time: now - 3600n,
        expirationTime: 0n,
        revocationTime: 0n,
        revocable: true,
        refUID: "0x0" as `0x${string}`,
        data: {
          subject: artifactDid,
          linkedId: `did:web:${targetDomain}`,
          proofs: [{ proofType: "pop-eip712", proofObject: {} }],
        },
      },
    ]);

    // Proof is invalid
    mockVerifyProofs.mockReturnValue({
      valid: false,
      checks: [],
      reasons: ["No proof demonstrates control by subject"],
    });

    const result = await checkLinkage(artifactDid, targetDomain, fakeTrustContext);

    expect(result.passed).toBe(false);
    expect(result.message).toContain("proof is invalid");
    expect(result.linkedIdentifier).toBe(false);
  });

  it("returns passed: false when linked-identifier attestation issuer is not authorized by target", async () => {
    const now = BigInt(Math.floor(Date.now() / 1000));

    mockGetAttestations.mockResolvedValue([
      {
        uid: "0xlinked3" as `0x${string}`,
        schema: "0xschema-linked" as `0x${string}`,
        attester: "0xUnauthorizedAddress" as `0x${string}`,
        recipient: "0xfakeDidAddress" as `0x${string}`,
        time: now - 3600n,
        expirationTime: 0n,
        revocationTime: 0n,
        revocable: true,
        refUID: "0x0" as `0x${string}`,
        data: {
          subject: artifactDid,
          linkedId: `did:web:${targetDomain}`,
          proofs: [{ proofType: "pop-eip712", proofObject: {} }],
        },
      },
    ]);

    mockVerifyProofs.mockReturnValue({ valid: true, checks: [], reasons: [] });

    // Backend says the issuer is NOT in the controller keys
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          controllerKeys: [
            { canonicalId: "did:pkh:eip155:1:0xdifferentaddress", sources: ["dns-txt"] },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await checkLinkage(artifactDid, targetDomain, fakeTrustContext);

    expect(result.passed).toBe(false);
    expect(result.message).toContain("issuer is not authorized");
    expect(result.linkedIdentifier).toBe(false);
  });

  it("skips revoked linked-identifier attestations", async () => {
    const now = BigInt(Math.floor(Date.now() / 1000));

    mockGetAttestations.mockResolvedValue([
      {
        uid: "0xlinked4" as `0x${string}`,
        schema: "0xschema-linked" as `0x${string}`,
        attester: "0xControllerAddress" as `0x${string}`,
        recipient: "0xfakeDidAddress" as `0x${string}`,
        time: now - 3600n,
        expirationTime: 0n,
        revocationTime: now - 1800n, // revoked
        revocable: true,
        refUID: "0x0" as `0x${string}`,
        data: {
          subject: artifactDid,
          linkedId: `did:web:${targetDomain}`,
          proofs: [{ proofType: "pop-eip712", proofObject: {} }],
        },
      },
    ]);

    // Falls through to controller-confirm, which returns nothing
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ controllerKeys: [], evidence: [] }),
        { status: 200 },
      ),
    );

    const result = await checkLinkage(artifactDid, targetDomain, fakeTrustContext);

    expect(result.passed).toBe(false);
  });
});
