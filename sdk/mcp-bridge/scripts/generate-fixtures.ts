import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CompactSign, importJWK, type JWK } from "jose";
import { canonicalize } from "json-canonicalize";
import type {
  ActionEnvelope,
  ActionPackage,
  AdapterResponse,
  Approval,
  CanonicalApprovalPayload,
  CoordinationPollResponse,
  Decision,
  Did,
  ExecutionPayload,
  ExecutionReceipt,
  HashObject,
  ReceiptPayload,
  SignerReviewSet,
} from "../src/index.js";

interface KeyFixture {
  label: string;
  did: Did;
  kid: string;
  privateJwk: JWK;
  publicJwk: JWK;
}

interface ActionFixtureSpec {
  fileName: string;
  actionId: string;
  payload: ExecutionPayload;
  approvals: Array<{
    key: KeyFixture;
    decision: Decision;
    createdAt: string;
  }>;
}

const fixturesDir = fileURLToPath(new URL("../tests/fixtures/", import.meta.url));
const createdAt = "2026-06-05T18:00:00Z";
const expiresAt = "2030-01-01T00:00:00Z";
const assembledAt = "2026-06-05T18:10:00Z";
const responseIssuedAt = "2026-06-05T18:15:00Z";
const responseExpiresAt = "2026-06-05T19:15:00Z";
const applicationDid: Did = "did:web:github.example";
const executionProfile = {
  id: "did:web:profiles.oma3.org:mcp" as Did,
  format: "mcp.toolsCall",
};

async function main(): Promise<void> {
  const proposer = await readJson<KeyFixture>("keys/proposer.json");
  const signerA = await readJson<KeyFixture>("keys/maintainer-a.json");
  const signerB = await readJson<KeyFixture>("keys/maintainer-b.json");
  const adapter = await readJson<KeyFixture>("keys/adapter.json");

  const specs: ActionFixtureSpec[] = [
    {
      fileName: "valid-create-issue-package.json",
      actionId: "urn:uuid:11111111-1111-4111-8111-111111111111",
      payload: {
        name: "create_issue",
        arguments: {
          owner: "oma3dao",
          repo: "app-registry",
          title: "Add MPAS fixture coverage",
          body: "Created by the MPAS Credential Adapter fixture set.",
        },
      },
      approvals: [{ key: proposer, decision: "propose", createdAt: "2026-06-05T18:01:00Z" }],
    },
    {
      fileName: "valid-merge-pr-package.json",
      actionId: "urn:uuid:22222222-2222-4222-8222-222222222222",
      payload: {
        name: "merge_pull_request",
        arguments: {
          owner: "oma3dao",
          repo: "app-registry",
          pullNumber: 42,
          baseRef: "main",
          expectedHeadSha: "abc123def456",
          mergeMethod: "squash",
        },
      },
      approvals: [
        { key: proposer, decision: "propose", createdAt: "2026-06-05T18:01:00Z" },
        { key: signerA, decision: "approve", createdAt: "2026-06-05T18:02:00Z" },
        { key: signerB, decision: "approve", createdAt: "2026-06-05T18:03:00Z" },
      ],
    },
    {
      fileName: "valid-delete-branch-package.json",
      actionId: "urn:uuid:33333333-3333-4333-8333-333333333333",
      payload: {
        name: "delete_branch",
        arguments: {
          owner: "oma3dao",
          repo: "app-registry",
          branch: "feature/remove-stale-fixture",
        },
      },
      approvals: [
        { key: proposer, decision: "propose", createdAt: "2026-06-05T18:01:00Z" },
        { key: signerA, decision: "approve", createdAt: "2026-06-05T18:02:00Z" },
      ],
    },
  ];

  const packages = new Map<string, ActionPackage>();
  for (const spec of specs) {
    const actionPackage = await buildActionPackage(spec, proposer);
    packages.set(spec.fileName, actionPackage);
    await writeJson(join("action-packages", spec.fileName), actionPackage);
  }

  const createIssuePackage = requiredPackage(packages, "valid-create-issue-package.json");
  await writeResponseFixtures(createIssuePackage, adapter);
}

