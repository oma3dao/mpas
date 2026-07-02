import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeHash, verifyHash, type ActionPackage } from "../../src/index.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("hash utilities", () => {
  it("computes fixture Execution Payload hashes deterministically", async () => {
    for (const file of [
      "valid-create-issue-package.json",
      "valid-merge-pr-package.json",
      "valid-delete-branch-package.json",
    ]) {
      const actionPackage = await readJson<ActionPackage>(join(fixturesDir, "action-packages", file));

      expect(computeHash(actionPackage.executionPayload)).toEqual(actionPackage.actionEnvelope.executionPayloadHash);
      expect(verifyHash(actionPackage.executionPayload, actionPackage.actionEnvelope.executionPayloadHash)).toBe(true);
    }
  });

  it("returns false for mismatched or unsupported hash bindings", () => {
    const payload = { name: "create_issue", arguments: { title: "Hello" } };

    expect(verifyHash(payload, { alg: "sha-256", value: "wrong" })).toBe(false);
    expect(verifyHash(payload, { alg: "sha-384", value: computeHash(payload).value })).toBe(false);
  });
});
