import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CompactSign, importJWK } from "jose";
import { canonicalize } from "json-canonicalize";
import { computeArtifactDid } from "../../src/adapter/config-loader.js";
import { deriveDidJwk, didJwkToKid } from "@oma3/mpas";

const keyMaterial = {
  proposer: {
    label: "proposer",
    d: "UA1VsxVt4yqqnFyc4xENa10rWJOqNnWO27v-f1_nUmk",
    x: "k6O7ciQkmphuEEt1i3yAimJJWeGKmOq3t_fsNkzza6o",
  },
  maintainerA: {
    label: "maintainer-a",
    d: "kSRUeh59TL7vVxo6oeJL0SvujeYlqP_ICEu6urlNrs0",
    x: "8sDV76b8iF76PImAw5I9Wvejs_8bS8N12WvHzPa5Vw8",
  },
  maintainerB: {
    label: "maintainer-b",
    d: "NKLetLnK0SqzMfy0m3EftV1H6SOgYdo2AJEnW170Hbk",
    x: "4v8kxXJiFpCHpVxWxHRQLLq0bjIlUF-sE1UINoy50-8",
  },
  adapter: {
    label: "adapter",
    d: "_yARgWiyVyU1gZkULFUI9FZFhAqsyrsbr9dTbnhsG7o",
    x: "SSvpiqWWoPEAtuMhB0GxgCm-N8AGHu-_x9qGbRh0t1I",
  },
};

function makeKey({ label, d, x }: { label: string; d: string; x: string }) {
  const basePublicJwk = { crv: "Ed25519", x, kty: "OKP", alg: "EdDSA", use: "sig" };
  // The DID is minted from the key (JCS-canonical minimal public JWK) and is
  // the identifier of record from then on; the kid fragment is always #0.
  const did = deriveDidJwk(basePublicJwk);
  const kid = didJwkToKid(did);
  return {
    label,
    did,
    kid,
    privateJwk: { crv: "Ed25519", d, x, kty: "OKP", alg: "EdDSA", use: "sig", kid },
    publicJwk: { ...basePublicJwk, kid },
  };
}

const keys = {
  proposer: makeKey(keyMaterial.proposer),
  maintainerA: makeKey(keyMaterial.maintainerA),
  maintainerB: makeKey(keyMaterial.maintainerB),
  adapter: makeKey(keyMaterial.adapter),
};

