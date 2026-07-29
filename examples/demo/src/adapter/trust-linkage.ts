import {
  fetchArtifactTrust,
  type ArtifactTrustResponse,
} from "./artifact-trust-client.js";
import type { TrustContext } from "./trust.js";

export interface LinkedIdentifierSummary {
  uid: string;
  linkedId: string;
  attester: string;
  attesterLabel?: string;
  verificationBasis: string[];
}

/**
 * Lists linked identifiers that the backend has already verified. MPAS does
 * not interpret a linked identifier as proof that the artifact belongs to the
 * configured application; the operator decides whether each link is relevant
 * and trustworthy.
 */
export async function listLinkedIdentifiers(
  artifactDid: string,
  context: TrustContext,
  artifactTrust?: ArtifactTrustResponse,
): Promise<LinkedIdentifierSummary[]> {
  const trust =
    artifactTrust ??
    await fetchArtifactTrust(artifactDid, context.artifactTrustApiUrl);
  return trust.otherAttestations.flatMap((item) => {
    const linkedId = item.attestation.data.linkedId;
    if (
      item.attestation.schemaName !== "linked-identifier" ||
      item.attestation.data.subject !== artifactDid ||
      typeof linkedId !== "string"
    ) {
      return [];
    }
    return [{
      uid: item.attestation.uid,
      linkedId,
      attester: item.attestation.attester,
      ...(item.attestation.attesterLabel
        ? { attesterLabel: item.attestation.attesterLabel }
        : {}),
      verificationBasis: item.verification.basis,
    }];
  });
}
