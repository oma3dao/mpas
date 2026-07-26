import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { CompactSign, compactVerify, importJWK, type JWK } from "jose";
import { canonicalize } from "json-canonicalize";
import { describe, expect, it } from "vitest";
import { computeArtifactDid } from "../../src/adapter/config-loader.js";
import type { ActionPackage } from "../../src/core/types.js";

const fixturesDir = fileURLToPath(new URL(".", import.meta.url));

interface MpasApplicationPlugin {
  version: "1";
  type: "MpasApplicationPlugin";
  pluginDid: string;
  pluginVersion: string;
  publisherDid: string;
  applicationDid: string;
  executionProfile: {
    id: string;
    format?: string;
    protocolVersion: string;
  };
  credentialRequirements?: unknown[];
  operations: Record<string, {
    description?: string;
    impact?: string;
    executionPayloadSchema: Record<string, unknown>;
  }>;
}

interface DeploymentConfig {
  name: string;
  target: {
    applicationDid: string;
  };
  plugin: {
    pluginDid: string;
    pluginVersion: string;
    artifactDid: string;
    path: string;
  };
  policy: {
    signerGroups: Record<string, string[]>;
    policies?: Record<string, unknown[]>;
    defaultRequirement: unknown;
  };
  signerKeys: Array<{
    did: string;
    label?: string;
    publicJwk: JWK;
  }>;
}

interface KeyFixture {
  label: string;
  did: string;
  kid: string;
  privateJwk: JWK;
  publicJwk: JWK;
}

const applicationPluginSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: [
    "version",
    "type",
    "pluginDid",
    "pluginVersion",
    "publisherDid",
    "applicationDid",
    "executionProfile",
    "operations",
  ],
  properties: {
    version: { const: "1" },
    type: { const: "MpasApplicationPlugin" },
    pluginDid: { type: "string", pattern: "^did:[a-z0-9]+:.+" },
    pluginVersion: { type: "string", minLength: 1 },
    publisherDid: { type: "string", pattern: "^did:[a-z0-9]+:.+" },
    applicationDid: { type: "string", pattern: "^did:[a-z0-9]+:.+" },
    executionProfile: {
      type: "object",
      required: ["id", "protocolVersion"],
      properties: {
        id: { type: "string", pattern: "^did:[a-z0-9]+:.+" },
        format: { type: "string", minLength: 1 },
        protocolVersion: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
    credentialRequirements: {
      type: "array",
      items: {
        type: "object",
        required: ["type"],
        properties: {
          type: { type: "string" },
          requiredCapabilities: { type: "array", items: { type: "string" } },
          description: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    operations: {
      type: "object",
      minProperties: 1,
      additionalProperties: {
        type: "object",
        required: ["executionPayloadSchema"],
        properties: {
          description: { type: "string" },
          impact: { type: "string" },
          executionPayloadSchema: { type: "object" },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("plugin, config, and key fixtures", () => {
  it("validates the GitHub plugin against MPAS Application Plugin Profile v0.2", async () => {
    const plugin = await readJson<MpasApplicationPlugin>(join(fixturesDir, "plugins", "github-demo-plugin.json"));
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(applicationPluginSchema);

    expect(validate(plugin), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(typeof plugin.operations).toBe("object");
    expect(Object.keys(plugin.operations)).toEqual([
      "delete_branch",
      "merge_pull_request",
    ]);
    expect(JSON.stringify(plugin)).not.toContain("nativeBinding");
    expect(JSON.stringify(plugin)).not.toContain("policySuggestions");
    expect(plugin.credentialRequirements).toBeDefined();
  });

  it("valid Action Package payloads validate against plugin operation schemas", async () => {
    const plugin = await readJson<MpasApplicationPlugin>(join(fixturesDir, "plugins", "github-demo-plugin.json"));
    const ajv = new Ajv2020({ strict: false });

    for (const file of [
      "valid-two-approvals.json",
      "valid-delete-branch.json",
    ]) {
      const actionPackage = await readJson<ActionPackage>(join(fixturesDir, "core", file));
      const payload = actionPackage.executionPayload as { name: string };
      const operation = plugin.operations[payload.name];

      expect(operation, `missing operation for ${payload.name}`).toBeDefined();
      expect(ajv.validate(operation.executionPayloadSchema, actionPackage.executionPayload), JSON.stringify(ajv.errors, null, 2)).toBe(true);
    }
  });

  it("deployment configs reference the plugin and artifact DID correctly", async () => {
    const plugin = await readJson<MpasApplicationPlugin>(join(fixturesDir, "plugins", "github-demo-plugin.json"));
    const expectedArtifactDid = await computeArtifactDid(plugin);

    for (const file of ["github-auto-approve.json", "github-strict.json"]) {
      const config = await readJson<DeploymentConfig>(join(fixturesDir, "configs", file));

      expect(config.target.applicationDid).toBe(plugin.applicationDid);
      expect(config.plugin.pluginDid).toBe(plugin.pluginDid);
      expect(config.plugin.pluginVersion).toBe(plugin.pluginVersion);
      expect(config.plugin.artifactDid).toBe(expectedArtifactDid);
      expect(config.plugin.path).toBe("../plugins/github-demo-plugin.json");
    }
  });

  it("deployment configs have signerKeys with DID and publicJwk (no roles)", async () => {
    for (const file of ["github-auto-approve.json", "github-strict.json"]) {
      const config = await readJson<DeploymentConfig>(join(fixturesDir, "configs", file));

      expect(config.signerKeys).toBeDefined();
      expect(config.signerKeys.length).toBeGreaterThan(0);
      for (const key of config.signerKeys) {
        expect(key.did).toMatch(/^did:/);
        expect(key.publicJwk).toBeDefined();
        expect((key as Record<string, unknown>).roles).toBeUndefined();
      }
    }
  });

  it("deployment configs embed a full MpasApplicationPolicy in the policy field", async () => {
    for (const file of ["github-auto-approve.json", "github-strict.json"]) {
      const config = await readJson<DeploymentConfig>(join(fixturesDir, "configs", file));

      expect(config.policy.signerGroups).toBeDefined();
      expect(config.policy.signerGroups.all).toBeDefined();
      expect(config.policy.defaultRequirement).toBeDefined();
      // No legacy rules array
      expect((config.policy as Record<string, unknown>).rules).toBeUndefined();
      expect((config.policy as Record<string, unknown>).defaultPolicy).toBeUndefined();
    }
  });

  it("fixture keys can sign and verify Ed25519 JWS payloads", async () => {
    for (const file of ["proposer.json", "maintainer-a.json", "maintainer-b.json", "adapter.json"]) {
      const key = await readJson<KeyFixture>(join(fixturesDir, "test-keys", file));
      const payload = Buffer.from(canonicalize({ type: "FixtureKeyCheck", did: key.did }));
      const privateKey = await importJWK(key.privateJwk, "EdDSA");
      const publicKey = await importJWK(key.publicJwk, "EdDSA");
      const jws = await new CompactSign(payload).setProtectedHeader({ alg: "EdDSA", kid: key.kid }).sign(privateKey);

      await expect(compactVerify(jws, publicKey)).resolves.toMatchObject({
        protectedHeader: {
          alg: "EdDSA",
          kid: key.kid,
        },
      });
    }
  });
});
