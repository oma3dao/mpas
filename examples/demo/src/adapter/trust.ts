/**
 * OMATrust Plugin Trust Verification
 *
 * The `canTrust` function evaluates whether a plugin should be trusted based on two checks:
 *   1. Attestation from an approved issuer (on-chain via EAS)
 *   2. Linked identifier proving the artifact DID is associated with the target URL
 *
 * Either check passing is sufficient for `trusted: true`.
 */

import type { MpasApplicationPlugin } from "../core/plugin-loader.js";
import type { DeploymentConfig } from "./config-loader.js";
import { checkAttestation, type AttestationCheckResult } from "./trust-attestation.js";
import { checkLinkage, type LinkageCheckResult } from "./trust-linkage.js";

export interface TrustVerdict {
  trusted: boolean;
  reasons: TrustReason[];
}

export interface TrustReason {
  check: string;
  passed: boolean;
  message: string;
}

export interface ApprovedIssuer {
  address: string;
  label: string;
}

export interface TrustContext {
  /** OMATrust backend URL for fetching trust anchors */
  backendUrl: string;
  /** Approved issuers fetched from the trust-policy API */
  approvedIssuers: ApprovedIssuer[];
  /** Schema UIDs to query */
  schemas: {
    securityAssessment: string;
    certification: string;
    userReview: string;
    linkedIdentifier: string;
    controllerWitness: string;
  };
  /** Schema UID → human label mapping (from trust-anchors chains[].schemas) */
  schemaLabels?: Map<string, string>;
  /** RPC endpoint for querying EAS on-chain */
  rpcUrl: string;
  /** EAS contract address */
  easContractAddress: string;
}

export interface OmaTrustConfig {
  /** RPC endpoint for the chain where attestations live */
  rpcUrl: string;
  /** EAS contract address on that chain */
  easContractAddress: string;
  /** OMATrust backend URL (trust-policy API provides approved issuers) */
  backendUrl: string;
  /** Schema UIDs to query */
  schemas: {
    securityAssessment: string;
    certification: string;
    userReview: string;
    linkedIdentifier: string;
    controllerWitness: string;
  };
  /** Skip OMATrust check entirely (e.g., offline/CI environments) */
  disabled?: boolean;
}

export interface PluginTrustReport {
  artifactDid: string;
  pluginDid: string;
  pluginVersion: string;
  targetUrl: string;
  verdict: TrustVerdict;
  attestation: AttestationCheckResult;
  linkage: LinkageCheckResult;
}

/**
 * Evaluates whether a plugin can be trusted.
 *
 * Either check passing is sufficient for trusted: true.
 * If canTrust throws (network failure, SDK error), callers should treat the plugin as untrusted.
 */
export async function canTrust(
  plugin: MpasApplicationPlugin,
  config: DeploymentConfig,
  trustContext: TrustContext,
): Promise<TrustVerdict> {
  const artifactDid = config.plugin.artifactDid;
  const targetUrl = extractTargetUrl(config.target.applicationDid);

  const [attestationResult, linkageResult] = await Promise.allSettled([
    checkAttestation(artifactDid, trustContext),
    checkLinkage(artifactDid, targetUrl, trustContext),
  ]);

  const attestationPassed =
    attestationResult.status === "fulfilled" && attestationResult.value.passed;
  const linkagePassed =
    linkageResult.status === "fulfilled" && linkageResult.value.passed;

  const reasons: TrustReason[] = [];

  // Check 1: Attestation
  if (attestationResult.status === "fulfilled") {
    reasons.push({
      check: "attestation",
      passed: attestationResult.value.passed,
      message: attestationResult.value.message,
    });
  } else {
    reasons.push({
      check: "attestation",
      passed: false,
      message: `Attestation check failed: ${attestationResult.reason instanceof Error ? attestationResult.reason.message : "unknown error"}`,
    });
  }

  // Check 2: Linkage
  if (linkageResult.status === "fulfilled") {
    reasons.push({
      check: "linkage",
      passed: linkageResult.value.passed,
      message: linkageResult.value.message,
    });
  } else {
    reasons.push({
      check: "linkage",
      passed: false,
      message: `Linkage check failed: ${linkageResult.reason instanceof Error ? linkageResult.reason.message : "unknown error"}`,
    });
  }

  return {
    trusted: attestationPassed || linkagePassed,
    reasons,
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
  const targetUrl = extractTargetUrl(config.target.applicationDid);

  const [attestationResult, linkageResult] = await Promise.all([
    checkAttestation(artifactDid, trustContext).catch((err) => ({
      passed: false,
      message: `Check failed: ${err instanceof Error ? err.message : "unknown"}`,
      attestations: [],
    })),
    checkLinkage(artifactDid, targetUrl, trustContext).catch((err) => ({
      passed: false,
      message: `Check failed: ${err instanceof Error ? err.message : "unknown"}`,
      linkedIdentifier: false,
      controllerWitness: false,
      dnsTxt: false,
      wellKnownDid: false,
    })),
  ]);

  const reasons: TrustReason[] = [
    { check: "attestation", passed: attestationResult.passed, message: attestationResult.message },
    { check: "linkage", passed: linkageResult.passed, message: linkageResult.message },
  ];

  return {
    artifactDid,
    pluginDid: config.plugin.pluginDid,
    pluginVersion: config.plugin.pluginVersion,
    targetUrl,
    verdict: {
      trusted: attestationResult.passed || linkageResult.passed,
      reasons,
    },
    attestation: attestationResult,
    linkage: linkageResult,
  };
}

/**
 * Extracts a URL/domain from an applicationDid.
 * e.g., "did:web:github.example" → "github.example"
 */
export function extractTargetUrl(applicationDid: string): string {
  // did:web:domain.example → domain.example
  // did:web:domain.example:path:segments → domain.example/path/segments
  const parts = applicationDid.replace(/^did:web:/, "");
  return decodeURIComponent(parts.replaceAll(":", "/"));
}
