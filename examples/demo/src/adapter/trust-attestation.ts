import {
  fetchArtifactTrust,
  type ArtifactTrustResponse,
  type VerifiedArtifactTrustAttestation,
} from "./artifact-trust-client.js";
import type { TrustContext } from "./trust.js";

export interface AttestationSummary {
  uid: string;
  attester: string;
  attesterLabel?: string;
  isApprovedIssuer: boolean;
  schemaUid: string;
  schemaLabel: string;
  time: string;
  expirationTime: string;
  verificationBasis: string[];
  data: Record<string, unknown>;
}

export interface AttestationCheckResult {
  primaryEvidenceFound: boolean;
  message: string;
  responsibilityClaim: boolean;
  cybersecurityAssessment: boolean;
  responsibilityClaims: AttestationSummary[];
  attestations: AttestationSummary[];
}

function otherDisplayableEvidence(
  trust: ArtifactTrustResponse,
): VerifiedArtifactTrustAttestation[] {
  return [
    ...trust.securityAssessments,
    ...trust.certifications,
    ...trust.otherAttestations.filter(
      (item) =>
        item.attestation.schemaName !== "linked-identifier" &&
        item.attestation.schemaName !== "user-review",
    ),
  ];
}

function summarize(
  item: VerifiedArtifactTrustAttestation,
): AttestationSummary {
  return {
    uid: item.attestation.uid,
    attester: item.attestation.attester,
    ...(item.attestation.attesterLabel
      ? { attesterLabel: item.attestation.attesterLabel }
      : {}),
    isApprovedIssuer: item.verification.basis.includes("approved-issuer"),
    schemaUid: item.attestation.schema,
    schemaLabel: item.attestation.schemaName,
    time: item.attestation.time,
    expirationTime: item.attestation.expirationTime,
    verificationBasis: item.verification.basis,
    data: item.attestation.data,
  };
}

/**
 * Applies MPAS's primary responsibility-claim and cybersecurity-assessment
 * policy to the backend's verified-only evidence. Responsibility claims are
 * kept separate so the operator can readily see who accepts responsibility
 * for the artifact. The adapter deliberately does not repeat proof,
 * revocation, expiry, payload, issuer-registry, or controller verification.
 */
export async function checkAttestation(
  artifactDid: string,
  context: TrustContext,
  artifactTrust?: ArtifactTrustResponse,
): Promise<AttestationCheckResult> {
  const trust =
    artifactTrust ??
    await fetchArtifactTrust(artifactDid, context.artifactTrustApiUrl);
  const responsibilityClaims = trust.responsibilityClaims.map(summarize);
  const attestations = otherDisplayableEvidence(trust).map(summarize);
  const cybersecurityAssessment = trust.securityAssessments
    .map(summarize)
    .find((item) => item.isApprovedIssuer);

  if (responsibilityClaims.length > 0) {
    const claim = responsibilityClaims[0];
    const responsibleParty = typeof claim.data.responsibleParty === "string"
      ? claim.data.responsibleParty
      : claim.attesterLabel ?? claim.attester;
    return {
      primaryEvidenceFound: true,
      message: `Responsibility claimed by: ${responsibleParty}`,
      responsibilityClaim: true,
      cybersecurityAssessment: Boolean(cybersecurityAssessment),
      responsibilityClaims,
      attestations,
    };
  }

  if (cybersecurityAssessment) {
    return {
      primaryEvidenceFound: true,
      message:
        `Cybersecurity assessed by: ${
          cybersecurityAssessment.attesterLabel ??
          cybersecurityAssessment.attester
        }`,
      responsibilityClaim: false,
      cybersecurityAssessment: true,
      responsibilityClaims: [],
      attestations,
    };
  }

  if (attestations.length === 0) {
    return {
      primaryEvidenceFound: false,
      message: "Zero verified responsibility claims or cybersecurity assessments found for this artifact on OMATrust.",
      responsibilityClaim: false,
      cybersecurityAssessment: false,
      responsibilityClaims: [],
      attestations: [],
    };
  }

  return {
    primaryEvidenceFound: false,
    message:
      "Verified secondary or informational evidence exists, but there is no responsibility claim or cybersecurity assessment.",
    responsibilityClaim: false,
    cybersecurityAssessment: false,
    responsibilityClaims: [],
    attestations,
  };
}
