/**
 * Check 1: Attestation from an approved issuer.
 *
 * Queries EAS for attestations on the artifact DID's address (computed via didToAddress).
 * At least one non-revoked, non-expired attestation from an approved issuer must exist.
 *
 * Uses the @oma3/omatrust SDK patterns:
 * - didToAddress() converts any DID to its EAS recipient address (keccak256 → low 160 bits)
 * - getAttestationsForDid() queries EAS contract events by recipient + schema UIDs
 * - Schema labels come from trust-anchors (chains[].schemas mapping)
 */

import type { TrustContext, ApprovedIssuer } from "./trust.js";

export interface AttestationSummary {
  uid: string;
  attester: string;
  attesterLabel?: string;
  isApprovedIssuer: boolean;
  schemaUid: string;
  schemaLabel?: string;
  time: bigint;
  expirationTime: bigint;
  revoked: boolean;
}

export interface AttestationCheckResult {
  passed: boolean;
  message: string;
  attestations: AttestationSummary[];
}

/**
 * Queries EAS for attestations on the artifact DID and determines whether
 * any valid attestation from an approved issuer exists.
 *
 * The artifact DID is converted to a DID address via didToAddress() (keccak256 hash,
 * low 160 bits). This address is used as the EAS recipient when querying on-chain events.
 */
export async function checkAttestation(
  artifactDid: string,
  context: TrustContext,
): Promise<AttestationCheckResult> {
  const relevantSchemas = [
    context.schemas.securityAssessment,
    context.schemas.certification,
    context.schemas.userReview,
  ];

  // Query attestations via the SDK's getAttestationsForDid pattern.
  // This uses didToAddress(subjectDid) internally to convert the DID to a recipient address,
  // then queries the EAS contract for Attested events filtered by that recipient + schema UIDs.
  const attestations = await queryAttestationsForDid(artifactDid, relevantSchemas, context);

  if (attestations.length === 0) {
    return {
      passed: false,
      message: "Zero attestations: No attestations found for this artifact on OMATrust.",
      attestations: [],
    };
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  const approvedAddresses = new Set(
    context.approvedIssuers.map((issuer) => issuer.address.toLowerCase()),
  );
  const labelByAddress = new Map(
    context.approvedIssuers.map((issuer) => [issuer.address.toLowerCase(), issuer.label]),
  );

  const summaries: AttestationSummary[] = attestations.map((att) => ({
    uid: att.uid,
    attester: att.attester,
    attesterLabel: labelByAddress.get(att.attester.toLowerCase()),
    isApprovedIssuer: approvedAddresses.has(att.attester.toLowerCase()),
    schemaUid: att.schema,
    schemaLabel: context.schemaLabels?.get(att.schema),
    time: att.time,
    expirationTime: att.expirationTime,
    revoked: att.revocationTime > 0n,
  }));

  // Find at least one valid attestation from an approved issuer
  const validFromApproved = summaries.filter(
    (att) =>
      att.isApprovedIssuer &&
      !att.revoked &&
      (att.expirationTime === 0n || att.expirationTime > now),
  );

  if (validFromApproved.length > 0) {
    const best = validFromApproved[0];
    const label = best.schemaLabel ?? "attestation";
    return {
      passed: true,
      message: `Attested by: ${best.attesterLabel ?? best.attester} (${label})`,
      attestations: summaries,
    };
  }

  // Attestations exist but none pass
  const hasAnyApprovedIssuer = summaries.some((att) => att.isApprovedIssuer);
  if (!hasAnyApprovedIssuer) {
    return {
      passed: false,
      message: "Attestations exist but none are from an approved issuer.",
      attestations: summaries,
    };
  }

  return {
    passed: false,
    message: "All attestations from approved issuers are revoked or expired.",
    attestations: summaries,
  };
}

// ---------------------------------------------------------------------------
// SDK interaction layer
// ---------------------------------------------------------------------------

interface SdkAttestationResult {
  uid: string;
  schema: string;
  attester: string;
  recipient: string;
  time: bigint;
  expirationTime: bigint;
  revocationTime: bigint;
  refUID: string;
  revocable: boolean;
  data: Record<string, unknown>;
  raw?: string;
}

/**
 * Queries attestations for a DID using the omatrust SDK pattern.
 *
 * The SDK's getAttestationsForDid() does:
 * 1. didToAddress(subjectDid) → derives a 20-byte address from keccak256(normalizeDid(did))
 * 2. Queries EAS contract's Attested events filtered by that recipient address
 * 3. For each matching event, fetches the full attestation via eas.getAttestation(uid)
 * 4. Returns typed results with decoded data
 *
 * We replicate this via an RPC provider connected to the EAS contract.
 */
async function queryAttestationsForDid(
  subjectDid: string,
  schemaUids: string[],
  context: TrustContext,
): Promise<SdkAttestationResult[]> {
  // Import the SDK functions at runtime. This avoids hard-coupling to the SDK at import time,
  // allowing the trust module to gracefully degrade if the SDK isn't installed.
  const { didToAddress } = await import("@oma3/omatrust/identity");
  const { getAttestationsForDid } = await import("@oma3/omatrust/reputation");
  const { JsonRpcProvider } = await import("ethers");

  const provider = new JsonRpcProvider(context.rpcUrl);
  const didAddress = didToAddress(subjectDid);

  const results = await getAttestationsForDid({
    subjectDid,
    provider,
    easContractAddress: context.easContractAddress as `0x${string}`,
    schemas: schemaUids as `0x${string}`[],
  });

  return results as unknown as SdkAttestationResult[];
}
