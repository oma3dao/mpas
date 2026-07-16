import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CompactSign, importJWK } from "jose";
import { canonicalize } from "json-canonicalize";
import { computeArtifactDid } from "../src/adapter/config-loader.js";

const keys = {
  proposer: {
    label: "proposer",
    did: "did:key:z6MkpPanM5XyyGcp6HAwJSm7SmWmmb4MpfmBfgRSq4t7GokV",
    kid: "did:key:z6MkpPanM5XyyGcp6HAwJSm7SmWmmb4MpfmBfgRSq4t7GokV#z6MkpPanM5XyyGcp6HAwJSm7SmWmmb4MpfmBfgRSq4t7GokV",
    privateJwk: {
      crv: "Ed25519",
      d: "UA1VsxVt4yqqnFyc4xENa10rWJOqNnWO27v-f1_nUmk",
      x: "k6O7ciQkmphuEEt1i3yAimJJWeGKmOq3t_fsNkzza6o",
      kty: "OKP",
      alg: "EdDSA",
      use: "sig",
      kid: "did:key:z6MkpPanM5XyyGcp6HAwJSm7SmWmmb4MpfmBfgRSq4t7GokV#z6MkpPanM5XyyGcp6HAwJSm7SmWmmb4MpfmBfgRSq4t7GokV",
    },
    publicJwk: {
      crv: "Ed25519",
      x: "k6O7ciQkmphuEEt1i3yAimJJWeGKmOq3t_fsNkzza6o",
      kty: "OKP",
      alg: "EdDSA",
      use: "sig",
      kid: "did:key:z6MkpPanM5XyyGcp6HAwJSm7SmWmmb4MpfmBfgRSq4t7GokV#z6MkpPanM5XyyGcp6HAwJSm7SmWmmb4MpfmBfgRSq4t7GokV",
    },
  },
  maintainerA: {
    label: "maintainer-a",
    did: "did:key:z6MkvnsFe1agZ33u5c9JuDkRxKRqupn3qbmPd2cjZ5rmerJi",
    kid: "did:key:z6MkvnsFe1agZ33u5c9JuDkRxKRqupn3qbmPd2cjZ5rmerJi#z6MkvnsFe1agZ33u5c9JuDkRxKRqupn3qbmPd2cjZ5rmerJi",
    privateJwk: {
      crv: "Ed25519",
      d: "kSRUeh59TL7vVxo6oeJL0SvujeYlqP_ICEu6urlNrs0",
      x: "8sDV76b8iF76PImAw5I9Wvejs_8bS8N12WvHzPa5Vw8",
      kty: "OKP",
      alg: "EdDSA",
      use: "sig",
      kid: "did:key:z6MkvnsFe1agZ33u5c9JuDkRxKRqupn3qbmPd2cjZ5rmerJi#z6MkvnsFe1agZ33u5c9JuDkRxKRqupn3qbmPd2cjZ5rmerJi",
    },
    publicJwk: {
      crv: "Ed25519",
      x: "8sDV76b8iF76PImAw5I9Wvejs_8bS8N12WvHzPa5Vw8",
      kty: "OKP",
      alg: "EdDSA",
      use: "sig",
      kid: "did:key:z6MkvnsFe1agZ33u5c9JuDkRxKRqupn3qbmPd2cjZ5rmerJi#z6MkvnsFe1agZ33u5c9JuDkRxKRqupn3qbmPd2cjZ5rmerJi",
    },
  },
  maintainerB: {
    label: "maintainer-b",
    did: "did:key:z6MkujMqQsmtUpjtAAJQw6z8CDMh9GDdh6gmWogYwYqxAFV8",
    kid: "did:key:z6MkujMqQsmtUpjtAAJQw6z8CDMh9GDdh6gmWogYwYqxAFV8#z6MkujMqQsmtUpjtAAJQw6z8CDMh9GDdh6gmWogYwYqxAFV8",
    privateJwk: {
      crv: "Ed25519",
      d: "NKLetLnK0SqzMfy0m3EftV1H6SOgYdo2AJEnW170Hbk",
      x: "4v8kxXJiFpCHpVxWxHRQLLq0bjIlUF-sE1UINoy50-8",
      kty: "OKP",
      alg: "EdDSA",
      use: "sig",
      kid: "did:key:z6MkujMqQsmtUpjtAAJQw6z8CDMh9GDdh6gmWogYwYqxAFV8#z6MkujMqQsmtUpjtAAJQw6z8CDMh9GDdh6gmWogYwYqxAFV8",
    },
    publicJwk: {
      crv: "Ed25519",
      x: "4v8kxXJiFpCHpVxWxHRQLLq0bjIlUF-sE1UINoy50-8",
      kty: "OKP",
      alg: "EdDSA",
      use: "sig",
      kid: "did:key:z6MkujMqQsmtUpjtAAJQw6z8CDMh9GDdh6gmWogYwYqxAFV8#z6MkujMqQsmtUpjtAAJQw6z8CDMh9GDdh6gmWogYwYqxAFV8",
    },
  },
  adapter: {
    label: "adapter",
    did: "did:key:z6MkjNteHVrscbEvtZ11x56uSdCNjAGL1rWpTrcXAPRky6vm",
    kid: "did:key:z6MkjNteHVrscbEvtZ11x56uSdCNjAGL1rWpTrcXAPRky6vm#z6MkjNteHVrscbEvtZ11x56uSdCNjAGL1rWpTrcXAPRky6vm",
    privateJwk: {
      crv: "Ed25519",
      d: "_yARgWiyVyU1gZkULFUI9FZFhAqsyrsbr9dTbnhsG7o",
      x: "SSvpiqWWoPEAtuMhB0GxgCm-N8AGHu-_x9qGbRh0t1I",
      kty: "OKP",
      alg: "EdDSA",
      use: "sig",
      kid: "did:key:z6MkjNteHVrscbEvtZ11x56uSdCNjAGL1rWpTrcXAPRky6vm#z6MkjNteHVrscbEvtZ11x56uSdCNjAGL1rWpTrcXAPRky6vm",
    },
    publicJwk: {
      crv: "Ed25519",
      x: "SSvpiqWWoPEAtuMhB0GxgCm-N8AGHu-_x9qGbRh0t1I",
      kty: "OKP",
      alg: "EdDSA",
      use: "sig",
      kid: "did:key:z6MkjNteHVrscbEvtZ11x56uSdCNjAGL1rWpTrcXAPRky6vm#z6MkjNteHVrscbEvtZ11x56uSdCNjAGL1rWpTrcXAPRky6vm",
    },
  },
};

