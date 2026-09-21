import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CompactSign, importJWK, type JWK } from "jose";
import { canonicalize } from "json-canonicalize";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ApprovalBuilder,
  CoordinationClient,
  KeyManager,
  computeHash,
  verifyApprovalBundle,
  type ActionPackage,
  type Approval,
  type CanonicalApprovalPayload,
  type HashObject,
} from "../../src/index.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
const duplicateMembers = ["signerDid", "actionEnvelopeHash.value"] as const;
type DuplicateMember = (typeof duplicateMembers)[number];

let actionPackage: ActionPackage;
let actionEnvelopeHash: HashObject;
let keyManager: KeyManager;
let privateJwk: JWK;

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function approvalPayloadText(duplicateMember?: DuplicateMember): string {
  const payload: CanonicalApprovalPayload = {
    type: "ApprovalPayload",
    actionEnvelopeHash,
    decision: "approve",
    signerDid: keyManager.did,
    createdAt: "2026-06-05T18:01:00.000Z",
  };
  const text = canonicalize(payload);

  if (duplicateMember === "signerDid") {
    const member = `"signerDid":${JSON.stringify(keyManager.did)}`;
    return text.replace(member, `"signerDid":"did:example:first","signerDid":${JSON.stringify(keyManager.did)}`);
  }
  if (duplicateMember === "actionEnvelopeHash.value") {
    const member = `"value":${JSON.stringify(actionEnvelopeHash.value)}`;
    return text.replace(member, `"value":"first-value","value":${JSON.stringify(actionEnvelopeHash.value)}`);
  }

  return text;
}

interface SignedApprovalOptions {
  duplicateMember?: DuplicateMember;
  decision?: Approval["decision"];
  createdAt?: string;
  expiresAt?: string;
  kid?: string | null;
  nonCanonical?: boolean;
  extraPayloadField?: boolean;
  payloadType?: string;
}

async function signedApproval(options: SignedApprovalOptions | DuplicateMember = {}): Promise<Approval> {
  const normalized = typeof options === "string" ? { duplicateMember: options } : options;
  const decision = normalized.decision ?? "approve";
  const createdAt = normalized.createdAt ?? "2026-06-05T18:01:00.000Z";
  const basePayload = JSON.parse(approvalPayloadText(normalized.duplicateMember)) as Record<string, unknown>;
  basePayload.decision = decision;
  basePayload.createdAt = createdAt;
  if (normalized.expiresAt) basePayload.expiresAt = normalized.expiresAt;
  if (normalized.extraPayloadField) basePayload.undeclared = true;
  if (normalized.payloadType) basePayload.type = normalized.payloadType;
  const payloadText = normalized.duplicateMember
    ? approvalPayloadText(normalized.duplicateMember)
    : normalized.nonCanonical
      ? JSON.stringify(basePayload, null, 2)
      : canonicalize(basePayload);
  const protectedHeader: { alg: "EdDSA"; kid?: string } = { alg: "EdDSA" };
  if (normalized.kid !== null) protectedHeader.kid = normalized.kid ?? `${keyManager.did}#0`;
  const key = await importJWK(privateJwk, "EdDSA");

  return {
    version: "1",
    type: "Approval",
    actionEnvelopeHash,
    decision,
    signature: {
      format: "jws",
      value: await new CompactSign(Buffer.from(payloadText)).setProtectedHeader(protectedHeader).sign(key),
    },
    createdAt,
    ...(normalized.expiresAt ? { expiresAt: normalized.expiresAt } : {}),
  };
}

