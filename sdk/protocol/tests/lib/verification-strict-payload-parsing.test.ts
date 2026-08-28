import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

async function signedApproval(duplicateMember?: DuplicateMember): Promise<Approval> {
  return {
    version: "1",
    type: "Approval",
    actionEnvelopeHash,
    decision: "approve",
    signature: {
      format: "jws",
      value: await keyManager.sign(Buffer.from(approvalPayloadText(duplicateMember))),
    },
    createdAt: "2026-06-05T18:01:00.000Z",
  };
}

beforeAll(async () => {
  actionPackage = await readJson<ActionPackage>(
    join(fixturesDir, "action-packages", "valid-merge-pr-package.json"),
  );
  keyManager = await KeyManager.fromFile(join(fixturesDir, "keys", "maintainer-a.json"));
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
        new Response(JSON.stringify({ version: "1", type: "CoordinationApprovalSubmissionResponse", accepted: true })),
      );
      vi.stubGlobal("fetch", fetchMock);
      const client = new CoordinationClient({ url: "https://coordination.example.com", signer: keyManager });

      await expect(client.submitApproval(actionEnvelopeHash, await signedApproval())).resolves.toMatchObject({ accepted: true });
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });
});