function hashJson(value: unknown) {
  return {
    alg: "sha-256",
    value: createHash("sha256").update(canonicalize(value)).digest("base64url"),
  };
}

async function readFixtureKeys(fixtureRoot: string) {
  const loaded: Record<string, unknown> = {};
  for (const key of Object.values(keys)) {
    const file = join(fixtureRoot, "test-keys", `${key.label}.json`);
    const parsed = JSON.parse(await readFile(file, "utf8"));
    loaded[key.label === "maintainer-a" ? "maintainerA" : key.label === "maintainer-b" ? "maintainerB" : key.label] =
      parsed;
  }
  return loaded;
}

async function signApproval(actionEnvelopeHash: { alg: string; value: string }, signer: typeof keys.proposer, decision: string, createdAt: string) {
  const payload = {
    type: "ApprovalPayload",
    actionEnvelopeHash,
    decision,
    signerDid: signer.did,
    createdAt,
  };
  const key = await importJWK(signer.privateJwk, "EdDSA");
  const value = await new CompactSign(Buffer.from(canonicalize(payload)))
    .setProtectedHeader({ alg: "EdDSA", kid: signer.kid })
    .sign(key);

  return {
    version: "1",
    type: "Approval",
    actionEnvelopeHash,
    decision,
    signature: { format: "jws", value },
    createdAt,
  };
}

