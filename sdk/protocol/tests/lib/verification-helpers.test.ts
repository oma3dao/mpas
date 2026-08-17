import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  exceedsMaxEnvelopeValidity,
  DEFAULT_MAX_ENVELOPE_VALIDITY_MS,
  isEnvelopeExpired,
  parseActionPackage,
  resolveTrustedSignerJwk,
  validateActionEnvelope,
  verifyPayloadBinding,
  type TrustedSigner,
} from "../../src/lib/verification.js";
import type { ActionEnvelope, ActionPackage, Did } from "../../src/types/mpas.js";

const fixturesDir = fileURLToPath(new URL("../../../../examples/demo/tests/fixtures/", import.meta.url));

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readActionPackage(file: string): Promise<ActionPackage> {
  return readJson<ActionPackage>(join(fixturesDir, "core", file));
}

describe("parseActionPackage (sdk)", () => {
  it.each([
    "valid-no-approval-required.json",
    "valid-two-approvals.json",
    "valid-delete-branch.json",
    "invalid-payload-hash-mismatch.json",
    "invalid-expired-envelope.json",
  ])("parses structurally complete fixture %s", async (fixtureFile) => {
    const result = parseActionPackage(await readJson(join(fixturesDir, "core", fixtureFile)));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actionPackage.executionPayload).toBeDefined();
      expect(result.actionPackage.actionEnvelope).toBeDefined();
      expect(result.actionPackage.approvalBundle).toBeDefined();
    }
  });

  it("returns a structured error for malformed-missing-envelope.json", async () => {
    const result = parseActionPackage(await readJson(join(fixturesDir, "core", "malformed-missing-envelope.json")));

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_ACTION_PACKAGE",
        path: "$.actionEnvelope",
      },
    });
  });

  it("rejects non-object values as malformed", () => {
    const result = parseActionPackage(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.path).toBe("$");
    }
  });

  it("rejects packages missing required top-level fields", () => {
    expect(parseActionPackage({})).toMatchObject({
      ok: false,
      error: { path: "$.executionPayload" },
    });
    expect(parseActionPackage({ executionPayload: {} })).toMatchObject({
      ok: false,
      error: { path: "$.actionEnvelope" },
    });
    expect(parseActionPackage({ executionPayload: {}, actionEnvelope: "x" })).toMatchObject({
      ok: false,
      error: { path: "$.actionEnvelope" },
    });
    expect(parseActionPackage({ executionPayload: {}, actionEnvelope: {} })).toMatchObject({
      ok: false,
      error: { path: "$.approvalBundle" },
    });
    expect(
      parseActionPackage({ executionPayload: {}, actionEnvelope: {}, approvalBundle: [] }),
    ).toMatchObject({
      ok: false,
      error: { path: "$.approvalBundle" },
    });
  });
});

describe("validateActionEnvelope (sdk)", () => {
  it.each(["valid-no-approval-required.json", "valid-two-approvals.json", "valid-delete-branch.json"])(
    "accepts valid envelope from %s",
    async (fixtureFile) => {
      const actionPackage = await readActionPackage(fixtureFile);
      expect(validateActionEnvelope(actionPackage.actionEnvelope)).toEqual({ ok: true });
    },
  );

  it("rejects an expired envelope", async () => {
    const actionPackage = await readActionPackage("invalid-expired-envelope.json");
    expect(validateActionEnvelope(actionPackage.actionEnvelope)).toMatchObject({
      ok: false,
      error: { code: "EXPIRED_ACTION_ENVELOPE" },
    });
  });

  it("can skip expiry checking", async () => {
    const actionPackage = await readActionPackage("invalid-expired-envelope.json");
    expect(validateActionEnvelope(actionPackage.actionEnvelope, { checkExpiry: false })).toEqual({ ok: true });
  });

  it("rejects a missing executionPayloadHash", async () => {
    const actionPackage = await readActionPackage("valid-no-approval-required.json");
    const malformed = { ...actionPackage.actionEnvelope } as Partial<ActionEnvelope>;
    delete malformed.executionPayloadHash;

    expect(validateActionEnvelope(malformed as ActionEnvelope)).toMatchObject({
      ok: false,
      error: { code: "INVALID_ACTION_ENVELOPE", path: "$.executionPayloadHash" },
    });
  });

  it("rejects a non-DID execution profile id", async () => {
    const actionPackage = await readActionPackage("valid-no-approval-required.json");
    const malformed = {
      ...actionPackage.actionEnvelope,
      executionProfile: {
        ...actionPackage.actionEnvelope.executionProfile,
        id: "not-a-did",
      },
    } as unknown as ActionEnvelope;

    expect(validateActionEnvelope(malformed)).toMatchObject({
      ok: false,
      error: { code: "INVALID_ACTION_ENVELOPE", path: "$.executionProfile.id" },
    });
  });

  it("rejects timestamps without exactly 3 fractional digits", async () => {
    const actionPackage = await readActionPackage("valid-no-approval-required.json");

    expect(
      validateActionEnvelope({
        ...actionPackage.actionEnvelope,
        createdAt: "2026-06-05T18:00:00Z",
      }),
    ).toMatchObject({
      ok: false,
      error: { path: "$.createdAt" },
    });
  });

  it("rejects structural envelope field violations", async () => {
    const base = (await readActionPackage("valid-no-approval-required.json")).actionEnvelope;

    expect(validateActionEnvelope(null as unknown as ActionEnvelope)).toMatchObject({
      ok: false,
      error: { path: "$" },
    });
    expect(validateActionEnvelope({ ...base, version: "2" })).toMatchObject({
      ok: false,
      error: { path: "$.version" },
    });
    expect(validateActionEnvelope({ ...base, type: "Other" })).toMatchObject({
      ok: false,
      error: { path: "$.type" },
    });
    expect(validateActionEnvelope({ ...base, proposer: { did: "not-a-did" } })).toMatchObject({
      ok: false,
      error: { path: "$.proposer.did" },
    });
    expect(
      validateActionEnvelope(JSON.parse(JSON.stringify({ ...base, target: { applicationDid: "web:example" } }))),
    ).toMatchObject({
      ok: false,
      error: { path: "$.target.applicationDid" },
    });
    expect(
      validateActionEnvelope(JSON.parse(JSON.stringify({
        ...base,
        executionPayloadHash: { ...base.executionPayloadHash, alg: "sha-512" },
      }))),
    ).toMatchObject({
      ok: false,
      error: { path: "$.executionPayloadHash" },
    });
    expect(validateActionEnvelope({ ...base, actionId: { value: "" } })).toMatchObject({
      ok: false,
      error: { path: "$.actionId.value" },
    });
    expect(validateActionEnvelope({ ...base, expiresAt: "2026-06-05T18:00:00Z" })).toMatchObject({
      ok: false,
      error: { path: "$.expiresAt" },
    });
  });
});

