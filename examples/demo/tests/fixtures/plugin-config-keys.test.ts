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
  };
  credentialRequirements?: unknown[];
  operations: Array<{
    name: string;
    executionPayloadSchema: Record<string, unknown>;
  }>;
  policySuggestions?: unknown[];
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
  enabledOperations: string[];
  trustedSigners: Array<{
    did: string;
    role: string;
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
      required: ["id"],
      properties: {
        id: { type: "string", pattern: "^did:[a-z0-9]+:.+" },
        format: { type: "string", minLength: 1 },
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
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["name", "executionPayloadSchema"],
        properties: {
          name: { type: "string", minLength: 1 },
          description: { type: "string" },
          executionPayloadSchema: { type: "object" },
        },
        additionalProperties: false,
      },
    },
    policySuggestions: {
      type: "array",
      items: {
        type: "object",
        required: ["match"],
        properties: {
          description: { type: "string" },
          impact: { type: "string" },
          match: { type: "object" },
          suggestedRequirement: {
            type: "object",
            required: ["kind"],
            properties: {
              kind: { type: "string" },
              eligibleSignerRole: { type: "string" },
              minimumThreshold: { type: "integer", minimum: 1 },
              decision: { type: "string" },
            },
            additionalProperties: false,
          },
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
    const plugin = await readJson<MpasApplicationPlugin>(join(fixturesDir, "plugins", "github-repo.json"));
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(applicationPluginSchema);

    expect(validate(plugin), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(Array.isArray(plugin.operations)).toBe(true);
    expect(plugin.operations.map((operation) => operation.name)).toEqual([
      "create_issue",
      "merge_pull_request",
      "delete_branch",
    ]);
    expect(JSON.stringify(plugin)).not.toContain("nativeBinding");
    expect(plugin.credentialRequirements).toBeDefined();
  });

  it("valid Action Package payloads validate against plugin operation schemas", async () => {
    const plugin = await readJson<MpasApplicationPlugin>(join(fixturesDir, "plugins", "github-repo.json"));
    const operationSchemas = new Map(
      plugin.operations.map((operation) => [operation.name, operation.executionPayloadSchema]),
    );
    const ajv = new Ajv2020({ strict: false });

    for (const file of [
      "valid-no-approval-required.json",
      "valid-two-approvals.json",
      "valid-delete-branch.json",
    ]) {
      const actionPackage = await readJson<ActionPackage>(join(fixturesDir, "core", file));
      const payload = actionPackage.executionPayload as { name: string };
      const schema = operationSchemas.get(payload.name);

      expect(schema, `missing schema for ${payload.name}`).toBeDefined();
      expect(ajv.validate(schema!, actionPackage.executionPayload), JSON.stringify(ajv.errors, null, 2)).toBe(true);
    }
  });

  it("deployment configs reference the plugin and artifact DID correctly", async () => {
    const plugin = await readJson<MpasApplicationPlugin>(join(fixturesDir, "plugins", "github-repo.json"));
    const expectedArtifactDid = await computeArtifactDid(plugin);

    for (const file of ["github-auto-approve.json", "github-strict.json"]) {
      const config = await readJson<DeploymentConfig>(join(fixturesDir, "configs", file));

      expect(config.target.applicationDid).toBe(plugin.applicationDid);
      expect(config.plugin.pluginDid).toBe(plugin.pluginDid);
      expect(config.plugin.pluginVersion).toBe(plugin.pluginVersion);
      expect(config.plugin.artifactDid).toBe(expectedArtifactDid);
      expect(config.plugin.path).toBe("../plugins/github-repo.json");
      expect(config.enabledOperations.every((name) => plugin.operations.some((op) => op.name === name))).toBe(true);
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