function hashJson(value: unknown) {
  return {
    alg: "sha-256",
    value: createHash("sha256").update(canonicalize(value)).digest("base64url"),
  };
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
  applicationDid = "did:web:github-mirror.example",
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
/** Operator-facing artifacts the setup guide copies into $MPAS_HOME. */
const demoRoot = process.cwd();

const packages = {
  "valid-no-approval-required.json": await makeActionPackage({
    payload: {
      name: "create_issue_mirror",
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
      name: "merge_pull_request_mirror",
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
      name: "delete_branch_mirror",
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
    name: "merge_pull_request_mirror",
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
    name: "create_issue_mirror",
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
    name: "delete_branch_mirror",
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
    name: "create_issue_mirror",
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
    name: "create_issue_mirror",
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

/**
 * The demo ships two distinct MPAS applications sharing one operation set:
 *
 * - **mirror** — dry-run simulator (echo server). No credentials, no side effects.
 * - **live demo** — dispatches to real GitHub via the demo MCP server.
 *
 * They MUST NOT share an applicationDid: an Approval is bound to an Action
 * Envelope, which names its application, so a shared DID would make an approval
 * collected during dry-run testing valid against live GitHub. Distinct DIDs also
 * let the adapter route to the right config — it indexes solely by
 * target.applicationDid.
 *
 * Tool names carry the variant suffix so both bridges can be registered at once
 * without ambiguity in traces and logs.
 */
interface DemoVariant {
  suffix: "_mirror" | "_demo";
  applicationDid: string;
  pluginDid: string;
  pluginFile: string;
  credentialHandle: string;
  upstreamServer: string;
}

const VARIANTS = {
  mirror: {
    suffix: "_mirror",
    applicationDid: "did:web:github-mirror.example",
    pluginDid: "did:web:plugins.oma3.org:github-mirror-plugin",
    pluginFile: "github-mirror-plugin.json",
    credentialHandle: "github-mirror-token",
    upstreamServer: "tests/fixtures/adapter/echo-mcp-server.mjs",
  },
  liveDemo: {
    suffix: "_demo",
    applicationDid: "did:web:github-live-demo.example",
    pluginDid: "did:web:plugins.oma3.org:github-live-demo-plugin",
    pluginFile: "github-live-demo-plugin.json",
    credentialHandle: "github-live-demo-token",
    upstreamServer: "tests/fixtures/adapter/github-mcp-server.mjs",
  },
} as const satisfies Record<string, DemoVariant>;

function makeGithubPlugin(variant: DemoVariant) {
  const deleteBranch = `delete_branch${variant.suffix}`;
  const mergePullRequest = `merge_pull_request${variant.suffix}`;
  return {
    version: "1",
    type: "MpasApplicationPlugin",
    pluginDid: variant.pluginDid,
    pluginVersion: "0.1.0",
    publisherDid: "did:web:oma3.org",
    applicationDid: variant.applicationDid,
    executionProfile: {
      id: "did:web:profiles.oma3.org:mcp",
      format: "mcp.toolsCall",
      protocolVersion: "2024-11-05",
    },
    credentialRequirements: [
      {
        type: "oauthToken",
        requiredCapabilities: ["issue.write", "pullRequest.merge", "pullRequest.read", "branch.delete"],
        description: "GitHub OAuth token with repository access for configured repositories.",
      },
    ],
    operations: {
      [deleteBranch]: {
        description: "Delete a branch from a GitHub repository.",
        impact: "critical",
        executionPayloadSchema: {
          type: "object",
          required: ["name", "arguments"],
          properties: {
            name: { const: deleteBranch },
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
      [mergePullRequest]: {
        description: "Merge a pull request into its base branch.",
        impact: "high",
        executionPayloadSchema: {
          type: "object",
          required: ["name", "arguments"],
          properties: {
            name: { const: mergePullRequest },
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
    },
  };
}


/**
 * Upstream tool surface each variant's MCP server exposes. The bridge preserves
 * these names exactly (client profile §3.1); `create_issue*` is deliberately
 * ungoverned to demonstrate the pass-through boundary.
 */
function makeBridgeTools(variant: DemoVariant) {
  const s = variant.suffix;
  return [
    {
      name: `create_issue${s}`,
      description: "Create a new issue in a GitHub repository.",
      inputSchema: {
        type: "object",
        required: ["owner", "repo", "title"],
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          labels: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    },
    {
      name: `delete_branch${s}`,
      description: "Delete a branch from a GitHub repository.",
      inputSchema: {
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
    {
      name: `merge_pull_request${s}`,
      description: "Merge a pull request.",
      inputSchema: {
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
  ];
}

const mirrorPlugin = makeGithubPlugin(VARIANTS.mirror);
const liveDemoPlugin = makeGithubPlugin(VARIANTS.liveDemo);
/** Unit-test fixtures and signed Action Packages are built against the mirror. */
const githubPlugin = mirrorPlugin;

const mirrorArtifactDid = await computeArtifactDid(mirrorPlugin);
const liveDemoArtifactDid = await computeArtifactDid(liveDemoPlugin);
const pluginArtifactDid = mirrorArtifactDid;

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

function makePolicy(
  variant: DemoVariant,
  overrides: { defaultRequirement?: Record<string, unknown>; policies?: Record<string, unknown[]> } = {},
) {
  return {
    version: "1",
    type: "MpasApplicationPolicy",
    policyProfileUrl: "https://github.com/oma3dao/mpas/blob/main/specs/mpas-profile-policy-json.md",
    applicationDid: variant.applicationDid,
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

function baseDeploymentConfig(variant: DemoVariant, name: string, policy: ReturnType<typeof makePolicy>) {
  const plugin = variant.suffix === "_mirror" ? mirrorPlugin : liveDemoPlugin;
  const artifactDid = variant.suffix === "_mirror" ? mirrorArtifactDid : liveDemoArtifactDid;
  return {
    version: "1",
    type: "MpasAdapterDeploymentConfig",
    name,
    target: {
      applicationDid: variant.applicationDid,
    },
    plugin: {
      pluginDid: plugin.pluginDid,
      pluginVersion: plugin.pluginVersion,
      artifactDid,
      path: `../plugins/${variant.pluginFile}`,
    },
    credentialBindings: [
      {
        credentialHandle: variant.credentialHandle,
        provider: "file",
      },
    ],
    executionTarget: {
      type: "mcp.stdio",
      command: "node",
      args: [variant.upstreamServer],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: `{{credential:${variant.credentialHandle}}}`,
      },
    },
    policy,
    signerKeys: signerKeys(),
  };
}

/** The demo policy, identical for both variants apart from operation names. */
function demoPolicy(variant: DemoVariant) {
  return makePolicy(variant, {
    policies: {
      [`merge_pull_request${variant.suffix}`]: [
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
      [`delete_branch${variant.suffix}`]: [
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
  });
}

const configs = {
  "github-auto-approve.json": baseDeploymentConfig(
    VARIANTS.mirror,
    "github-auto-approve",
    makePolicy(VARIANTS.mirror, { defaultRequirement: { type: "proposerOnly" } }),
  ),
  "github-mirror-adapter-config.json": baseDeploymentConfig(
    VARIANTS.mirror,
    "github-mirror",
    demoPolicy(VARIANTS.mirror),
  ),
  "github-live-demo-adapter-config.json": baseDeploymentConfig(
    VARIANTS.liveDemo,
    "github-live-demo",
    demoPolicy(VARIANTS.liveDemo),
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

for (const key of Object.values(keys)) {
  await writeFile(
    join(fixtureRoot, "test-keys", `${key.label}.json`),
    `${JSON.stringify({ label: key.label, did: key.did, kid: key.kid, privateJwk: key.privateJwk, publicJwk: key.publicJwk }, null, 2)}\n`,
  );
}
await mkdir(join(fixtureRoot, "plugins"), { recursive: true });
await mkdir(join(fixtureRoot, "configs"), { recursive: true });
await mkdir(join(fixtureRoot, "coordination"), { recursive: true });

for (const [file, value] of Object.entries(packages)) {
  await writeFile(join(fixtureRoot, "core", file), `${JSON.stringify(value, null, 2)}\n`);
}

for (const [file, value] of Object.entries(invalidPackages)) {
  await writeFile(join(fixtureRoot, "core", file), `${JSON.stringify(value, null, 2)}\n`);
}

for (const plugin of [mirrorPlugin, liveDemoPlugin]) {
  const file = plugin === mirrorPlugin ? VARIANTS.mirror.pluginFile : VARIANTS.liveDemo.pluginFile;
  await writeFile(join(fixtureRoot, "plugins", file), `${JSON.stringify(plugin, null, 2)}\n`);
}

const POLICY_FIXTURE_CONFIGS = new Set(["github-auto-approve.json"]);
const OPERATOR_CONFIGS = ["github-mirror-adapter-config.json", "github-live-demo-adapter-config.json"];

await mkdir(join(fixtureRoot, "configs", "policy-fixtures"), { recursive: true });
for (const [file, value] of Object.entries(configs)) {
  const dir = POLICY_FIXTURE_CONFIGS.has(file)
    ? join(fixtureRoot, "configs", "policy-fixtures")
    : join(fixtureRoot, "configs");
  await writeFile(join(dir, file), `${JSON.stringify(value, null, 2)}\n`);
}

// Operator-facing copies. The setup guide copies these into $MPAS_HOME; keeping
// them generated (rather than hand-synced) is what stops them drifting from the
// plugin they bind to and from each other.
await mkdir(join(demoRoot, "plugins"), { recursive: true });
await mkdir(join(demoRoot, "configs"), { recursive: true });
for (const plugin of [mirrorPlugin, liveDemoPlugin]) {
  const file = plugin === mirrorPlugin ? VARIANTS.mirror.pluginFile : VARIANTS.liveDemo.pluginFile;
  await writeFile(join(demoRoot, "plugins", file), `${JSON.stringify(plugin, null, 2)}\n`);
}
/**
 * The e2e harness has its own policy: richer requirement descriptions (asserted
 * by the tests) and an operator-added rule for an operation the plugin does not
 * govern, which exercises the pass-through boundary. Generated so its plugin
 * reference and artifactDid cannot drift.
 */
function e2ePolicy(variant: DemoVariant) {
  const threshold = (n: number, description: string) => ({
    type: "threshold",
    threshold: n,
    eligibleSignerGroup: "maintainers",
    decision: "approve",
    description,
  });
  return {
    ...makePolicy(variant, {
      policies: {
        [`delete_branch${variant.suffix}`]: [
          {
            description: "Deleting a branch requires one maintainer approval.",
            requirements: threshold(1, "Branch deletion: requires 1 maintainer approval."),
          },
        ],
        [`merge_pull_request${variant.suffix}`]: [
          {
            description: "Merging requires two maintainer approvals.",
            requirements: threshold(2, "PR merge: requires 2 maintainer approvals."),
          },
        ],
        [`close_issue${variant.suffix}`]: [
          {
            description: "Operator-added policy: closing issues requires one maintainer approval.",
            requirements: threshold(
              1,
              `Operator policy (close_issue${variant.suffix}): requires 1 maintainer approval.`,
            ),
          },
        ],
      },
    }),
    defaultRequirement: {
      type: "threshold",
      threshold: 1,
      eligibleSignerGroup: "maintainers",
      decision: "approve",
      description: "Default policy: requires 1 maintainer approval.",
    },
  };
}

await mkdir(join(fixtureRoot, "configs", "e2e"), { recursive: true });
const e2eBase = baseDeploymentConfig(VARIANTS.mirror, "github-e2e", e2ePolicy(VARIANTS.mirror));
const e2eConfig = {
  ...e2eBase,
  plugin: { ...e2eBase.plugin, path: `../../plugins/${VARIANTS.mirror.pluginFile}` },
};
await writeFile(join(fixtureRoot, "configs", "e2e", "github-e2e.json"), `${JSON.stringify(e2eConfig, null, 2)}\n`);

await mkdir(join(demoRoot, "bridge-tools"), { recursive: true });
for (const [key, variant] of Object.entries(VARIANTS)) {
  const file = key === "mirror" ? "github-mirror-tools.json" : "github-live-demo-tools.json";
  await writeFile(join(demoRoot, "bridge-tools", file), `${JSON.stringify(makeBridgeTools(variant), null, 2)}\n`);
}
for (const file of OPERATOR_CONFIGS) {
  await writeFile(join(demoRoot, "configs", file), `${JSON.stringify(configs[file as keyof typeof configs], null, 2)}\n`);
}

for (const [file, value] of Object.entries(coordinationFixtures)) {
  await writeFile(join(fixtureRoot, "coordination", file), `${JSON.stringify(value, null, 2)}\n`);
}
}

void main();
