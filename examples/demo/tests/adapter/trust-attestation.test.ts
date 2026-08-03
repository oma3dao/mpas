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

const publisherDid = "did:web:publisher.example";

function makeClaim(responsibleParty: string) {
  return makeEvidence(
    "responsibility-claim",
    {
      data: {
        subject: artifactDid,
        responsibleParty,
        responsibilityType: ["publisher", "maintainer"],
      },
    },
    ["proof", "controller-authorization", "authorization-window"],
  );
}

describe("checkAttestation", () => {
  it("reports no primary evidence when no verified attestations exist", async () => {
    const result = await checkAttestation(
      artifactDid,
      publisherDid,
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
      publisherDid,
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
      publisherDid,
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
      publisherDid,
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
      publisherDid,
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
      publisherDid,
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

describe("checkAttestation responsible-party binding", () => {
  const summary = {
    totalQueried: 1,
    totalVerified: 1,
    totalExcluded: 0,
    complete: true as const,
  };

  it("does not count a claim naming a party other than the declared publisher", async () => {
    const result = await checkAttestation(
      artifactDid,
      publisherDid,
      context,
      makeArtifactTrustResponse({
        responsibilityClaims: [makeClaim("did:web:squatter.example")],
        summary,
      }),
    );

    expect(result.primaryEvidenceFound).toBe(false);
    expect(result.responsibilityClaim).toBe(false);
    expect(result.responsibilityClaims).toHaveLength(0);
    expect(result.unqualifiedResponsibilityClaims).toHaveLength(1);
    expect(result.message).toContain(publisherDid);
  });

  it("keeps the qualifying claim and sets the rest aside", async () => {
    const result = await checkAttestation(
      artifactDid,
      publisherDid,
      context,
      makeArtifactTrustResponse({
        responsibilityClaims: [
          makeClaim("did:web:squatter.example"),
          makeClaim(publisherDid),
        ],
        summary: { ...summary, totalQueried: 2, totalVerified: 2 },
      }),
    );

    expect(result.primaryEvidenceFound).toBe(true);
    expect(result.responsibilityClaim).toBe(true);
    expect(result.responsibilityClaims).toHaveLength(1);
    expect(result.responsibilityClaims[0].data.responsibleParty).toBe(
      publisherDid,
    );
    expect(result.unqualifiedResponsibilityClaims).toHaveLength(1);
  });

  // Compared under the SDK's normalizeDid, which is the same notion of
  // identity computeDidHash uses to index attestations.
  it.each([
    ["mixed-case host", "did:web:Publisher.Example"],
    ["www. prefix", "did:web:www.publisher.example"],
    ["DID URL fragment", "did:web:publisher.example#key-1"],
    ["surrounding whitespace", "  did:web:publisher.example  "],
    ["trailing dot on host", "did:web:publisher.example."],
  ])("treats a %s as the same declared publisher", async (_label, declared) => {
    const result = await checkAttestation(
      artifactDid,
      declared,
      context,
      makeArtifactTrustResponse({
        responsibilityClaims: [makeClaim(publisherDid)],
        summary,
      }),
    );

    expect(result.responsibilityClaim).toBe(true);
    expect(result.unqualifiedResponsibilityClaims).toHaveLength(0);
  });

  // The DID scheme and method name are lowercase per W3C DID Core, and the
  // config schema enforces ^did:[a-z0-9]+: — a non-conforming scheme cannot
  // reach here from a valid config, and fails closed if it somehow does.
  it("fails closed on a non-conforming upper-case DID scheme", async () => {
    const result = await checkAttestation(
      artifactDid,
      "DID:WEB:publisher.example",
      context,
      makeArtifactTrustResponse({
        responsibilityClaims: [makeClaim(publisherDid)],
        summary,
      }),
    );

    expect(result.responsibilityClaim).toBe(false);
  });

  it("does not match a different host that merely shares a suffix", async () => {
    const result = await checkAttestation(
      artifactDid,
      publisherDid,
      context,
      makeArtifactTrustResponse({
        responsibilityClaims: [makeClaim("did:web:evil.publisher.example")],
        summary,
      }),
    );

    expect(result.responsibilityClaim).toBe(false);
    expect(result.unqualifiedResponsibilityClaims).toHaveLength(1);
  });

  it("treats a malformed responsibleParty as non-matching instead of throwing", async () => {
    const result = await checkAttestation(
      artifactDid,
      publisherDid,
      context,
      makeArtifactTrustResponse({
        responsibilityClaims: [makeClaim("did:pkh:broken")],
        summary,
      }),
    );

    expect(result.responsibilityClaim).toBe(false);
    expect(result.unqualifiedResponsibilityClaims).toHaveLength(1);
  });

  it("still passes on an approved-issuer assessment when only a squatted claim exists", async () => {
    const result = await checkAttestation(
      artifactDid,
      publisherDid,
      context,
      makeArtifactTrustResponse({
        responsibilityClaims: [makeClaim("did:web:squatter.example")],
        securityAssessments: [makeEvidence()],
        summary: { ...summary, totalQueried: 2, totalVerified: 2 },
      }),
    );

    expect(result.primaryEvidenceFound).toBe(true);
    expect(result.responsibilityClaim).toBe(false);
    expect(result.cybersecurityAssessment).toBe(true);
    expect(result.unqualifiedResponsibilityClaims).toHaveLength(1);
  });
});
