export interface ArtifactTrustChain {
  chainId: number;
  caip2: string;
  easContract: string;
}

export interface ArtifactTrustAttestation {
  uid: string;
  schema: string;
  schemaName: string;
  attester: string;
  attesterLabel?: string;
  recipient: string;
  time: string;
  expirationTime: string;
  revocationTime: string;
  data: Record<string, unknown>;
}

export interface VerifiedArtifactTrustAttestation {
  attestation: ArtifactTrustAttestation;
  verification: {
    valid: true;
    basis: string[];
  };
}

export interface ArtifactTrustResponse {
  artifactDid: string;
  chain: ArtifactTrustChain;
  trustAnchorsVersion: number;
  responsibilityClaims: VerifiedArtifactTrustAttestation[];
  securityAssessments: VerifiedArtifactTrustAttestation[];
  certifications: VerifiedArtifactTrustAttestation[];
  otherAttestations: VerifiedArtifactTrustAttestation[];
  summary: {
    totalQueried: number;
    totalVerified: number;
    totalExcluded: number;
    complete: true;
  };
}

// Staging CA test against the testnet gateway or backend origin:
// "https://test.api.omatrust.org/v1/artifact-trust"
// "https://test.backend.omatrust.org/api/public/artifact-trust"
export const DEFAULT_ARTIFACT_TRUST_API_URL =
  "https://api.omatrust.org/v1/artifact-trust";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(
  value: unknown,
  field: string,
  pattern?: RegExp,
): string {
  if (typeof value !== "string" || (pattern && !pattern.test(value))) {
    throw new Error(`Artifact trust response has an invalid ${field}`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Artifact trust response has an invalid ${field}`);
  }
  return value;
}

function parseEvidenceItem(
  value: unknown,
  group: string,
): VerifiedArtifactTrustAttestation {
  if (!isRecord(value) || !isRecord(value.attestation) || !isRecord(value.verification)) {
    throw new Error(`Artifact trust response has an invalid ${group} item`);
  }

  const attestation = value.attestation;
  const verification = value.verification;
  if (verification.valid !== true || !Array.isArray(verification.basis)) {
    throw new Error(`Artifact trust response contains unverified ${group} evidence`);
  }
  const basis = verification.basis.map((entry) =>
    requireString(entry, `${group}.verification.basis`),
  );
  if (!isRecord(attestation.data)) {
    throw new Error(`Artifact trust response has invalid ${group} data`);
  }

  return {
    attestation: {
      uid: requireString(attestation.uid, `${group}.uid`),
      schema: requireString(attestation.schema, `${group}.schema`),
      schemaName: requireString(attestation.schemaName, `${group}.schemaName`),
      attester: requireString(attestation.attester, `${group}.attester`),
      ...(attestation.attesterLabel === undefined
        ? {}
        : { attesterLabel: requireString(attestation.attesterLabel, `${group}.attesterLabel`) }),
      recipient: requireString(attestation.recipient, `${group}.recipient`),
      time: requireString(attestation.time, `${group}.time`, /^\d+$/),
      expirationTime: requireString(
        attestation.expirationTime,
        `${group}.expirationTime`,
        /^\d+$/,
      ),
      revocationTime: requireString(
        attestation.revocationTime,
        `${group}.revocationTime`,
        /^\d+$/,
      ),
      data: attestation.data,
    },
    verification: {
      valid: true,
      basis,
    },
  };
}

function parseEvidenceGroup(
  value: unknown,
  group: string,
): VerifiedArtifactTrustAttestation[] {
  if (!Array.isArray(value)) {
    throw new Error(`Artifact trust response is missing ${group}`);
  }
  return value.map((entry) => parseEvidenceItem(entry, group));
}

export function parseArtifactTrustResponse(value: unknown): ArtifactTrustResponse {
  if (!isRecord(value) || !isRecord(value.chain) || !isRecord(value.summary)) {
    throw new Error("Artifact trust API returned a malformed response");
  }

  const responsibilityClaims = parseEvidenceGroup(
    value.responsibilityClaims,
    "responsibilityClaims",
  );
  const securityAssessments = parseEvidenceGroup(
    value.securityAssessments,
    "securityAssessments",
  );
  const certifications = parseEvidenceGroup(value.certifications, "certifications");
  const otherAttestations = parseEvidenceGroup(
    value.otherAttestations,
    "otherAttestations",
  );
  const totalVerified = requireNumber(value.summary.totalVerified, "summary.totalVerified");
  const actualVerified =
    responsibilityClaims.length +
    securityAssessments.length +
    certifications.length +
    otherAttestations.length;
  if (
    value.summary.complete !== true ||
    totalVerified !== actualVerified ||
    requireNumber(value.summary.totalQueried, "summary.totalQueried") !==
      totalVerified + requireNumber(value.summary.totalExcluded, "summary.totalExcluded")
  ) {
    throw new Error("Artifact trust response has an inconsistent summary");
  }

  return {
    artifactDid: requireString(value.artifactDid, "artifactDid"),
    chain: {
      chainId: requireNumber(value.chain.chainId, "chain.chainId"),
      caip2: requireString(value.chain.caip2, "chain.caip2"),
      easContract: requireString(value.chain.easContract, "chain.easContract"),
    },
    trustAnchorsVersion: requireNumber(value.trustAnchorsVersion, "trustAnchorsVersion"),
    responsibilityClaims,
    securityAssessments,
    certifications,
    otherAttestations,
    summary: {
      totalQueried: value.summary.totalQueried as number,
      totalVerified,
      totalExcluded: value.summary.totalExcluded as number,
      complete: true,
    },
  };
}

export async function fetchArtifactTrust(
  artifactDid: string,
  artifactTrustApiUrl = DEFAULT_ARTIFACT_TRUST_API_URL,
): Promise<ArtifactTrustResponse> {
  const endpoint = new URL(artifactTrustApiUrl);
  endpoint.searchParams.set("artifactDid", artifactDid);
  const response = await fetch(endpoint, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(
      `Artifact trust API returned ${response.status}: ${response.statusText}`,
    );
  }

  const result = parseArtifactTrustResponse(await response.json());
  if (result.artifactDid !== artifactDid) {
    throw new Error("Artifact trust API returned evidence for a different artifact");
  }
  return result;
}