async function buildActionPackage(spec: ActionFixtureSpec, proposer: KeyFixture): Promise<ActionPackage> {
  const envelope: ActionEnvelope = {
    version: "1",
    type: "ActionEnvelope",
    proposer: {
      did: proposer.did,
    },
    target: {
      applicationDid,
      resource: "repo:oma3dao/app-registry",
    },
    executionProfile,
    executionPayloadHash: computeHash(spec.payload),
    actionId: {
      value: spec.actionId,
    },
    createdAt,
    expiresAt,
  };
  const actionEnvelopeHash = computeHash(envelope);
  const approvals = await Promise.all(
    spec.approvals.map((approval) => signApproval(actionEnvelopeHash, approval.key, approval.decision, approval.createdAt)),
  );

  return {
    version: "1",
    type: "ActionPackage",
    executionPayload: spec.payload,
    actionEnvelope: envelope,
    approvalBundle: {
      version: "1",
      type: "ApprovalBundle",
      actionEnvelopeHash,
      approvals,
      assembledBy: proposer.did,
      createdAt: assembledAt,
    },
    createdAt: assembledAt,
  };
}

async function signApproval(
  actionEnvelopeHash: HashObject,
  keyFixture: KeyFixture,
  decision: Decision,
  approvalCreatedAt: string,
): Promise<Approval> {
  const approvalPayload: CanonicalApprovalPayload = {
    type: "ApprovalPayload",
    actionEnvelopeHash,
    decision,
    signerDid: keyFixture.did,
    createdAt: approvalCreatedAt,
  };
  const key = await importJWK(keyFixture.privateJwk, "EdDSA");
  const signature = await new CompactSign(Buffer.from(canonicalize(approvalPayload)))
    .setProtectedHeader({ alg: "EdDSA", kid: keyFixture.kid })
    .sign(key);

  return {
    version: "1",
    type: "Approval",
    actionEnvelopeHash,
    decision,
    signature: {
      format: "jws",
      value: signature,
    },
    createdAt: approvalCreatedAt,
  };
}

