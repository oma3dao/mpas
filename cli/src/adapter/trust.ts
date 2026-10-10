/**
 * OMATrust Plugin Trust Verification
 *
 * The `canTrust` function evaluates the backend's verified artifact evidence
 * using two MPAS policy checks:
 *   1. A verified responsibility claim from the plugin's declared publisher
 *   2. A cybersecurity assessment from an approved issuer
 *
 * Linked identifiers are displayed for operator judgment and do not
 * independently determine the verdict.
 */

import type { MpasApplicationPlugin } from "../core/plugin-loader.js";
import type { DeploymentConfig } from "./config-loader.js";
import {
  DEFAULT_ARTIFACT_TRUST_CHAIN,
  DEFAULT_ARTIFACT_TRUST_API_URL,
  fetchArtifactTrust,
  type ArtifactTrustChainExpectation,
} from "./artifact-trust-client.js";
import { checkAttestation, type AttestationCheckResult } from "./trust-attestation.js";
import {
  listLinkedIdentifiers,
  type LinkedIdentifierSummary,
} from "./trust-linkage.js";

export interface TrustVerdict {
  primaryEvidenceFound: boolean;
  warningRequired: boolean;
  reasons: TrustReason[];
}

export interface TrustReason {
  check: string;
  passed: boolean;
  message: string;
}

export interface TrustContext {
  /** Full Artifact Trust API URL. Internal injection point for tests/embedding. */
  artifactTrustApiUrl: string;
  /** Chain and EAS deployment that responses from this endpoint must identify. */
  expectedChain: ArtifactTrustChainExpectation;
}

export const DEFAULT_TRUST_CONTEXT: TrustContext = {
  artifactTrustApiUrl: DEFAULT_ARTIFACT_TRUST_API_URL,
  expectedChain: DEFAULT_ARTIFACT_TRUST_CHAIN,
};

export interface PluginTrustReport {
  artifactDid: string;
  /** The publisher the plugin declares; the party a claim must name to count. */
  publisherDid: string;
  pluginDid: string;
  pluginVersion: string;
  targetApplicationDid: string;
  verdict: TrustVerdict;
  attestation: AttestationCheckResult;
  linkedIdentifiers: LinkedIdentifierSummary[];
}

function buildReasons(
  attestationResult: AttestationCheckResult,
): TrustReason[] {
  const responsibilityClaim = attestationResult.responsibilityClaims[0];
  const cybersecurityAssessment = attestationResult.attestations.find(
    (item) =>
      item.schemaLabel === "security-assessment" &&
      item.isApprovedIssuer,
  );
  return [
    {
      check: "responsibility-claim",
      passed: attestationResult.responsibilityClaim,
      message: responsibilityClaim
        ? attestationResult.message
        : "No verified responsibility claim was found.",
    },
    {
      check: "cybersecurity-assessment",
      passed: attestationResult.cybersecurityAssessment,
      message: cybersecurityAssessment
        ? `Cybersecurity assessed by: ${
          cybersecurityAssessment.attesterLabel ??
          cybersecurityAssessment.attester
        }`
        : "No verified cybersecurity assessment from an approved issuer was found.",
    },
  ];
}

/**
 * Evaluates whether a plugin can be trusted.
 *
 * A responsibility claim naming the plugin's declared publisher, or an
 * approved-issuer cybersecurity assessment, is sufficient to avoid the
 * no-primary-evidence warning. A claim from any other party never is. This does not decide
 * that the responsible party is legitimate or trusted by the operator.
 * Backend or contract failures are allowed to throw so callers can distinguish
 * unavailable trust information from a complete response containing no
 * verified evidence.
 */
export async function canTrust(
  plugin: MpasApplicationPlugin,
  config: DeploymentConfig,
  trustContext: TrustContext,
): Promise<TrustVerdict> {
  const artifactDid = config.plugin.artifactDid;
  const artifactTrust = await fetchArtifactTrust(
    artifactDid,
    trustContext.artifactTrustApiUrl,
    trustContext.expectedChain,
  );
  const attestationResult = await checkAttestation(
    artifactDid,
    plugin.publisherDid,
    trustContext,
    artifactTrust,
  );

  return {
    primaryEvidenceFound: attestationResult.primaryEvidenceFound,
    warningRequired: !attestationResult.primaryEvidenceFound,
    reasons: buildReasons(attestationResult),
  };
}

/**
 * Builds a full trust report for logging/audit purposes.
 */
export async function buildTrustReport(
  plugin: MpasApplicationPlugin,
  config: DeploymentConfig,
  trustContext: TrustContext,
): Promise<PluginTrustReport> {
  const artifactDid = config.plugin.artifactDid;
  const artifactTrust = await fetchArtifactTrust(
    artifactDid,
    trustContext.artifactTrustApiUrl,
    trustContext.expectedChain,
  );
  const [attestationResult, linkedIdentifiers] = await Promise.all([
    checkAttestation(
      artifactDid,
      plugin.publisherDid,
      trustContext,
      artifactTrust,
    ),
    listLinkedIdentifiers(
      artifactDid,
      trustContext,
      artifactTrust,
    ),
  ]);

  return {
    artifactDid,
    publisherDid: plugin.publisherDid,
    pluginDid: config.plugin.pluginDid,
    pluginVersion: config.plugin.pluginVersion,
    targetApplicationDid: config.target.applicationDid,
    verdict: {
      primaryEvidenceFound: attestationResult.primaryEvidenceFound,
      warningRequired: !attestationResult.primaryEvidenceFound,
      reasons: buildReasons(attestationResult),
    },
    attestation: attestationResult,
    linkedIdentifiers,
  };
}
