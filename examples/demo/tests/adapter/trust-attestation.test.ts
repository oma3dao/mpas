import { describe, expect, it } from "vitest";
import { checkAttestation } from "../../src/adapter/trust-attestation.js";
import type { TrustContext } from "../../src/adapter/trust.js";
import {
  artifactDid,
  makeArtifactTrustResponse,
  makeEvidence,
} from "./artifact-trust-fixture.js";

const context: TrustContext = {
  artifactTrustApiUrl: "https://backend.omatrust.example/artifact-trust",
};

describe("checkAttestation", () => {
  it("reports no primary evidence when no verified attestations exist", async () => {
    const result = await checkAttestation(
      artifactDid,
      context,
      makeArtifactTrustResponse(),
    );

    expect(result.primaryEvidenceFound).toBe(false);
    expect(result.message).toContain(
      "Zero verified responsibility claims or cybersecurity assessments",
    );
    expect(result.responsibilityClaims).toHaveLength(0);
    expect(result.attestations).toHaveLength(0);
  });

  it("passes for a cybersecurity assessment from an approved issuer", async () => {
    const result = await checkAttestation(
      artifactDid,
      context,
      makeArtifactTrustResponse({
        securityAssessments: [makeEvidence()],
        summary: {
          totalQueried: 1,
          totalVerified: 1,
          totalExcluded: 0,
          complete: true,
        },
      }),
    );

    expect(result.primaryEvidenceFound).toBe(true);
    expect(result.responsibilityClaim).toBe(false);
    expect(result.cybersecurityAssessment).toBe(true);
    expect(result.message).toContain("OMA3 Security Lab");
    expect(result.attestations[0]).toMatchObject({
      isApprovedIssuer: true,
      verificationBasis: ["approved-issuer"],
    });
  });

  it("prioritizes a verified responsibility claim as trust evidence", async () => {
    const claim = makeEvidence(
      "responsibility-claim",
      {
        data: {
          subject: artifactDid,
          responsibleParty: "did:web:publisher.example",
          responsibilityType: ["publisher", "maintainer"],
        },
      },
      ["proof", "controller-authorization", "authorization-window"],
    );
    const result = await checkAttestation(
      artifactDid,
      context,
      makeArtifactTrustResponse({
        responsibilityClaims: [claim],
        summary: {
          totalQueried: 1,
          totalVerified: 1,
          totalExcluded: 0,
          complete: true,
        },
      }),
    );

    expect(result.primaryEvidenceFound).toBe(true);
    expect(result.responsibilityClaim).toBe(true);
    expect(result.cybersecurityAssessment).toBe(false);
    expect(result.message).toContain("did:web:publisher.example");
    expect(result.responsibilityClaims).toHaveLength(1);
    expect(result.attestations).toHaveLength(0);
  });

  it("does not promote a certification to a cybersecurity assessment", async () => {
    const result = await checkAttestation(
      artifactDid,
      context,
      makeArtifactTrustResponse({
        certifications: [makeEvidence("certification")],
        summary: {
          totalQueried: 1,
          totalVerified: 1,
          totalExcluded: 0,
          complete: true,
        },
      }),
    );

    expect(result.primaryEvidenceFound).toBe(false);
    expect(result.cybersecurityAssessment).toBe(false);
    expect(result.attestations).toHaveLength(1);
    expect(result.message).toContain("informational evidence");
  });

  it("leaves linked identifiers out of the trust-bearing attestation policy", async () => {
    const linked = makeEvidence(
      "linked-identifier",
      { data: { subject: artifactDid, linkedId: "did:web:github.example" } },
      ["proof", "controller-authorization", "authorization-window"],
    );
    const result = await checkAttestation(
      artifactDid,
      context,
      makeArtifactTrustResponse({
        otherAttestations: [linked],
        summary: {
          totalQueried: 1,
          totalVerified: 1,
          totalExcluded: 0,
          complete: true,
        },
      }),
    );

    expect(result.attestations).toEqual([]);
    expect(result.responsibilityClaims).toEqual([]);
    expect(result.primaryEvidenceFound).toBe(false);
  });

  it("does not display a user review if an older backend returns one", async () => {
    const review = makeEvidence(
      "user-review",
      { data: { subject: artifactDid, rating: 5 } },
      ["proof"],
    );
    const result = await checkAttestation(
      artifactDid,
      context,
      makeArtifactTrustResponse({
        otherAttestations: [review],
        summary: {
          totalQueried: 1,
          totalVerified: 1,
          totalExcluded: 0,
          complete: true,
        },
      }),
    );

    expect(result.primaryEvidenceFound).toBe(false);
    expect(result.attestations).toEqual([]);
  });
});
