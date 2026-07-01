/**
 * Check 2: Linked identifier (artifact DID → target URL).
 *
 * Verifies that the artifact DID is linked to the plugin's declared target URL.
 *
 * A linked-identifier attestation has:
 *   - An issuer (attester address) who is the controller
 *   - Two subjects: the did:artifact and the target URL's DID
 *   - A proof demonstrating shared control
 *
 * The system checks if the issuer address is authorized by the target URL via:
 *   - DNS TXT record (_controllers.domain) listing the address
 *   - /.well-known/did.json listing the address in verificationMethod
 *   - Controller-witness attestation
 *   - Key-binding attestation
 *
 * This is analogous to code signing — it proves the entity controlling the
 * artifact also controls (or is vouched for by) the target service.
 */

import type { TrustContext } from "./trust.js";

export interface LinkageCheckResult {
  passed: boolean;
  message: string;
  linkedIdentifier: boolean;
  controllerWitness: boolean;
  dnsTxt: boolean;
  wellKnownDid: boolean;
}

/**
 * Checks whether the artifact DID is linked to the target domain via
 * a linked-identifier attestation with a valid proof, where the issuer
 * is authorized by the target URL.
 *
 * Uses the OMATrust backend's controller-confirm API to determine if
 * the issuer is recognized as a controller of the target domain.
 */