async function makeActionPackage({
  payload,
  actionId,
  resource,
  approvals,
  applicationDid = "did:web:github.example",
  createdAt = "2026-06-05T18:00:00.000Z",
  expiresAt = "2030-01-01T00:00:00.000Z",
}: {
  payload: Record<string, unknown>;
  actionId: string;
  resource: string;
  approvals: Array<{ signer: typeof keys.proposer; decision: string; createdAt: string }>;
  applicationDid?: string;
  createdAt?: string;
  expiresAt?: string;
}) {
  const actionEnvelope = {
    version: "1",
    type: "ActionEnvelope",
    proposer: { did: keys.proposer.did },
    target: {
      applicationDid,
      resource,
    },
    executionProfile: {
      id: "did:web:profiles.oma3.org:mcp",
      format: "mcp.toolsCall",
    },
    executionPayloadHash: hashJson(payload),
    actionId: { value: actionId },
    createdAt,
    expiresAt,
  };

  const actionEnvelopeHash = hashJson(actionEnvelope);
  const signedApprovals = [];
  for (const approval of approvals) {
    signedApprovals.push(
      await signApproval(actionEnvelopeHash, approval.signer, approval.decision, approval.createdAt),
    );
  }

  return {
    version: "1",
    type: "ActionPackage",
    executionPayload: payload,
    actionEnvelope,
    approvalBundle: {
      version: "1",
      type: "ApprovalBundle",
      actionEnvelopeHash,
      approvals: signedApprovals,
      assembledBy: keys.proposer.did,
      createdAt: "2026-06-05T18:10:00.000Z",
    },
    createdAt: "2026-06-05T18:10:00.000Z",
  };
}

