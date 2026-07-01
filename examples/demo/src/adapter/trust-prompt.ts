/**
 * Interactive operator prompt for untrusted plugins.
 *
 * When canTrust returns trusted: false, this module prompts the operator
 * to confirm or reject loading the plugin.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { TrustVerdict } from "./trust.js";
import type { DeploymentConfig } from "./config-loader.js";

/**
 * Displays trust verdict details and prompts the operator for confirmation.
 * Returns true if the operator confirms, false if they decline.
 */
export async function promptOperator(
  verdict: TrustVerdict,
  config: DeploymentConfig,
): Promise<boolean> {
  const pluginName = config.name;
  const artifactDid = config.plugin.artifactDid;
  const shortDid = artifactDid.length > 30 ? `${artifactDid.slice(0, 30)}...` : artifactDid;

  stdout.write(`\nPlugin: ${pluginName} (${shortDid})\n`);
  stdout.write(`  ⚠️  Plugin has a low trust score. Do you want to continue?\n\n`);
  stdout.write(`  Reasons:\n`);

  for (const reason of verdict.reasons) {
    if (!reason.passed) {
      stdout.write(`  • ${reason.message}\n`);
    }
  }

  stdout.write(`\n`);

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question("  [y/N] Continue loading this plugin? ");
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

/**
 * Displays trust verified status for a trusted plugin (no prompt needed).
 */
export function displayTrusted(config: DeploymentConfig, verdict: TrustVerdict): void {
  const pluginName = config.name;
  const artifactDid = config.plugin.artifactDid;
  const shortDid = artifactDid.length > 30 ? `${artifactDid.slice(0, 30)}...` : artifactDid;

  stdout.write(`Plugin: ${pluginName} (${shortDid})\n`);
  stdout.write(`  ✓ Trust verified\n`);

  for (const reason of verdict.reasons) {
    if (reason.passed) {
      stdout.write(`    ${reason.message}\n`);
    }
  }

  stdout.write(`  Loading plugin...\n`);
}

/**
 * Displays network-unreachable degraded mode prompt.
 * Returns true if operator confirms, false if they decline.
 */
export async function promptNetworkUnavailable(config: DeploymentConfig): Promise<boolean> {
  const pluginName = config.name;
  const artifactDid = config.plugin.artifactDid;
  const shortDid = artifactDid.length > 30 ? `${artifactDid.slice(0, 30)}...` : artifactDid;

  stdout.write(`\nPlugin: ${pluginName} (${shortDid})\n`);
  stdout.write(`  ⚠️  OMATrust check skipped: network unavailable\n`);
  stdout.write(`  Cannot verify trust posture. Do you want to continue?\n\n`);

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question("  [y/N] Continue loading this plugin? ");
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}
