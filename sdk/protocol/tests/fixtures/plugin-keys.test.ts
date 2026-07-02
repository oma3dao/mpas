import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { CompactSign, compactVerify, importJWK, type JWK } from "jose";
import { canonicalize } from "json-canonicalize";
import { describe, expect, it } from "vitest";
import type { MpasApplicationPlugin } from "../../src/index.js";

const fixturesDir = fileURLToPath(new URL(".", import.meta.url));

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
    policySuggestions: {
      type: "array",
      items: {
        type: "object",
        required: ["match"],
        properties: {
          description: { type: "string" },
          impact: { type: "string" },
          match: { type: "object" },
          suggestedRequirement: { type: "object" },
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

describe("fixture keys and plugin", () => {
  it("fixture keys can produce verifiable Ed25519 JWS signatures", async () => {
    for (const file of ["proposer.json", "maintainer-a.json", "maintainer-b.json", "adapter.json"]) {
      const key = await readJson<KeyFixture>(join(fixturesDir, "keys", file));
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

  it("validates the GitHub plugin against Application Plugin Profile v0.2", async () => {
    const plugin = await readJson<MpasApplicationPlugin>(join(fixturesDir, "plugins", "github-repo.json"));
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(applicationPluginSchema);

    expect(validate(plugin), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(Object.keys(plugin.operations)).toEqual([
      "create_issue",
      "merge_pull_request",
      "delete_branch",
    ]);
    expect(plugin.credentialRequirements).toBeDefined();
    expect(JSON.stringify(plugin)).not.toContain("nativeBinding");
  });
});
