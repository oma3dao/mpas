import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { JWK } from "jose";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    verify: () => {
      throw new Error("ed25519 verify threw");
    },
  };
});

const { KeyManager } = await import("../../src/lib/key-manager.js");

interface KeyFixture {
  publicJwk: JWK;
}

describe("KeyManager.verifyBytes error path", () => {
  it("returns false when node crypto verify throws", async () => {
    const fixture = JSON.parse(
      await readFile(join(fileURLToPath(new URL("../fixtures/keys", import.meta.url)), "proposer.json"), "utf8"),
    ) as KeyFixture;
    const keyManager = KeyManager.fromJwk(fixture.publicJwk);
    await expect(keyManager.verifyBytes(Buffer.from("payload"), Buffer.alloc(64))).resolves.toBe(false);
  });
});
