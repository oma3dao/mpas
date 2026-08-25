import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/adapter/trust.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/adapter/trust.js")>();
  return {
    ...actual,
    buildTrustReport: vi.fn(),
  };
});

import { loadDeploymentConfigs } from "../../src/adapter/config-loader.js";
import { buildTrustReport, type TrustContext } from "../../src/adapter/trust.js";
import {
  INDEPENDENT_VERIFY_NOTICE,
  NO_PRIMARY_TRUST_EVIDENCE_WARNING,
  NO_TRUST_CHECKS_WARNING,
  RESPONSIBILITY_CLAIM_TRUST_NOTICE,
  type PluginTrustAssessment,
} from "../../src/adapter/trust-prompt.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
const mockBuildTrustReport = vi.mocked(buildTrustReport);

async function makeConfigDir() {
  const root = await mkdtemp(join(tmpdir(), "mpas-config-trust-"));
  const configDir = join(root, "configs");
  const pluginDir = join(root, "plugins");
  await mkdir(configDir, { recursive: true });
  await mkdir(pluginDir, { recursive: true });

  const plugin = JSON.parse(
    await readFile(join(fixturesDir, "plugins", "github-mirror-plugin.json"), "utf8"),
  ) as unknown;
  const config = JSON.parse(
    await readFile(join(fixturesDir, "configs", "policy-fixtures", "github-auto-approve.json"), "utf8"),
  ) as Record<string, unknown>;
  (config.plugin as Record<string, unknown>).path = "../plugins/github-mirror-plugin.json";

  await writeFile(join(pluginDir, "github-mirror-plugin.json"), `${JSON.stringify(plugin, null, 2)}\n`);
  await writeFile(join(configDir, "github.json"), `${JSON.stringify(config, null, 2)}\n`);
  return configDir;
}

const trustContext: TrustContext = {
  artifactTrustApiUrl: "https://api.omatrust.example/artifact-trust",
  expectedChain: {
    chainId: 6623,
    easContract: "0x00Bd6f0Ee99bD76273B57e6dDEc5B00850c6b76C",
  },
};