async function writeResponseFixtures(actionPackage: ActionPackage, adapter: KeyFixture): Promise<void> {
  const executedReceipt = await signReceipt(actionPackage, adapter, "executed", "fixture:create_issue:1");
  const rejectedReceipt = await signReceipt(actionPackage, adapter, "rejected");
  const actionEnvelopeHash = computeHash(actionPackage.actionEnvelope);
  const responseCreatedAt = new Date(responseIssuedAt).toISOString();

  const executed: AdapterResponse = {
    version: "1",
    type: "ActionResponse",
    verifier: {
      did: adapter.did,
    },
    result: "executed",
    executionReceipt: executedReceipt,
    executionResult: {
      content: [{ type: "text", text: "Created issue #123" }],
    },
    createdAt: responseCreatedAt,
  };
  const needsApprovals: AdapterResponse = {
    version: "1",
    type: "ActionResponse",
    verifier: {
      did: adapter.did,
    },
    actionEnvelopeHash,
    result: "additionalApprovalsRequired",
    authorizationRequirements: {
      version: "1",
      type: "AuthorizationRequirements",
      actionEnvelopeHash,
      result: "additionalApprovalsRequired",
      verifier: {
        did: adapter.did,
      },
      approvalRequirements: {
        anyOf: [
          {
            type: "threshold",
            threshold: 1,
            eligibleSigners: ["did:key:z6MkvnsFe1agZ33u5c9JuDkRxKRqupn3qbmPd2cjZ5rmerJi"],
            decision: "approve",
            description: "Maintainer approval required.",
          },
        ],
      },
      createdAt: responseIssuedAt,
      expiresAt: responseExpiresAt,
    },
  };
  const rejected: AdapterResponse = {
    version: "1",
    type: "ActionResponse",
    verifier: {
      did: adapter.did,
    },
    result: "rejected",
    executionReceipt: rejectedReceipt,
    error: {
      code: "OPERATION_NOT_ENABLED",
      message: "Operation is not enabled for this deployment.",
    },
    createdAt: responseCreatedAt,
  };
  const malformed: AdapterResponse = {
    version: "1",
    type: "ActionResponse",
    verifier: {
      did: adapter.did,
    },
    result: "malformed",
    error: {
      code: "INVALID_ACTION_PACKAGE",
      message: "Approval object is structurally invalid.",
    },
    createdAt: responseCreatedAt,
  };
  const reviewSet: SignerReviewSet = {
    version: "1",
    type: "SignerReviewSet",
    actionEnvelope: actionPackage.actionEnvelope,
    executionPayload: actionPackage.executionPayload,
    authorizationRequirements: {
      version: "1",
      type: "AuthorizationRequirements",
      actionEnvelopeHash,
      result: "additionalApprovalsRequired",
      verifier: {
        did: adapter.did,
      },
      approvalRequirements: {
        anyOf: [
          {
            type: "threshold",
            threshold: 1,
            eligibleSigners: ["did:key:z6MkvnsFe1agZ33u5c9JuDkRxKRqupn3qbmPd2cjZ5rmerJi"],
            decision: "approve",
          },
        ],
      },
      createdAt: responseIssuedAt,
      expiresAt: responseExpiresAt,
    },
    createdAt: responseIssuedAt,
    expiresAt: responseExpiresAt,
  };
  const pendingActions: CoordinationPollResponse = {
    version: "1",
    type: "CoordinationPollResponse",
    approvalRequests: [
      {
        version: "1",
        type: "ApprovalRequest",
        actionRef: {
          version: "1",
          type: "ActionRef",
          actionId: actionPackage.actionEnvelope.actionId,
          actionEnvelopeHash,
        },
        signerReviewSet: reviewSet,
        requestedDecision: "approve",
      },
    ],
    actionUpdates: [],
  };

  await writeJson("responses/adapter-response-executed.json", executed);
  await writeJson("responses/adapter-response-needs-approvals.json", needsApprovals);
  await writeJson("responses/adapter-response-rejected.json", rejected);
  await writeJson("responses/adapter-response-malformed.json", malformed);
  await writeJson("responses/coordination-pending-actions.json", pendingActions);
  await writeJson("responses/coordination-review-set.json", reviewSet);
}

async function signReceipt(
  actionPackage: ActionPackage,
  adapter: KeyFixture,
  result: ReceiptPayload["result"],
  executionRef?: string,
): Promise<ExecutionReceipt> {
  const receiptPayload: ReceiptPayload = {
    issuerDid: adapter.did,
    actionEnvelopeHash: computeHash(actionPackage.actionEnvelope),
    executionPayloadHash: computeHash(actionPackage.executionPayload),
    actionId: actionPackage.actionEnvelope.actionId,
    proposerDid: actionPackage.actionEnvelope.proposer.did,
    result,
    issuedAt: responseIssuedAt,
  };
  if (executionRef) {
    receiptPayload.executionRef = executionRef;
  }
  const key = await importJWK(adapter.privateJwk, "EdDSA");
  const signature = await new CompactSign(Buffer.from(canonicalize(receiptPayload)))
    .setProtectedHeader({ alg: "EdDSA", kid: adapter.kid })
    .sign(key);

  return {
    version: "1",
    type: "ExecutionReceipt",
    format: "jws",
    signature,
  };
}

function computeHash(value: unknown): HashObject {
  return {
    alg: "sha-256",
    value: createHash("sha256").update(canonicalize(value)).digest("base64url"),
  };
}

function requiredPackage(packages: Map<string, ActionPackage>, fileName: string): ActionPackage {
  const actionPackage = packages.get(fileName);
  if (!actionPackage) {
    throw new Error(`Missing generated package: ${fileName}`);
  }

  return actionPackage;
}

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(join(fixturesDir, relativePath), "utf8")) as T;
}

async function writeJson(relativePath: string, value: unknown): Promise<void> {
  const path = join(fixturesDir, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

await main();
