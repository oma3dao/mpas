import type {
  ArtifactTrustResponse,
  VerifiedArtifactTrustAttestation,
} from "../../src/adapter/artifact-trust-client.js";

export const artifactDid =
  "did:artifact:bafkreibuuyyqyb7jqrlflorjiiko2efz2xgagwxxdgathcrdpcniiyzhfi";

export function makeEvidence(
  schemaName = "security-assessment",
  overrides: Partial<VerifiedArtifactTrustAttestation["attestation"]> = {},
  basis: string[] = ["approved-issuer"],
): VerifiedArtifactTrustAttestation {
  return {
    attestation: {
      uid: `0x${"1".repeat(64)}`,
      schema: `0x${"2".repeat(64)}`,
      schemaName,
      attester: "0x3333333333333333333333333333333333333333",
      attesterLabel: "OMA3 Security Lab",
      recipient: "0x4444444444444444444444444444444444444444",
      time: "1700000000",
      expirationTime: "0",
      revocationTime: "0",
      data: { subject: artifactDid },
      ...overrides,
    },
    verification: {
      valid: true,
      basis,
    },
  };
}

export function makeArtifactTrustResponse(
  overrides: Partial<ArtifactTrustResponse> = {},
): ArtifactTrustResponse {
  const groups = {
    responsibilityClaims: [],
    securityAssessments: [],
    certifications: [],
    otherAttestations: [],
    ...overrides,
  };
  const totalVerified =
    groups.responsibilityClaims.length +
    groups.securityAssessments.length +
    groups.certifications.length +
    groups.otherAttestations.length;
  return {
    artifactDid,
    chain: {
      chainId: 6623,
      caip2: "eip155:6623",
      easContract: "0x00Bd6f0Ee99bD76273B57e6dDEc5B00850c6b76C",
    },
    trustAnchorsVersion: 1,
    ...groups,
    summary: {
      totalQueried: totalVerified,
      totalVerified,
      totalExcluded: 0,
      complete: true,
    },
    ...overrides,
  };
}