beforeAll(async () => {
  actionPackage = await readJson<ActionPackage>(
    join(fixturesDir, "action-packages", "valid-merge-pr-package.json"),
  );
  keyManager = await KeyManager.fromFile(join(fixturesDir, "keys", "maintainer-a.json"));
  privateJwk = (await readJson<{ privateJwk: JWK }>(join(fixturesDir, "keys", "maintainer-a.json"))).privateJwk;
  actionEnvelopeHash = computeHash(actionPackage.actionEnvelope);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("strict signed Approval payload parsing", () => {
  describe("verifyApprovalBundle", () => {
    it.each(duplicateMembers)("rejects duplicate %s", async (duplicateMember) => {
      const approval = await signedApproval(duplicateMember);
      const result = await verifyApprovalBundle(
        { ...actionPackage.approvalBundle, actionEnvelopeHash, approvals: [approval] },
        actionEnvelopeHash,
        [{ did: keyManager.did }],
      );

      expect(result.ok).toBe(false);
    });

    it("still verifies the same signed payload without duplicate members", async () => {
      const approval = await signedApproval();
      const result = await verifyApprovalBundle(
        { ...actionPackage.approvalBundle, actionEnvelopeHash, approvals: [approval] },
        actionEnvelopeHash,
        [{ did: keyManager.did }],
      );

      expect(result.ok).toBe(true);
    });

    it("rejects valid signatures over non-canonical Approval bytes", async () => {
      const result = await verifyApprovalBundle(
        { ...actionPackage.approvalBundle, actionEnvelopeHash, approvals: [await signedApproval({ nonCanonical: true })] },
        actionEnvelopeHash,
        [{ did: keyManager.did }],
      );

      expect(result).toMatchObject({ ok: false, error: { code: "NON_CANONICAL_APPROVAL_PAYLOAD" } });
    });

    it.each([
      ["missing", null],
      ["foreign", "did:jwk:foreign#0"],
    ])("rejects a %s protected kid", async (_label, kid) => {
      const result = await verifyApprovalBundle(
        { ...actionPackage.approvalBundle, actionEnvelopeHash, approvals: [await signedApproval({ kid })] },
        actionEnvelopeHash,
        [{ did: keyManager.did }],
      );

      expect(result).toMatchObject({ ok: false, error: { code: "KEY_ID_MISMATCH" } });
    });

    it.each([
      ["wrong payload discriminator", { payloadType: "Approval" }],
      ["undeclared signed field", { extraPayloadField: true }],
    ])("rejects a %s before admitting an Approval", async (_label, options) => {
      const result = await verifyApprovalBundle(
        { ...actionPackage.approvalBundle, actionEnvelopeHash, approvals: [await signedApproval(options)] },
        actionEnvelopeHash,
        [{ did: keyManager.did }],
      );

      expect(result).toMatchObject({ ok: false, error: { code: "APPROVAL_PAYLOAD_MISMATCH" } });
    });

    it("rejects contradictory decisions from one Signer regardless of order", async () => {
      const approve = await signedApproval({ decision: "approve" });
      const reject = await signedApproval({ decision: "reject" });

      for (const approvals of [[approve, reject], [reject, approve]]) {
        const result = await verifyApprovalBundle(
          { ...actionPackage.approvalBundle, actionEnvelopeHash, approvals },
          actionEnvelopeHash,
          [{ did: keyManager.did }],
        );
        expect(result).toMatchObject({ ok: false, error: { code: "CONFLICTING_SIGNER_DECISIONS" } });
      }
    });

    it("accepts repeated same-decision evidence for downstream Signer normalization", async () => {
      const approval = await signedApproval();
      const result = await verifyApprovalBundle(
        { ...actionPackage.approvalBundle, actionEnvelopeHash, approvals: [approval, approval] },
        actionEnvelopeHash,
        [{ did: keyManager.did }],
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.verifiedApprovals.approvals).toHaveLength(2);
    });

    it("rejects an expired Approval against the trusted clock and envelope", async () => {
      const result = await verifyApprovalBundle(
        {
          ...actionPackage.approvalBundle,
          actionEnvelopeHash,
          approvals: [await signedApproval({ expiresAt: "2026-06-05T18:02:00.000Z" })],
        },
        actionEnvelopeHash,
        [{ did: keyManager.did }],
        { actionEnvelope: actionPackage.actionEnvelope, now: Date.parse("2026-06-05T18:30:00.000Z") },
      );

      expect(result).toMatchObject({ ok: false, error: { code: "APPROVAL_TIME_INVALID" } });
    });
  });

  describe("ApprovalBuilder.verifyApproval", () => {
    it.each(duplicateMembers)("rejects duplicate %s", async (duplicateMember) => {
      const builder = new ApprovalBuilder({ keyManager });

      await expect(builder.verifyApproval(await signedApproval(duplicateMember), keyManager.publicKey)).resolves.toBe(false);
    });

    it("still verifies the same signed payload without duplicate members", async () => {
      const builder = new ApprovalBuilder({ keyManager });

      await expect(builder.verifyApproval(await signedApproval(), keyManager.publicKey)).resolves.toBe(true);
    });
  });

  describe("CoordinationClient.submitApproval", () => {
    it.each(duplicateMembers)("rejects duplicate %s before sending", async (duplicateMember) => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ version: "1", type: "CoordinationApprovalSubmissionResponse", accepted: true })),
      );
      vi.stubGlobal("fetch", fetchMock);
      const client = new CoordinationClient({ url: "https://coordination.example.com", signer: keyManager });

      await expect(client.submitApproval(actionEnvelopeHash, await signedApproval(duplicateMember))).rejects.toThrow(
        "Approval does not contain a decodable compact JWS signer DID.",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("still sends the same signed payload without duplicate members", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          version: "1",
          type: "CoordinationApprovalSubmissionResponse",
          accepted: true,
          actionRef: {
            version: "1",
            type: "ActionRef",
            actionId: actionPackage.actionEnvelope.actionId,
            actionEnvelopeHash: actionPackage.approvalBundle.actionEnvelopeHash,
          },
          state: "executed",
          createdAt: "2026-06-05T18:20:00.000Z",
        })),
      );
      vi.stubGlobal("fetch", fetchMock);
      const client = new CoordinationClient({ url: "https://coordination.example.com", signer: keyManager });

      await expect(client.submitApproval(actionEnvelopeHash, await signedApproval())).resolves.toMatchObject({ accepted: true });
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });
});