async function main() {
const fixtureRoot = join(process.cwd(), "tests", "fixtures");
await mkdir(join(fixtureRoot, "test-keys"), { recursive: true });

for (const key of Object.values(keys)) {
  await writeFile(join(fixtureRoot, "test-keys", `${key.label}.json`), `${JSON.stringify(key, null, 2)}\n`);
}

Object.assign(keys, await readFixtureKeys(fixtureRoot));

const packages = {
  "valid-no-approval-required.json": await makeActionPackage({
    payload: {
      name: "create_issue",
      arguments: {
        owner: "example-org",
        repo: "mpas-demo-repository",
        title: "Add MPAS fixture coverage",
        body: "Created by the MPAS Credential Adapter fixture set.",
      },
    },
    actionId: "urn:uuid:11111111-1111-4111-8111-111111111111",
    resource: "repo:example-org/mpas-demo-repository",
    approvals: [{ signer: keys.proposer, decision: "propose", createdAt: "2026-06-05T18:01:00.000Z" }],
  }),
  "valid-two-approvals.json": await makeActionPackage({
    payload: {
      name: "merge_pull_request",
      arguments: {
        owner: "example-org",
        repo: "mpas-demo-repository",
        pullNumber: 42,
        baseRef: "main",
        expectedHeadSha: "abc123def456",
        mergeMethod: "squash",
      },
    },
    actionId: "urn:uuid:22222222-2222-4222-8222-222222222222",
    resource: "repo:example-org/mpas-demo-repository",
    approvals: [
      { signer: keys.proposer, decision: "propose", createdAt: "2026-06-05T18:01:00.000Z" },
      { signer: keys.maintainerA, decision: "approve", createdAt: "2026-06-05T18:02:00.000Z" },
      { signer: keys.maintainerB, decision: "approve", createdAt: "2026-06-05T18:03:00.000Z" },
    ],
  }),
  "valid-delete-branch.json": await makeActionPackage({
    payload: {
      name: "delete_branch",
      arguments: {
        owner: "example-org",
        repo: "mpas-demo-repository",
        branch: "feature/remove-stale-fixture",
      },
    },
    actionId: "urn:uuid:33333333-3333-4333-8333-333333333333",
    resource: "repo:example-org/mpas-demo-repository",
    approvals: [
      { signer: keys.proposer, decision: "propose", createdAt: "2026-06-05T18:01:00.000Z" },
      { signer: keys.maintainerA, decision: "approve", createdAt: "2026-06-05T18:02:00.000Z" },
    ],
  }),
};

const insufficientApprovals = await makeActionPackage({
  payload: {
    name: "merge_pull_request",
    arguments: {
      owner: "example-org",
      repo: "mpas-demo-repository",
      pullNumber: 99,
      baseRef: "main",
      expectedHeadSha: "def456abc123",
      mergeMethod: "squash",
    },
  },
  actionId: "urn:uuid:44444444-4444-4444-8444-444444444444",
  resource: "repo:example-org/mpas-demo-repository",
  approvals: [{ signer: keys.proposer, decision: "propose", createdAt: "2026-06-05T18:01:00.000Z" }],
});

const invalidUnknownApplication = await makeActionPackage({
  payload: {
    name: "create_issue",
    arguments: {
      owner: "example-org",
      repo: "mpas-demo-repository",
      title: "Unknown application fixture",
      body: "This package targets an application DID with no deployment config.",
    },
  },
  actionId: "urn:uuid:55555555-5555-4555-8555-555555555555",
  resource: "repo:example-org/mpas-demo-repository",
  applicationDid: "did:web:unknown-github.example",
  approvals: [{ signer: keys.proposer, decision: "propose", createdAt: "2026-06-05T18:01:00.000Z" }],
});

const invalidDisabledOperation = await makeActionPackage({
  payload: {
    name: "delete_branch",
    arguments: {
      owner: "example-org",
      repo: "mpas-demo-repository",
      branch: "feature/disabled-operation",
    },
  },
  actionId: "urn:uuid:66666666-6666-4666-8666-666666666666",
  resource: "repo:example-org/mpas-demo-repository",
  approvals: [
    { signer: keys.proposer, decision: "propose", createdAt: "2026-06-05T18:01:00.000Z" },
    { signer: keys.maintainerA, decision: "approve", createdAt: "2026-06-05T18:02:00.000Z" },
  ],
});

const invalidResourceRestricted = await makeActionPackage({
  payload: {
    name: "create_issue",
    arguments: {
      owner: "outside-org",
      repo: "restricted-repo",
      title: "Restricted resource fixture",
      body: "This package names a repository outside allowedRepositories.",
    },
  },
  actionId: "urn:uuid:77777777-7777-4777-8777-777777777777",
  resource: "repo:outside-org/restricted-repo",
  approvals: [{ signer: keys.proposer, decision: "propose", createdAt: "2026-06-05T18:01:00.000Z" }],
});

const invalidExpiredEnvelope = await makeActionPackage({
  payload: {
    name: "create_issue",
    arguments: {
      owner: "example-org",
      repo: "mpas-demo-repository",
      title: "Expired envelope fixture",
      body: "This package is otherwise valid, but the envelope is expired.",
    },
  },
  actionId: "urn:uuid:88888888-8888-4888-8888-888888888888",
  resource: "repo:example-org/mpas-demo-repository",
  createdAt: "2025-12-01T00:00:00.000Z",
  expiresAt: "2026-01-01T00:00:00.000Z",
  approvals: [{ signer: keys.proposer, decision: "propose", createdAt: "2025-12-02T00:00:00.000Z" }],
});

const malformedMissingEnvelope = structuredClone(packages["valid-no-approval-required.json"]) as Record<string, unknown>;
delete malformedMissingEnvelope.actionEnvelope;

const invalidPayloadHashMismatch = structuredClone(packages["valid-no-approval-required.json"]);
(invalidPayloadHashMismatch.executionPayload as Record<string, Record<string, unknown>>).arguments.title = "Tampered after envelope signing";

const invalidBadSignature = structuredClone(packages["valid-no-approval-required.json"]);
const badSignature = invalidBadSignature.approvalBundle.approvals[0].signature.value;
// Flip a character well inside the signature (position -5) where all 6 base64url
// bits are significant.  Flipping only the last character can land in padding bits
// that are discarded on decode, leaving the 64-byte Ed25519 signature unchanged.
const corruptIdx = badSignature.length - 5;
const orig = badSignature[corruptIdx];
const replacement = orig === "A" ? "B" : "A";
invalidBadSignature.approvalBundle.approvals[0].signature.value =
  badSignature.slice(0, corruptIdx) + replacement + badSignature.slice(corruptIdx + 1);

const invalidPackages = {
  "malformed-missing-envelope.json": malformedMissingEnvelope,
  "invalid-payload-hash-mismatch.json": invalidPayloadHashMismatch,
  "invalid-expired-envelope.json": invalidExpiredEnvelope,
  "invalid-bad-signature.json": invalidBadSignature,
  "insufficient-approvals.json": insufficientApprovals,
  "invalid-unknown-application.json": invalidUnknownApplication,
  "invalid-disabled-operation.json": invalidDisabledOperation,
  "invalid-resource-restricted.json": invalidResourceRestricted,
};

const githubPlugin = {
  version: "1",
  type: "MpasApplicationPlugin",
  pluginDid: "did:web:plugins.example.com:github-repo",
  pluginVersion: "1.0.0",
  publisherDid: "did:web:wivity.example",
  applicationDid: "did:web:github.example",
  executionProfile: {
    id: "did:web:profiles.oma3.org:mcp",
    format: "mcp.toolsCall",
  },
  credentialRequirements: [
    {
      type: "oauthToken",
      requiredCapabilities: ["issue.write", "pullRequest.merge", "pullRequest.read", "branch.delete"],
      description: "GitHub OAuth token with repository access for configured repositories.",
    },
  ],
  operations: {
    merge_pull_request: {
      description: "Merge a pull request into its base branch.",
      impact: "high",
      executionPayloadSchema: {
        type: "object",
        required: ["name", "arguments"],
        properties: {
          name: { const: "merge_pull_request" },
          arguments: {
            type: "object",
            required: ["owner", "repo", "pullNumber", "baseRef", "expectedHeadSha", "mergeMethod"],
            properties: {
              owner: { type: "string" },
              repo: { type: "string" },
              pullNumber: { type: "integer" },
              baseRef: { type: "string" },
              expectedHeadSha: { type: "string" },
              mergeMethod: { type: "string", enum: ["merge", "squash", "rebase"] },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
    delete_branch: {
      description: "Delete a branch from a repository.",
      impact: "high",
      executionPayloadSchema: {
        type: "object",
        required: ["name", "arguments"],
        properties: {
          name: { const: "delete_branch" },
          arguments: {
            type: "object",
            required: ["owner", "repo", "branch"],
            properties: {
              owner: { type: "string" },
              repo: { type: "string" },
              branch: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
  },
};

const pluginArtifactDid = await computeArtifactDid(githubPlugin);

function signerKeys() {
  return [
    {
      did: keys.proposer.did,
      label: "Proposer Agent",
      publicJwk: keys.proposer.publicJwk,
    },
    {
      did: keys.maintainerA.did,
      label: "Maintainer A",
      publicJwk: keys.maintainerA.publicJwk,
    },
    {
      did: keys.maintainerB.did,
      label: "Maintainer B",
      publicJwk: keys.maintainerB.publicJwk,
    },
  ];
}

function makePolicy(overrides: { defaultRequirement?: Record<string, unknown>; policies?: Record<string, unknown[]> } = {}) {
  return {
    version: "1",
    type: "MpasApplicationPolicy",
    policyProfileUrl: "https://oma3.org/specs/mpas/policy-json/v1",
    applicationDid: githubPlugin.applicationDid,
    executionProfile: {
      id: "did:web:profiles.oma3.org:mcp",
      format: "mcp.toolsCall",
    },
    defaultRequirement: overrides.defaultRequirement ?? {
      type: "threshold",
      threshold: 1,
      eligibleSignerGroup: "maintainers",
      decision: "approve",
    },
    signerGroups: {
      all: [keys.proposer.did, keys.maintainerA.did, keys.maintainerB.did],
      proposers: [keys.proposer.did],
      maintainers: [keys.maintainerA.did, keys.maintainerB.did],
    },
    policies: overrides.policies ?? {},
  };
}

function baseDeploymentConfig(name: string, policy: ReturnType<typeof makePolicy>) {
  return {
    version: "1",
    type: "MpasAdapterDeploymentConfig",
    name,
    target: {
      applicationDid: githubPlugin.applicationDid,
    },
    plugin: {
      pluginDid: githubPlugin.pluginDid,
      pluginVersion: githubPlugin.pluginVersion,
      artifactDid: pluginArtifactDid,
      path: "../plugins/github-repo.json",
    },
    credentialBindings: [
      {
        credentialHandle: "github-test-token",
        provider: "file",
      },
    ],
    executionTarget: {
      type: "mcp.stdio",
      command: "node",
      args: ["tests/fixtures/adapter/echo-mcp-server.mjs"],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: "{{credential:github-test-token}}",
      },
    },
    policy,
    signerKeys: signerKeys(),
  };
}

const configs = {
  "github-auto-approve.json": baseDeploymentConfig(
    "github-auto-approve",
    makePolicy({ defaultRequirement: { type: "proposerOnly" } }),
  ),
  "github-strict.json": baseDeploymentConfig(
    "github-strict",
    makePolicy({
      policies: {
        merge_pull_request: [
          {
            description: "Merging into main requires two maintainer approvals.",
            match: {
              conditions: [
                { source: "executionPayload", path: "/arguments/baseRef", op: "eq", value: "main" },
              ],
            },
            requirements: {
              type: "threshold",
              threshold: 2,
              eligibleSignerGroup: "maintainers",
              decision: "approve",
            },
          },
        ],
        delete_branch: [
          {
            description: "Deleting a branch requires one maintainer approval.",
            requirements: {
              type: "threshold",
              threshold: 1,
              eligibleSignerGroup: "maintainers",
              decision: "approve",
            },
          },
        ],
      },
    }),
  ),
};

const coordinationFixtures = {
  "pending-action-request.json": {
    version: "1",
    type: "CoordinationActionRequest",
    actionPackageFixture: "../core/insufficient-approvals.json",
    authorizationRequirements: {
      version: "1",
      type: "AuthorizationRequirements",
      actionEnvelopeHash: insufficientApprovals.approvalBundle.actionEnvelopeHash,
      result: "additionalApprovalsRequired",
      verifier: {
        did: keys.adapter.did,
      },
      approvalRequirements: {
        anyOf: [
          {
            type: "threshold",
            threshold: 2,
            eligibleSigners: [keys.maintainerA.did, keys.maintainerB.did],
            decision: "approve",
            description: "Merging into main requires two maintainer approvals.",
          },
        ],
      },
    },
  },
  "poll-request-maintainer-a.json": {
    version: "1",
    type: "CoordinationPollRequest",
    did: keys.maintainerA.did,
  },
  "poll-response-awaiting.json": {
    version: "1",
    type: "CoordinationPollResponse",
    approvalRequests: [
      {
        version: "1",
        type: "ApprovalRequest",
        actionRef: {
          version: "1",
          type: "ActionReference",
          actionId: insufficientApprovals.actionEnvelope.actionId,
          actionEnvelopeHash: insufficientApprovals.approvalBundle.actionEnvelopeHash,
        },
        requestedDecision: "approve",
      },
    ],
    actionUpdates: [],
  },
  "cancel-request.json": {
    version: "1",
    type: "CoordinationCancelRequest",
    actionId: insufficientApprovals.actionEnvelope.actionId,
    proposerDid: keys.proposer.did,
  },
};

await mkdir(join(fixtureRoot, "core"), { recursive: true });
await mkdir(join(fixtureRoot, "test-keys"), { recursive: true });
await mkdir(join(fixtureRoot, "plugins"), { recursive: true });
await mkdir(join(fixtureRoot, "configs"), { recursive: true });
await mkdir(join(fixtureRoot, "coordination"), { recursive: true });

for (const [file, value] of Object.entries(packages)) {
  await writeFile(join(fixtureRoot, "core", file), `${JSON.stringify(value, null, 2)}\n`);
}

for (const [file, value] of Object.entries(invalidPackages)) {
  await writeFile(join(fixtureRoot, "core", file), `${JSON.stringify(value, null, 2)}\n`);
}

for (const key of Object.values(keys)) {
  await writeFile(join(fixtureRoot, "test-keys", `${key.label}.json`), `${JSON.stringify(key, null, 2)}\n`);
}

await writeFile(join(fixtureRoot, "plugins", "github-repo.json"), `${JSON.stringify(githubPlugin, null, 2)}\n`);

for (const [file, value] of Object.entries(configs)) {
  await writeFile(join(fixtureRoot, "configs", file), `${JSON.stringify(value, null, 2)}\n`);
}

for (const [file, value] of Object.entries(coordinationFixtures)) {
  await writeFile(join(fixtureRoot, "coordination", file), `${JSON.stringify(value, null, 2)}\n`);
}
}

void main();
