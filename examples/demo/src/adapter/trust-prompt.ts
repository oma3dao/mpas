/** Interactive reporting and confirmation for plugin trust information. */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { PluginTrustReport } from "./trust.js";
import type { DeploymentConfig } from "./config-loader.js";

export type PluginTrustAssessment =
  | { status: "checked"; report: PluginTrustReport }
  | { status: "notChecked"; reason: "notConfigured" | "unavailable"; detail?: string };

export type ConfirmPluginUse = (
  assessment: PluginTrustAssessment,
  config: DeploymentConfig,
) => Promise<boolean>;

export const NO_TRUST_CONTEXT_WARNING =
  "No OMATrust context was provided.";
export const NO_TRUST_CHECKS_WARNING =
  "No OMATrust attestations, approved-issuer checks, target linkage, or other legitimacy and provenance checks were performed.";

/**
 * Reports all available trust information and asks the operator to make the
 * final decision. The content hash has already been verified by the loader.
 */
export const promptPluginUse: ConfirmPluginUse = async (assessment, config) => {
  stdout.write(`\nPlugin: ${config.name}\n`);
  stdout.write(`  Artifact: ${config.plugin.artifactDid}\n`);
  stdout.write("  Content integrity: verified (plugin content matches the configured did:artifact)\n");

  if (assessment.status === "notChecked") {
    if (assessment.reason === "notConfigured") {
      stdout.write(`\n  WARNING: ${NO_TRUST_CONTEXT_WARNING}\n`);
    } else {
      stdout.write("\n  WARNING: OMATrust context could not be loaded.\n");
      if (assessment.detail) stdout.write(`  ${assessment.detail}\n`);
    }
    stdout.write(`  ${NO_TRUST_CHECKS_WARNING}\n`);
  } else {
    const { report } = assessment;
    stdout.write("\n  OMATrust information:\n");
    stdout.write(`  Overall evidence: ${report.verdict.trusted ? "trusted evidence found" : "no trusted evidence found"}\n`);
    stdout.write(`  Attestation check: ${report.attestation.passed ? "PASS" : "NOT VERIFIED"} — ${report.attestation.message}\n`);

    for (const attestation of report.attestation.attestations) {
      const issuer = attestation.attesterLabel ?? attestation.attester;
      const schema = attestation.schemaLabel ?? attestation.schemaUid;
      const status = attestation.revoked
        ? "revoked"
        : attestation.expirationTime > 0n && attestation.expirationTime <= BigInt(Math.floor(Date.now() / 1000))
          ? "expired"
          : "active";
      stdout.write(
        `    - ${schema}; issuer ${issuer}; ${attestation.isApprovedIssuer ? "approved issuer" : "unapproved issuer"}; ${status}\n`,
      );
    }

    stdout.write(`  Target linkage: ${report.linkage.passed ? "PASS" : "NOT VERIFIED"} — ${report.linkage.message}\n`);
    const linkageEvidence = [
      report.linkage.linkedIdentifier && "linked identifier",
      report.linkage.controllerWitness && "controller witness",
      report.linkage.dnsTxt && "DNS TXT",
      report.linkage.wellKnownDid && "well-known DID",
    ].filter(Boolean);
    if (linkageEvidence.length > 0) {
      stdout.write(`    Evidence: ${linkageEvidence.join(", ")}\n`);
    }
  }

  stdout.write("\n");

  if (!stdin.isTTY) {
    stdout.write("  Non-interactive input: declining plugin use by default.\n");
    return false;
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question("  [y/N] Would you like to use this plugin given the information shown? ");
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
};
