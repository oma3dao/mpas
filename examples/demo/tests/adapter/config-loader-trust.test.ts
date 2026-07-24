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
import { loadOmaTrustConfig } from "../../src/adapter/daemon.js";
import { buildTrustReport, type TrustContext } from "../../src/adapter/trust.js";
import {
  NO_TRUST_CHECKS_WARNING,
  NO_TRUST_CONTEXT_WARNING,
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
    await readFile(join(fixturesDir, "plugins", "github-demo-plugin.json"), "utf8"),
  ) as unknown;
  const config = JSON.parse(
    await readFile(join(fixturesDir, "configs", "github-auto-approve.json"), "utf8"),
  ) as Record<string, unknown>;
  (config.plugin as Record<string, unknown>).path = "../plugins/github-demo-plugin.json";

  await writeFile(join(pluginDir, "github-demo-plugin.json"), `${JSON.stringify(plugin, null, 2)}\n`);
  await writeFile(join(configDir, "github.json"), `${JSON.stringify(config, null, 2)}\n`);
  return configDir;
}

const trustContext: TrustContext = {
  backendUrl: "https://api.omatrust.example",
  approvedIssuers: [],
  schemas: {
    securityAssessment: "0xsecurity",
    certification: "0xcertification",
    userReview: "0xreview",
    linkedIdentifier: "0xlinked",
    controllerWitness: "0xcontroller",
  },
  rpcUrl: "https://rpc.example",
  easContractAddress: "0xEAS",
};

describe("plugin trust confirmation during config loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports missing trust context and rejects the plugin when confirmation is declined", async () => {
    const configDir = await makeConfigDir();
    let observed: PluginTrustAssessment | undefined;

    const result = await loadDeploymentConfigs(configDir, {
      confirmPluginUse: async (assessment) => {
        observed = assessment;
        return false;
      },
    });

    expect(observed).toEqual({ status: "notChecked", reason: "notConfigured" });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "PLUGIN_TRUST_REJECTED" },
    });
    expect(NO_TRUST_CONTEXT_WARNING).toContain("No OMATrust context");
    expect(NO_TRUST_CHECKS_WARNING).toContain("legitimacy and provenance checks were performed");
  });

  it("reports unavailable trust context separately from missing configuration", async () => {
    const configDir = await makeConfigDir();
    let observed: PluginTrustAssessment | undefined;

    await loadDeploymentConfigs(configDir, {
      trustContextError: "trust anchors endpoint unavailable",
      confirmPluginUse: async (assessment) => {
        observed = assessment;
        return true;
      },
    });

    expect(observed).toEqual({
      status: "notChecked",
      reason: "unavailable",
      detail: "trust anchors endpoint unavailable",
    });
  });

  it("provides the complete OMATrust report and asks even when trusted evidence exists", async () => {
    const configDir = await makeConfigDir();
    const report = {
      artifactDid: "did:artifact:bafktest",
      pluginDid: "did:web:plugins.example.com:github-demo-plugin",
      pluginVersion: "1.0.0",
      targetUrl: "github.example",
      verdict: {
        trusted: true,
        reasons: [
          { check: "attestation", passed: true, message: "Attested by an approved issuer." },
          { check: "linkage", passed: false, message: "No target linkage found." },
        ],
      },
      attestation: {
        passed: true,
        message: "Attested by an approved issuer.",
        attestations: [],
      },
      linkage: {
        passed: false,
        message: "No target linkage found.",
        linkedIdentifier: false,
        controllerWitness: false,
        dnsTxt: false,
        wellKnownDid: false,
      },
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
  });
});

describe("OMATrust daemon configuration", () => {
  it("loads a valid OMATrust configuration file", async () => {
    const root = await mkdtemp(join(tmpdir(), "mpas-omatrust-config-"));
    const path = join(root, "omatrust.json");
    await writeFile(path, `${JSON.stringify({
      rpcUrl: "https://rpc.example",
      easContractAddress: "0xEAS",
      backendUrl: "https://api.omatrust.example",
      schemas: trustContext.schemas,
    })}\n`);

    await expect(loadOmaTrustConfig(path)).resolves.toMatchObject({
      backendUrl: "https://api.omatrust.example",
      schemas: { linkedIdentifier: "0xlinked" },
    });
  });

  it("rejects an incomplete OMATrust configuration file", async () => {
    const root = await mkdtemp(join(tmpdir(), "mpas-omatrust-config-"));
    const path = join(root, "omatrust.json");
    await writeFile(path, '{"backendUrl":"https://api.omatrust.example"}\n');

    await expect(loadOmaTrustConfig(path)).rejects.toThrow("OMATrust configuration is invalid");
  });
});
