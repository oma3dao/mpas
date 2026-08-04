import {
  fetchArtifactTrust,
  type ArtifactTrustResponse,
  type VerifiedArtifactTrustAttestation,
} from "./artifact-trust-client.js";
import { normalizeDid } from "@oma3/omatrust/identity";
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
  /** Claims whose responsibleParty is the plugin's declared publisher. */
  responsibilityClaims: AttestationSummary[];
  /**
   * Verified claims naming some other responsibleParty. Anyone may attest a
   * responsibility claim against any artifact DID — the artifact does not
   * authorize the attester — so these never satisfy the primary check and are
   * not listed inline. They are surfaced as a count plus a file path.
   */
  unqualifiedResponsibilityClaims: AttestationSummary[];
  attestations: AttestationSummary[];
}

function responsiblePartyOf(claim: AttestationSummary): string | undefined {
  return typeof claim.data.responsibleParty === "string"
    ? claim.data.responsibleParty
    : undefined;
}

/**
 * Compares two DIDs under OMATrust's canonical normalization rather than by
 * raw string. `computeDidHash` normalizes before hashing, so this is the same
 * notion of identity the attestations are indexed under — a plain string
 * compare would disagree with the backend over `www.` prefixes, DID URL
 * fragments, surrounding whitespace, and per-method casing.
 *
 * Never throws: `responsibleParty` arrives from the backend, and a malformed
 * value must fail to match rather than abort plugin loading.
 */
function isSameDid(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  try {
    return normalizeDid(a) === normalizeDid(b);
  } catch {
    return false;
  }
}

function isDeclaredPublisher(
  claim: AttestationSummary,
  publisherDid: string,
): boolean {
  return isSameDid(responsiblePartyOf(claim), publisherDid);
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
 * policy to the backend's verified-only evidence. The adapter deliberately
 * does not repeat proof, revocation, expiry, payload, issuer-registry, or
 * controller verification.
 *
 * A responsibility claim only counts when its `responsibleParty` is the
 * publisher the plugin itself declares. Verification proves that the attester
 * controls the identity it names, not that the artifact's publisher endorsed
 * it, so an unrelated party can attest a claim against any artifact DID.
 * Without this check such a claim would satisfy the primary check and suppress
 * the operator warning. `publisherDid` is read from the plugin, which the
 * loader has already hash-verified against the configured `artifactDid`, so it
 * cannot be substituted independently of the content being vouched for.
 */
export async function checkAttestation(
  artifactDid: string,
  publisherDid: string,
  context: TrustContext,
  artifactTrust?: ArtifactTrustResponse,
): Promise<AttestationCheckResult> {
  const trust =
    artifactTrust ??
    await fetchArtifactTrust(artifactDid, context.artifactTrustApiUrl);
  const allClaims = trust.responsibilityClaims.map(summarize);
  const responsibilityClaims = allClaims.filter((claim) =>
    isDeclaredPublisher(claim, publisherDid)
  );
  const unqualifiedResponsibilityClaims = allClaims.filter((claim) =>
    !isDeclaredPublisher(claim, publisherDid)
  );
  const attestations = otherDisplayableEvidence(trust).map(summarize);
  const cybersecurityAssessment = trust.securityAssessments
    .map(summarize)
    .find((item) => item.isApprovedIssuer);

  const base = {
    unqualifiedResponsibilityClaims,
    attestations,
  };

  if (responsibilityClaims.length > 0) {
    return {
      ...base,
      primaryEvidenceFound: true,
      message: `Responsibility claimed by the declared publisher: ${publisherDid}`,
      responsibilityClaim: true,
      cybersecurityAssessment: Boolean(cybersecurityAssessment),
      responsibilityClaims,
    };
  }

  if (cybersecurityAssessment) {
    return {
      ...base,
      primaryEvidenceFound: true,
      message:
        `Cybersecurity assessed by: ${
          cybersecurityAssessment.attesterLabel ??
          cybersecurityAssessment.attester
        }`,
      responsibilityClaim: false,
      cybersecurityAssessment: true,
      responsibilityClaims: [],
    };
  }

  if (unqualifiedResponsibilityClaims.length > 0) {
    return {
      ...base,
      primaryEvidenceFound: false,
      message:
        `No responsibility claim from the declared publisher ${publisherDid}. ` +
        `${unqualifiedResponsibilityClaims.length} verified claim(s) name a different responsible party.`,
      responsibilityClaim: false,
      cybersecurityAssessment: false,
      responsibilityClaims: [],
    };
  }

  if (attestations.length === 0) {
    return {
      ...base,
      primaryEvidenceFound: false,
      message: "Zero verified responsibility claims or cybersecurity assessments found for this artifact on OMATrust.",
      responsibilityClaim: false,
      cybersecurityAssessment: false,
      responsibilityClaims: [],
    };
  }

  return {
    ...base,
    primaryEvidenceFound: false,
    message:
      "Verified secondary or informational evidence exists, but there is no responsibility claim or cybersecurity assessment.",
    responsibilityClaim: false,
    cybersecurityAssessment: false,
    responsibilityClaims: [],
  };
}
