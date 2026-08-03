/** Interactive reporting and confirmation for plugin trust information. */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginTrustReport } from "./trust.js";
import type { DeploymentConfig } from "./config-loader.js";

export type PluginTrustAssessment =
  | { status: "checked"; report: PluginTrustReport }
  | { status: "notChecked"; reason: "unavailable"; detail?: string };

export type ConfirmPluginUse = (
  assessment: PluginTrustAssessment,
  config: DeploymentConfig,
) => Promise<boolean>;

export const NO_TRUST_CHECKS_WARNING =
  "No OMATrust responsibility claims, attestations, linked identifiers, or other legitimacy and provenance evidence was loaded.";
export const NO_PRIMARY_TRUST_EVIDENCE_WARNING =
  "No verified responsibility claim or cybersecurity assessment was found.";
export const RESPONSIBILITY_CLAIM_TRUST_NOTICE =
  "Technical verification confirms the claim, but does not establish that the responsible party is legitimate. Decide whether you trust that party.";
export const UNQUALIFIED_CLAIMS_NOTICE =
  "Anyone can attest a responsibility claim against any artifact, so claims from other parties are not counted as evidence.";

/**
 * Writes the non-qualifying claims out rather than listing them at the prompt.
 * An operator cannot adjudicate a list of unfamiliar DIDs on a startup screen,
 * and printing them competes with the one claim that does count. Returns the
 * path, or undefined if it could not be written — a diagnostics file must
 * never block startup.
 */
export function writeUnqualifiedClaims(
  report: PluginTrustReport,
): string | undefined {
  const claims = report.attestation.unqualifiedResponsibilityClaims;
  if (claims.length === 0) return undefined;
  try {
    const dir = mkdtempSync(join(tmpdir(), "mpas-trust-"));
    const path = join(dir, "unqualified-responsibility-claims.json");
    writeFileSync(
      path,
      JSON.stringify(
        {
          artifactDid: report.artifactDid,
          declaredPublisherDid: report.publisherDid,
          note: UNQUALIFIED_CLAIMS_NOTICE,
          claims,
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
    return path;
  } catch {
    return undefined;
  }
}
export const INDEPENDENT_VERIFY_NOTICE =
  "You can independently verify this artifact at https://app.omatrust.org/verify using the did:artifact shown above.";

/**
 * Reports all available trust information and asks the operator to make the
 * final decision. The content hash has already been verified by the loader.
 */
export const promptPluginUse: ConfirmPluginUse = async (assessment, config) => {
  stdout.write(`\nPlugin: ${config.name}\n`);
  stdout.write(`  Artifact: ${config.plugin.artifactDid}\n`);
  stdout.write("  Content integrity: verified (plugin content matches the configured did:artifact)\n");

  if (assessment.status === "notChecked") {
    stdout.write("\n  WARNING: OMATrust information could not be loaded.\n");
    if (assessment.detail) stdout.write(`  ${assessment.detail}\n`);
    stdout.write(`  ${NO_TRUST_CHECKS_WARNING}\n`);
  } else {
    const { report } = assessment;
    stdout.write("\n  OMATrust information:\n");
    if (report.verdict.warningRequired) {
      stdout.write(`  WARNING: ${NO_PRIMARY_TRUST_EVIDENCE_WARNING}\n`);
    }
    stdout.write(`  Declared publisher: ${report.publisherDid}\n`);
    stdout.write(
      `  Responsibility claim from that publisher: ${report.attestation.responsibilityClaim ? "FOUND" : "NOT FOUND"}\n`,
    );

    for (const claim of report.attestation.responsibilityClaims) {
      const responsibleParty = typeof claim.data.responsibleParty === "string"
        ? claim.data.responsibleParty
        : claim.attesterLabel ?? claim.attester;
      const responsibilityTypes = Array.isArray(claim.data.responsibilityType)
        ? claim.data.responsibilityType.filter(
          (value): value is string => typeof value === "string",
        )
        : [];
      const typeLabel = responsibilityTypes.length > 0
        ? `; responsibility ${responsibilityTypes.join(", ")}`
        : "";
      stdout.write(
        `    - ${responsibleParty}${typeLabel}; verified via ${claim.verificationBasis.join(", ")}\n`,
      );
      stdout.write(
        `      ${RESPONSIBILITY_CLAIM_TRUST_NOTICE}\n`,
      );
    }

    const unqualifiedCount =
      report.attestation.unqualifiedResponsibilityClaims.length;
    if (unqualifiedCount > 0) {
      const path = writeUnqualifiedClaims(report);
      stdout.write(
        `  Claims naming a different responsible party: ${unqualifiedCount} (not counted as evidence)\n`,
      );
      stdout.write(
        path
          ? `    Details written to ${path}\n`
          : "    Details could not be written to disk.\n",
      );
    }

    stdout.write(
      `  Cybersecurity assessment: ${report.attestation.cybersecurityAssessment ? "FOUND" : "NOT FOUND"}\n`,
    );

    for (const attestation of report.attestation.attestations) {
      const issuer = attestation.attesterLabel ?? attestation.attester;
      const schema = attestation.schemaLabel ?? attestation.schemaUid;
      const basis = attestation.verificationBasis.length > 0
        ? attestation.verificationBasis.join(", ")
        : "endpoint verification";
      stdout.write(
        `    - ${schema}; issuer ${issuer}; verified via ${basis}\n`,
      );
    }

    stdout.write(`  Linked identifiers (${report.linkedIdentifiers.length}):\n`);
    if (report.linkedIdentifiers.length === 0) {
      stdout.write("    - None found.\n");
    }
    for (const linked of report.linkedIdentifiers) {
      const issuer = linked.attesterLabel ?? linked.attester;
      stdout.write(
        `    - ${linked.linkedId}; issuer ${issuer}; verified via ${linked.verificationBasis.join(", ")}\n`,
      );
    }
  }

  stdout.write(`  ${INDEPENDENT_VERIFY_NOTICE}\n`);
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