describe("plugin trust confirmation during config loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports a deliberately skipped lookup as unavailable", async () => {
    const configDir = await makeConfigDir();
    let observed: PluginTrustAssessment | undefined;

    const result = await loadDeploymentConfigs(configDir, {
      confirmPluginUse: async (assessment) => {
        observed = assessment;
        return false;
      },
    });

    expect(observed).toEqual({
      status: "notChecked",
      reason: "unavailable",
      detail: "Artifact trust lookup was not requested by this caller.",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "PLUGIN_TRUST_REJECTED" },
    });
    expect(NO_TRUST_CHECKS_WARNING).toContain(
      "legitimacy and provenance evidence was loaded",
    );
    expect(INDEPENDENT_VERIFY_NOTICE).toContain("https://app.omatrust.org/verify");
  });

  it("asks without warning when a cybersecurity assessment exists without a responsibility claim", async () => {
    const configDir = await makeConfigDir();
    const report = {
      artifactDid: "did:artifact:bafktest",
      publisherDid: "did:web:publisher.example",
      pluginDid: "did:web:plugins.oma3.org:github-mirror-plugin",
      pluginVersion: "0.1.0",
      targetApplicationDid: "did:web:github-mirror.example",
      verdict: {
        primaryEvidenceFound: true,
        warningRequired: false,
        reasons: [
          { check: "responsibility-claim", passed: false, message: "No verified responsibility claim was found." },
          { check: "cybersecurity-assessment", passed: true, message: "Cybersecurity assessed by an approved issuer." },
        ],
      },
      attestation: {
        primaryEvidenceFound: true,
        message: "Cybersecurity assessed by an approved issuer.",
        responsibilityClaim: false,
        cybersecurityAssessment: true,
        responsibilityClaims: [],
        unqualifiedResponsibilityClaims: [],
        attestations: [],
      },
      linkedIdentifiers: [],
    };
    mockBuildTrustReport.mockResolvedValue(report);
    let observed: PluginTrustAssessment | undefined;

    const result = await loadDeploymentConfigs(configDir, {
      trustContext,
      confirmPluginUse: async (assessment) => {
        observed = assessment;
        return true;
      },
    });

    expect(result.ok).toBe(true);
    expect(mockBuildTrustReport).toHaveBeenCalledOnce();
    expect(observed).toEqual({ status: "checked", report });
    expect(
      observed?.status === "checked" &&
      observed.report.verdict.warningRequired,
    ).toBe(false);
  });

  it("warns and asks when only secondary or informational evidence exists", async () => {
    const configDir = await makeConfigDir();
    const report = {
      artifactDid: "did:artifact:bafktest",
      publisherDid: "did:web:publisher.example",
      pluginDid: "did:web:plugins.oma3.org:github-mirror-plugin",
      pluginVersion: "0.1.0",
      targetApplicationDid: "did:web:github-mirror.example",
      verdict: {
        primaryEvidenceFound: false,
        warningRequired: true,
        reasons: [
          { check: "responsibility-claim", passed: false, message: "No verified responsibility claim was found." },
          { check: "cybersecurity-assessment", passed: false, message: "No verified cybersecurity assessment was found." },
        ],
      },
      attestation: {
        primaryEvidenceFound: false,
        message: "Only secondary or informational evidence exists.",
        responsibilityClaim: false,
        cybersecurityAssessment: false,
        responsibilityClaims: [],
        unqualifiedResponsibilityClaims: [],
        attestations: [{
          uid: `0x${"1".repeat(64)}`,
          attester: "0x3333333333333333333333333333333333333333",
          isApprovedIssuer: true,
          schemaUid: `0x${"2".repeat(64)}`,
          schemaLabel: "certification",
          time: "1700000000",
          expirationTime: "0",
          verificationBasis: ["approved-issuer"],
          data: { subject: "did:artifact:bafktest" },
        }],
      },
      linkedIdentifiers: [{
        uid: `0x${"3".repeat(64)}`,
        linkedId: "did:web:publisher.example",
        attester: "0x3333333333333333333333333333333333333333",
        verificationBasis: ["proof"],
      }],
    };
    mockBuildTrustReport.mockResolvedValue(report);
    let observed: PluginTrustAssessment | undefined;

    const result = await loadDeploymentConfigs(configDir, {
      trustContext,
      confirmPluginUse: async (assessment) => {
        observed = assessment;
        return false;
      },
    });

    expect(observed).toEqual({ status: "checked", report });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "PLUGIN_TRUST_REJECTED" },
    });
    expect(NO_PRIMARY_TRUST_EVIDENCE_WARNING).toContain(
      "responsibility claim or cybersecurity assessment",
    );
    expect(RESPONSIBILITY_CLAIM_TRUST_NOTICE).toContain(
      "does not establish that the responsible party is legitimate",
    );
  });

  it("reports an artifact trust API failure as unavailable, not as empty evidence", async () => {
    const configDir = await makeConfigDir();
    mockBuildTrustReport.mockRejectedValue(
      new Error("Artifact trust API returned 502"),
    );
    let observed: PluginTrustAssessment | undefined;

    const result = await loadDeploymentConfigs(configDir, {
      trustContext,
      confirmPluginUse: async (assessment) => {
        observed = assessment;
        return true;
      },
    });

    expect(result.ok).toBe(true);
    expect(observed).toEqual({
      status: "notChecked",
      reason: "unavailable",
      detail: "Artifact trust API returned 502",
    });
  });

  it("rejects an artifact hash mismatch before starting a trust lookup", async () => {
    const configDir = await makeConfigDir();
    const path = join(configDir, "github.json");
    const config = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    (config.plugin as Record<string, unknown>).artifactDid =
      "did:artifact:bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);

    const result = await loadDeploymentConfigs(configDir, {
      trustContext,
      confirmPluginUse: async () => true,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "PLUGIN_HASH_MISMATCH" },
    });
    expect(mockBuildTrustReport).not.toHaveBeenCalled();
  });
});