export async function checkLinkage(
  artifactDid: string,
  targetDomain: string,
  context: TrustContext,
): Promise<LinkageCheckResult> {
  const targetDid = `did:web:${targetDomain}`;

  // Step 1: Find a linked-identifier attestation connecting the artifact DID to the target.
  const linkedIdAttestation = await findLinkedIdentifierAttestation(
    artifactDid,
    targetDid,
    context,
  );

  if (!linkedIdAttestation) {
    // No linked-identifier attestation exists — fall back to checking the backend
    // controller-confirm endpoint directly (which checks DNS TXT + did.json).
    const controllerResult = await checkControllerConfirm(artifactDid, targetDomain, context);
    return controllerResult;
  }

  // Step 2: Verify the proof in the linked-identifier attestation.
  const proofValid = await verifyLinkedIdentifierProof(linkedIdAttestation, context);
  if (!proofValid) {
    return {
      passed: false,
      message: `Linked-identifier attestation exists but its proof is invalid or missing.`,
      linkedIdentifier: false,
      controllerWitness: false,
      dnsTxt: false,
      wellKnownDid: false,
    };
  }

  // Step 3: Check if the issuer (attester) is authorized by the target URL.
  const issuerAuthorized = await isIssuerAuthorizedByTarget(
    linkedIdAttestation.attester,
    targetDomain,
    context,
  );

  if (issuerAuthorized.authorized) {
    return {
      passed: true,
      message: `Linked to: ${targetDomain} (linked-identifier, controller confirmed via ${issuerAuthorized.method})`,
      linkedIdentifier: true,
      controllerWitness: issuerAuthorized.method === "controller-witness",
      dnsTxt: issuerAuthorized.method === "dns-txt",
      wellKnownDid: issuerAuthorized.method === "did-json",
    };
  }

  return {
    passed: false,
    message: `No linkage: The linked-identifier attestation issuer is not authorized by ${targetDomain}. Without linkage, there is no trusted issuer that vouches for this plugin's association with its declared target.`,
    linkedIdentifier: false,
    controllerWitness: false,
    dnsTxt: false,
    wellKnownDid: false,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface LinkedIdAttestationData {
  uid: string;
  attester: string;
  subject: string;
  linkedId: string;
  proofs: unknown[];
  expirationTime: bigint;
  revocationTime: bigint;
}

/**
 * Finds a linked-identifier attestation that connects the artifact DID to the target DID.
 * The attestation should have one subject = artifactDid and linkedId = targetDid (or vice versa).
 */
async function findLinkedIdentifierAttestation(
  artifactDid: string,
  targetDid: string,
  context: TrustContext,
): Promise<LinkedIdAttestationData | null> {
  try {
    const { didToAddress } = await import("@oma3/omatrust/identity");
    const { getAttestationsForDid } = await import("@oma3/omatrust/reputation");
    const { JsonRpcProvider } = await import("ethers");

    const provider = new JsonRpcProvider(context.rpcUrl);

    // Query attestations where the artifact DID is the recipient
    const results = await getAttestationsForDid({
      subjectDid: artifactDid,
      provider,
      easContractAddress: context.easContractAddress as `0x${string}`,
      schemas: [context.schemas.linkedIdentifier as `0x${string}`],
    });

    const now = BigInt(Math.floor(Date.now() / 1000));

    for (const att of results) {
      // Skip revoked or expired
      if (att.revocationTime > 0n) continue;
      if (att.expirationTime > 0n && att.expirationTime <= now) continue;

      const data = att.data as Record<string, unknown>;
      const subject = String(data.subject ?? "");
      const linkedId = String(data.linkedId ?? "");
      const proofs = Array.isArray(data.proofs) ? data.proofs : [];

      // Check if this attestation links artifactDid ↔ targetDid
      const linksToTarget =
        (subject === artifactDid && linkedId === targetDid) ||
        (subject === targetDid && linkedId === artifactDid);

      if (linksToTarget) {
        return {
          uid: att.uid,
          attester: att.attester,
          subject,
          linkedId,
          proofs,
          expirationTime: att.expirationTime,
          revocationTime: att.revocationTime,
        };
      }
    }
  } catch {
    // SDK or network error — return null to fall through to other checks
  }

  return null;
}

/**
 * Verifies the proof in a linked-identifier attestation using the SDK's
 * schema-aware proof verification.
 */
async function verifyLinkedIdentifierProof(
  attestation: LinkedIdAttestationData,
  _context: TrustContext,
): Promise<boolean> {
  if (!attestation.proofs || attestation.proofs.length === 0) {
    return false;
  }

  try {
    const { verifyLinkedIdentifierProofs } = await import(
      "@oma3/omatrust/reputation"
    );

    const result = verifyLinkedIdentifierProofs({
      subject: attestation.subject,
      linkedId: attestation.linkedId,
      proofs: attestation.proofs as never[],
      attester: attestation.attester,
    });

    return result.valid;
  } catch {
    return false;
  }
}

/**
 * Checks if an issuer address is authorized by the target domain.
 *
 * Uses the OMATrust backend's controller-confirm API, which checks:
 *   - DNS TXT at _controllers.<domain> for the address
 *   - /.well-known/did.json verificationMethod entries
 *
 * This replicates the logic in service-controller-service.ts.
 */
async function isIssuerAuthorizedByTarget(
  issuerAddress: string,
  targetDomain: string,
  context: TrustContext,
): Promise<{ authorized: boolean; method?: string }> {
  try {
    const targetDid = `did:web:${targetDomain}`;
    const response = await fetch(
      `${context.backendUrl}/api/public/controller-confirm?subjectDid=${encodeURIComponent(targetDid)}`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!response.ok) {
      return { authorized: false };
    }

    const body = (await response.json()) as {
      controllerKeys: Array<{
        canonicalId: string;
        sources: string[];
      }>;
    };

    // Check if the issuer address appears in the controller keys
    const normalizedIssuer = issuerAddress.toLowerCase();
    for (const key of body.controllerKeys) {
      // The canonicalId may be a did:pkh containing the address
      if (key.canonicalId.toLowerCase().includes(normalizedIssuer)) {
        // Return the first source as the method
        const method = key.sources[0] ?? "unknown";
        return { authorized: true, method };
      }
    }

    return { authorized: false };
  } catch {
    return { authorized: false };
  }
}

/**
 * Fallback: check controller-confirm directly for the artifact DID
 * (bypasses linked-identifier attestation, checks if the artifact is
 * directly referenced in the target's DNS or did.json).
 */
async function checkControllerConfirm(
  artifactDid: string,
  targetDomain: string,
  context: TrustContext,
): Promise<LinkageCheckResult> {
  try {
    const targetDid = `did:web:${targetDomain}`;
    const response = await fetch(
      `${context.backendUrl}/api/public/controller-endpoint-confirm?subjectDid=${encodeURIComponent(targetDid)}`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!response.ok) {
      return noLinkage(targetDomain);
    }

    const body = (await response.json()) as {
      controllerKeys: Array<{ canonicalId: string; sources: string[] }>;
      evidence: Array<{ kind: string; status: string; keys: string[] }>;
    };

    // Check evidence sources for any reference to the artifact DID
    const dnsEvidence = body.evidence.find((e) => e.kind === "dns-txt" && e.status === "found");
    const didJsonEvidence = body.evidence.find((e) => e.kind === "did-json" && e.status === "found");

    // Check if any discovered key references the artifact DID
    const dnsHasArtifact = dnsEvidence?.keys.some((k) => k.includes(artifactDid)) ?? false;
    const didJsonHasArtifact = didJsonEvidence?.keys.some((k) => k.includes(artifactDid)) ?? false;

    if (dnsHasArtifact || didJsonHasArtifact) {
      const methods: string[] = [];
      if (dnsHasArtifact) methods.push("DNS TXT");
      if (didJsonHasArtifact) methods.push(".well-known/did.json");

      return {
        passed: true,
        message: `Linked to: ${targetDomain} (${methods.join(", ")})`,
        linkedIdentifier: false,
        controllerWitness: false,
        dnsTxt: dnsHasArtifact,
        wellKnownDid: didJsonHasArtifact,
      };
    }

    return noLinkage(targetDomain);
  } catch {
    return noLinkage(targetDomain);
  }
}

function noLinkage(targetDomain: string): LinkageCheckResult {
  return {
    passed: false,
    message: `No linkage: did:artifact is not linked to the URL this plugin targets (${targetDomain}). Without linkage, there is no trusted issuer that vouches for this plugin's association with its declared target.`,
    linkedIdentifier: false,
    controllerWitness: false,
    dnsTxt: false,
    wellKnownDid: false,
  };
}
