import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  ActionPackageBuilder, ApprovalBuilder, KeyManager, generateMpasKey, signMpasRfc9421,
  verifyExecutionReceipt, type ActionPackage, type Did,
} from "@oma3/mpas";
import { loadDeploymentConfigs } from "../../src/adapter/config-loader.js";
import { FileCredentialProvider } from "../../src/adapter/credential-provider.js";
import { createAdapterApiServer } from "../../src/adapter/adapter-api-server.js";
import { createCoordinationApiServer } from "../../src/coordination/coordination-api-server.js";
import { generateKeyFile, runCli } from "../../src/cli/index.js";

const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
const audience = "https://coordination.example.com";
async function signed(app: FastifyInstance, path: string, value: object, signer: KeyManager, nonce?: string) {
  const body = JSON.stringify({ ...value, audience });
  const headers = await signMpasRfc9421({ method: "POST", path, body: Buffer.from(body), signer, nonce });
  return app.inject({ method: "POST", url: path, payload: body, headers: { ...headers, "content-type": "application/mpas+json" } });
}

it("executes an authenticated mixed-suite workflow and verifies a P-256 receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpas-mixed-suites-"));
  const keys = await Promise.all(["P-256", "P-256", "Ed25519", "P-256"].map((id) => generateMpasKey(id as "P-256" | "Ed25519")));
  const [proposer, maintainerA, maintainerB, issuer] = keys.map((key) => KeyManager.fromJwk(key.privateJwk));
  let adapter: FastifyInstance | undefined;
  let coordination: FastifyInstance | undefined;
  try {
    const configDir = join(root, "config");
    const creds = join(root, "credentials");
    await mkdir(configDir); await mkdir(creds);
    const config = JSON.parse(await readFile(join(fixtures, "configs/github-mirror-adapter-config.json"), "utf8"));
    config.plugin.path = join(fixtures, "plugins/github-mirror-plugin.json");
    config.executionTarget.args = [join(fixtures, "adapter/echo-mcp-server.mjs")];
    config.signerKeys = [proposer, maintainerA, maintainerB].map((key) => ({ did: key.did, publicJwk: key.publicKey }));
    config.policy.signerGroups = { all: [proposer.did, maintainerA.did, maintainerB.did], proposers: [proposer.did], maintainers: [maintainerA.did, maintainerB.did] };
    const configPath = join(configDir, "mixed.json");
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(join(creds, "github-mirror-token.json"), JSON.stringify({ value: "fixture-only-token" }), { mode: 0o600 });
    const loaded = await loadDeploymentConfigs(configDir, { trustContext: null, confirmPluginUse: async () => true });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error.message);

    // The existing strict deployment schema rejects a suite allow-list. There
    // is no route for a service to configure Ed25519 or ES256 verification off.
    await writeFile(configPath, JSON.stringify({ ...config, acceptedSuites: ["P-256"] }));
    expect(await loadDeploymentConfigs(configDir, { trustContext: null, confirmPluginUse: async () => true })).toMatchObject({ ok: false, error: { code: "CONFIG_SCHEMA_INVALID" } });
    const mismatched = structuredClone(config);
    mismatched.signerKeys[0].publicJwk.y = maintainerA.publicKey.y;
    await writeFile(configPath, JSON.stringify(mismatched));
    expect(await loadDeploymentConfigs(configDir, { trustContext: null, confirmPluginUse: async () => true })).toMatchObject({ ok: false, error: { code: "CONFIG_SCHEMA_INVALID" } });

    adapter = createAdapterApiServer({ configsByApplicationDid: loaded.configsByApplicationDid, credentialProvider: new FileCredentialProvider(creds), adapterDid: issuer.did, adapterSigner: issuer });
    coordination = createCoordinationApiServer({ auth: { enforcement: true, audiences: [audience] } });
    const builder = new ActionPackageBuilder({ applicationDid: config.target.applicationDid, executionProfile: config.policy.executionProfile, signer: proposer });
    const action = await builder.buildFromToolCall("merge_pull_request_mirror", { owner: "example-org", repo: "mpas-demo-repository", pullNumber: 42, baseRef: "main", expectedHeadSha: "abc123", mergeMethod: "squash" });
    const initial = await signed(adapter, "/mpas/v1/action", { version: "1", type: "ActionRequest", actionPackage: action }, proposer);
    expect(initial.json().result).toBe("additionalApprovalsRequired");
    const replacement = await builder.buildCoordinationReplacement(action, initial.json().authorizationRequirements);
    const workflow = await signed(coordination, "/mpas/v1/coordination/workflow", { version: "1", type: "CoordinationActionRequest", ...replacement }, proposer);
    expect(workflow.statusCode).toBe(201);
    const intruder = KeyManager.fromJwk((await generateMpasKey("P-256")).privateJwk);
    const illicit = await new ApprovalBuilder({ signer: intruder }).buildApproval(replacement.actionPackage.actionEnvelope, "approve");
    expect((await signed(coordination, "/mpas/v1/coordination/approval", { version: "1", type: "CoordinationApprovalSubmission", actionEnvelopeHash: illicit.actionEnvelopeHash, approval: illicit }, intruder)).statusCode).toBe(403);

    for (const maintainer of [maintainerA, maintainerB]) {
      const poll = await signed(coordination, "/mpas/v1/coordination/poll", { version: "1", type: "CoordinationPollRequest", did: maintainer.did }, maintainer);
      expect(poll.statusCode).toBe(200);
      expect(poll.json().approvalRequests).toHaveLength(1);
      const approval = await new ApprovalBuilder({ signer: maintainer }).buildApproval(replacement.actionPackage.actionEnvelope, "approve");
      const value = { version: "1", type: "CoordinationApprovalSubmission", actionEnvelopeHash: approval.actionEnvelopeHash, approval };
      expect((await signed(coordination, "/mpas/v1/coordination/approval", value, maintainer, `nonce-${maintainer.algorithm}`)).statusCode).toBe(200);
      expect((await signed(coordination, "/mpas/v1/coordination/approval", value, maintainer, `nonce-${maintainer.algorithm}`)).statusCode).toBe(401);
    }
    const poll = await signed(coordination, "/mpas/v1/coordination/poll", { version: "1", type: "CoordinationPollRequest", did: proposer.did }, proposer);
    const update = poll.json().actionUpdates[0];
    expect(update.state).toBe("readyForSubmission");
    const ready = update.actionPackage as ActionPackage;
    expect(ready.approvalBundle.approvals).toHaveLength(3);
    const result = await signed(adapter, "/mpas/v1/action", { version: "1", type: "ActionRequest", actionPackage: ready }, proposer);
    expect(result.json().result).toBe("executed");
    const receipt = result.json().executionReceipt;
    expect(receipt).toBeDefined();
    expect(await verifyExecutionReceipt(receipt, { verifier: { did: issuer.did }, actionEnvelope: ready.actionEnvelope, executionPayload: ready.executionPayload })).toBe(true);
    const replay = await signed(adapter, "/mpas/v1/action", { version: "1", type: "ActionRequest", actionPackage: ready }, proposer);
    expect(replay.json().result).toBe("rejected");
  } finally {
    await adapter?.close(); await coordination?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("selects P-256 explicitly in CLI generation and never replaces an existing identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpas-suite-cli-"));
  try {
    const p256 = await generateKeyFile("p256", root, "P-256");
    expect(p256.publicJwk.crv).toBe("P-256");
    expect((await generateKeyFile("baseline", root)).publicJwk.crv).toBe("Ed25519");
    await expect(generateKeyFile("p256", root)).rejects.toThrow();
    expect((await KeyManager.fromFile(p256.path)).did).toBe(p256.did);
    const output = { write: (_value: string | Uint8Array) => true };
    const result = await runCli(["key", "generate", "bad", "--suite", "ES256K", "--key-dir", root], { stdout: output, stderr: output });
    expect(result.exitCode).not.toBe(0);
    const success = await runCli(["key", "generate", "explicit", "--suite", "P-256", "--key-dir", root], { stdout: output, stderr: output });
    expect(success.exitCode).toBe(0);
    expect((await KeyManager.fromFile(join(root, "explicit.json"))).algorithm).toBe("ES256");
  } finally { await rm(root, { recursive: true, force: true }); }
});