describe("verifyPayloadBinding (sdk)", () => {
  it("returns true when the payload hash matches", async () => {
    const actionPackage = await readActionPackage("valid-no-approval-required.json");
    expect(verifyPayloadBinding(actionPackage.executionPayload, actionPackage.actionEnvelope)).toBe(true);
  });

  it("returns false for invalid-payload-hash-mismatch.json", async () => {
    const actionPackage = await readActionPackage("invalid-payload-hash-mismatch.json");
    expect(verifyPayloadBinding(actionPackage.executionPayload, actionPackage.actionEnvelope)).toBe(false);
  });

  it("returns false when the envelope hash algorithm is not sha-256", async () => {
    const actionPackage = await readActionPackage("valid-no-approval-required.json");
    const envelope = JSON.parse(JSON.stringify({
      ...actionPackage.actionEnvelope,
      executionPayloadHash: { ...actionPackage.actionEnvelope.executionPayloadHash, alg: "sha-512" },
    }));
    expect(verifyPayloadBinding(actionPackage.executionPayload, envelope)).toBe(false);
  });
});

describe("expiry helpers (sdk)", () => {
  it("isEnvelopeExpired compares expiresAt to now", async () => {
    const actionPackage = await readActionPackage("invalid-expired-envelope.json");
    expect(isEnvelopeExpired(actionPackage.actionEnvelope)).toBe(true);

    const valid = await readActionPackage("valid-no-approval-required.json");
    expect(isEnvelopeExpired(valid.actionEnvelope, Date.parse("2020-01-01T00:00:00.000Z"))).toBe(false);
  });

  it("exceedsMaxEnvelopeValidity enforces the default window", async () => {
    const actionPackage = await readActionPackage("valid-no-approval-required.json");
    const now = Date.parse("2026-08-05T00:00:00.000Z");
    const longLived: ActionEnvelope = {
      ...actionPackage.actionEnvelope,
      createdAt: "2026-08-05T00:00:00.000Z",
      expiresAt: "2026-08-07T00:00:00.000Z",
    };

    expect(exceedsMaxEnvelopeValidity(longLived, DEFAULT_MAX_ENVELOPE_VALIDITY_MS, now)).toBe(true);
    expect(exceedsMaxEnvelopeValidity(longLived, Number.MAX_SAFE_INTEGER, now)).toBe(false);
    expect(
      exceedsMaxEnvelopeValidity(
        { ...longLived, expiresAt: "not-a-timestamp" },
        DEFAULT_MAX_ENVELOPE_VALIDITY_MS,
        now,
      ),
    ).toBe(false);
  });
});

describe("resolveTrustedSignerJwk (sdk)", () => {
  it("prefers did:jwk derivation over an explicit publicJwk", async () => {
    const proposer = await readJson<{ did: Did; publicJwk: { x: string } }>(
      join(fixturesDir, "test-keys", "proposer.json"),
    );
    const resolved = resolveTrustedSignerJwk({ did: proposer.did, publicJwk: proposer.publicJwk });
    expect(resolved?.x).toBe(proposer.publicJwk.x);
    expect(resolved?.kty).toBe("OKP");
  });

  it("derives a JWK from did:jwk when publicJwk is omitted", async () => {
    const proposer = await readJson<{ did: Did; publicJwk: { x: string } }>(
      join(fixturesDir, "test-keys", "proposer.json"),
    );
    const resolved = resolveTrustedSignerJwk({ did: proposer.did });
    expect(resolved?.x).toBe(proposer.publicJwk.x);
  });

  it("returns undefined for non-did:jwk without publicJwk", () => {
    expect(resolveTrustedSignerJwk({ did: "did:web:example" as Did })).toBeUndefined();
  });

  it("returns publicJwk for non-did:jwk signers", async () => {
    const proposer = await readJson<{ publicJwk: TrustedSigner["publicJwk"] }>(
      join(fixturesDir, "test-keys", "proposer.json"),
    );
    expect(
      resolveTrustedSignerJwk({ did: "did:web:agents.example:proposer" as Did, publicJwk: proposer.publicJwk }),
    ).toEqual(proposer.publicJwk);
  });

  it("returns undefined when did:jwk payload cannot be decoded", () => {
    expect(resolveTrustedSignerJwk({ did: "did:jwk:!!!" as Did })).toBeUndefined();
  });
});
