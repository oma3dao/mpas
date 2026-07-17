import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compactVerify, importJWK, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { ActionPackageBuilder, computeHash, KeyManager, type CanonicalApprovalPayload, type Did } from "../../src/index.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

interface KeyFixture {
  did: Did;
  publicJwk: JWK;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("ActionPackageBuilder", () => {
  it("builds a valid Action Package from an MCP tool call", async () => {
    const keyManager = await KeyManager.fromFile(join(fixturesDir, "keys", "proposer.json"));
    const proposer = await readJson<KeyFixture>(join(fixturesDir, "keys", "proposer.json"));
    const builder = new ActionPackageBuilder({
      applicationDid: "did:web:github.example",
      executionProfile: {
        id: "did:web:profiles.oma3.org:mcp",
        format: "mcp.toolsCall",
      },
      keyManager,
      defaultExpirationMinutes: 30,
    });

    const actionPackage = await builder.buildFromToolCall("create_issue", {
      owner: "oma3dao",
      repo: "test",
      title: "Hello",
    });

    expect(actionPackage.executionPayload).toEqual({
      name: "create_issue",
      arguments: {
        owner: "oma3dao",
        repo: "test",
        title: "Hello",
      },
    });
    expect(actionPackage.actionEnvelope).toMatchObject({
      version: "1",
      type: "ActionEnvelope",
      proposer: {
        did: proposer.did,
      },
      target: {
        applicationDid: "did:web:github.example",
      },
      executionProfile: {
        id: "did:web:profiles.oma3.org:mcp",
        format: "mcp.toolsCall",
      },
    });
    expect(actionPackage.actionEnvelope.actionId.value).toMatch(/^urn:uuid:/);
    expect(actionPackage.actionEnvelope.executionPayloadHash).toEqual(computeHash(actionPackage.executionPayload));

    const actionEnvelopeHash = computeHash(actionPackage.actionEnvelope);
    expect(actionPackage.approvalBundle.actionEnvelopeHash).toEqual(actionEnvelopeHash);
    expect(actionPackage.approvalBundle.approvals).toHaveLength(1);

    const approval = actionPackage.approvalBundle.approvals[0];
    expect(approval).toMatchObject({
      actionEnvelopeHash,
      decision: "propose",
      signature: {
        format: "jws",
      },
    });

    const publicKey = await importJWK(proposer.publicJwk, "EdDSA");
    const verified = await compactVerify(approval.signature.value, publicKey);
    const approvalPayload = JSON.parse(Buffer.from(verified.payload).toString("utf8")) as CanonicalApprovalPayload;

    expect(approvalPayload).toMatchObject({
      type: "ApprovalPayload",
      actionEnvelopeHash,
      decision: "propose",
      signerDid: proposer.did,
      createdAt: approval.createdAt,
    });
  });

  it("exposes the individual build steps", async () => {
    const keyManager = await KeyManager.fromFile(join(fixturesDir, "keys", "proposer.json"));
    const builder = new ActionPackageBuilder({
      applicationDid: "did:web:github.example",
      executionProfile: {
        id: "did:web:profiles.oma3.org:mcp",
        format: "mcp.toolsCall",
      },
      keyManager,
    });

    const payload = builder.buildPayload("delete_branch", { owner: "oma3dao", repo: "app-registry", branch: "tmp" });
    const envelope = builder.buildEnvelope(payload);
    const approval = await builder.signProposerApproval(envelope);
    const actionPackage = builder.assemblePackage(payload, envelope, approval);

    expect((actionPackage.executionPayload as { name?: string }).name).toBe("delete_branch");
    expect(actionPackage.actionEnvelope.executionPayloadHash).toEqual(computeHash(payload));
    expect(actionPackage.approvalBundle.approvals[0]?.signature.value).toEqual(approval.signature.value);
  });
});
