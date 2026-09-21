import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { computeJsonHash } from "@oma3/mpas/hash";
import { verifyMpasRfc9421, type CoordinationActionUpdate } from "@oma3/mpas";
import { SignerServer } from "../../src/signer-server/index.js";
import type { Approval, CoordinationPollResponse, SignerReviewSet } from "../../src/signer-server/types.js";

const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const testKeysDir = fileURLToPath(new URL("../fixtures/test-keys/", import.meta.url));

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("SignerServer", () => {
  it.each(["direct", "MCP"])("rejects malformed action updates through %s before submission", async transport => {
    const mutations: Array<[string, (update: Record<string, unknown>) => unknown]> = [
      ["null", () => null], ["undeclared member", update => ({ ...update, extra: true })],
      ["missing expiry", update => { delete update.expiresAt; return update; }],
      ["invalid expiry", update => ({ ...update, expiresAt: "2030" })],
      ["malformed reference", update => ({ ...update, actionRef: null })],
      ["malformed hash", update => ({ ...update, actionRef: { ...(update.actionRef as object), actionEnvelopeHash: null } })],
      ["malformed progress", update => ({ ...update, progress: { required: -1, collected: 0, pending: [] } })],
      ["ready without package", update => ({ ...update, state: "readyForSubmission" })],
      ["cancelled with progress", update => ({ ...update, state: "cancelled", cancelledAt: "2026-09-04T00:00:00.000Z" })],
      ["rejected without time", update => ({ ...update, state: "rejected" })],
    ];
    for (const [label, mutate] of mutations) for (const tool of ["mpas_list_pending", "mpas_review_action", "mpas_approve"]) {
      const poll = await readJson<CoordinationPollResponse>(join(fixturesDir, "responses", "coordination-pending-actions.json"));
      const request = poll.approvalRequests[0];
      poll.actionUpdates = [mutate({ version: "1", type: "CoordinationActionUpdate", state: "awaitingApprovals",
        actionRef: request.actionRef, expiresAt: request.signerReviewSet.actionEnvelope.expiresAt,
        progress: { required: 1, collected: 0, pending: [] } }) as CoordinationActionUpdate];
      const { result, submissions, verifiedPolls } = await callSignerFixture(poll, tool, request.actionRef.actionId.value, transport === "MCP");
      expect(verifiedPolls, label).toBe(1);
      expect(submissions, label).toBe(0);
      expect(result.isError, label).toBe(true);
      expect(result.structuredContent, label).toEqual({ code: "COORDINATION_RESPONSE_INVALID", message: expect.any(String) });
    }
  });

  it.each(["direct", "MCP"])("preserves valid mixed participant responses through %s", async transport => {
    for (const state of ["awaitingApprovals", "readyForSubmission", "executed", "rejected", "cancelled", "expired"] as const) {
      const poll = await readJson<CoordinationPollResponse>(join(fixturesDir, "responses", "coordination-pending-actions.json"));
      const request = poll.approvalRequests[0];
      const actionEnvelopeHash = request.actionRef.actionEnvelopeHash;
      const update: CoordinationActionUpdate = { version: "1", type: "CoordinationActionUpdate", state,
        actionRef: request.actionRef, expiresAt: request.signerReviewSet.actionEnvelope.expiresAt,
        ...(state === "cancelled" ? { cancelledAt: "2026-09-04T00:00:00.000Z" } : { progress: { required: 1, collected: 0, pending: [] } }),
        ...(state === "rejected" ? { rejectedAt: "2026-09-04T00:00:00.000Z" } : {}) };
      if (state === "readyForSubmission") update.actionPackage = { version: "1", type: "ActionPackage",
        executionPayload: request.signerReviewSet.executionPayload, actionEnvelope: request.signerReviewSet.actionEnvelope,
        // This is a structural package control, not a cryptographic approval claim.
        approvalBundle: { version: "1", type: "ApprovalBundle", actionEnvelopeHash, approvals: [{ version: "1", type: "Approval",
          actionEnvelopeHash, decision: "approve", createdAt: "2026-09-04T00:00:00.000Z", signature: { format: "jws", value: "e30.e30.c2ln" } }] } };
      poll.actionUpdates = [update];
      const { result, submissions, verifiedPolls } = await callSignerFixture(poll, "mpas_list_pending", "", transport === "MCP");
      expect(result.isError, state).toBeUndefined();
      expect(result.structuredContent, state).toEqual({ approvalRequests: poll.approvalRequests });
      expect(submissions, state).toBe(0);
      expect(verifiedPolls, state).toBe(1);
    }
  });

  it.each(["direct", "MCP"].flatMap(transport =>
    ["mpas_list_pending", "mpas_review_action", "mpas_approve", "mpas_reject"].map(tool => [transport, tool]),
  ))("rejects undeclared poll wrapper members through %s for %s before submission", async (transport, tool) => {
    const poll = await readJson<CoordinationPollResponse>(join(fixturesDir, "responses", "coordination-pending-actions.json"));
    const request = poll.approvalRequests[0];
    if (tool === "mpas_reject") {
      request.requestedDecision = "reject";
      const auth = request.signerReviewSet.authorizationRequirements;
      if (auth?.result !== "additionalApprovalsRequired") throw new Error("Missing fixture path");
      auth.approvalRequirements.anyOf![0].decision = "reject";
    }
    Object.assign(poll, { extra: true });
    const { result, submissions } = await callSignerFixture(poll, tool, request.actionRef.actionId.value, transport === "MCP");
    expect(submissions).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ code: "COORDINATION_RESPONSE_INVALID", message: expect.any(String) });
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: expect.stringContaining("COORDINATION_RESPONSE_INVALID") }),
    ]));
  });

  it.each(["direct", "MCP"].flatMap(transport => [true, false].map(updates => [transport, updates] as const)))
    ("accepts an empty pending list through %s with action updates present: %s", async (transport, updates) => {
      const poll = { version: "1", type: "CoordinationPollResponse", approvalRequests: [], ...(updates ? { actionUpdates: [] } : {}) } as CoordinationPollResponse;
      const { result, submissions } = await callSignerFixture(poll, "mpas_list_pending", "", transport === "MCP");
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({ approvalRequests: [] });
      expect(submissions).toBe(0);
    });

  it.each(["direct", "MCP"])("returns closed errors through %s for malformed review data before submission", async (transport) => {
    const cases: Array<[string, string, unknown, string]> = [
      ["null request", "", null, "COORDINATION_RESPONSE_INVALID"],
      ["incomplete request", "", {}, "COORDINATION_RESPONSE_INVALID"],
      ["missing expiry", "signerReviewSet.actionEnvelope.expiresAt", undefined, "ACTION_EXPIRED"],
      ["year-only expiry", "signerReviewSet.actionEnvelope.expiresAt", "2030", "ACTION_EXPIRED"],
      ["impossible date", "signerReviewSet.actionEnvelope.expiresAt", "2030-02-30T00:00:00.000Z", "ACTION_EXPIRED"],
      ["missing milliseconds", "signerReviewSet.actionEnvelope.expiresAt", "2030-01-01T00:00:00Z", "ACTION_EXPIRED"],
      ["expired", "signerReviewSet.actionEnvelope.expiresAt", "2020-01-01T00:00:00.000Z", "ACTION_EXPIRED"],
      ["null optional expiry", "signerReviewSet.expiresAt", null, "ACTION_EXPIRED"],
      ["malformed requirements expiry", "signerReviewSet.authorizationRequirements.expiresAt", "2030", "ACTION_EXPIRED"],
      ["missing payload hash", "signerReviewSet.actionEnvelope.executionPayloadHash", undefined, "REVIEW_SET_INTEGRITY_ERROR"],
      ["null payload hash", "signerReviewSet.actionEnvelope.executionPayloadHash", null, "REVIEW_SET_INTEGRITY_ERROR"],
      ["missing paths", "signerReviewSet.authorizationRequirements.approvalRequirements", undefined, "REVIEW_SET_INTEGRITY_ERROR"],
      ["null paths", "signerReviewSet.authorizationRequirements.approvalRequirements", null, "REVIEW_SET_INTEGRITY_ERROR"],
      ["empty paths", "signerReviewSet.authorizationRequirements.approvalRequirements", {}, "REVIEW_SET_INTEGRITY_ERROR"],
      ["malformed threshold", "signerReviewSet.authorizationRequirements.approvalRequirements.anyOf", [{}], "REVIEW_SET_INTEGRITY_ERROR"],
      ["undeclared reference", "actionRef.extra", true, "COORDINATION_RESPONSE_INVALID"],
      ["undeclared ID", "actionRef.actionId.extra", true, "COORDINATION_RESPONSE_INVALID"],
      ["bad scope type", "actionRef.actionId.scope", {}, "COORDINATION_RESPONSE_INVALID"],
      ["bad hash encoding", "actionRef.actionEnvelopeHash.value", "bad=", "REVIEW_SET_INTEGRITY_ERROR"],
    ];
    for (const [label, field, value, expected] of cases) {
      for (const tool of ["mpas_review_action", "mpas_approve"]) {
        const poll = await readJson<CoordinationPollResponse>(join(fixturesDir, "responses", "coordination-pending-actions.json"));
        const actionId = poll.approvalRequests[0].actionRef.actionId.value;
        if (field === "") (poll.approvalRequests as unknown[])[0] = value;
        else {
          const parts = field.split(".");
          let object = poll.approvalRequests[0] as unknown as Record<string, unknown>;
          for (const part of parts.slice(0, -1)) object = object[part] as Record<string, unknown>;
          if (value === undefined) delete object[parts.at(-1)!];
          else object[parts.at(-1)!] = value;
          if (field.startsWith("signerReviewSet.actionEnvelope.")) {
            const hash = computeJsonHash(poll.approvalRequests[0].signerReviewSet.actionEnvelope);
            poll.approvalRequests[0].actionRef.actionEnvelopeHash = hash;
            poll.approvalRequests[0].signerReviewSet.authorizationRequirements!.actionEnvelopeHash = hash;
          }
        }
        const { result, submissions } = await callSignerFixture(poll, tool, actionId, transport === "MCP");
        expect(result, label).toMatchObject({ isError: true, structuredContent: { code: expected } });
        expect(Object.keys(result.structuredContent ?? {}).sort(), label).toEqual(["code", "message"]);
        expect(submissions, label).toBe(0);
      }
    }
  });

  it.each(["direct", "MCP"])("maps 401/403 authentication failures through %s without leaking response data", async (transport) => {
    for (const status of [401, 403]) for (const phase of ["poll", "approval"]) {
      const poll = await readJson<CoordinationPollResponse>(join(fixturesDir, "responses", "coordination-pending-actions.json"));
      const { result, submissions } = await callSignerFixture(poll, "mpas_approve", poll.approvalRequests[0].actionRef.actionId.value,
        transport === "MCP", undefined, phase === "poll" ? status : 200, phase === "approval" ? status : 200);
      expect(result).toMatchObject({ isError: true, structuredContent: { code: "COORDINATION_RESPONSE_INVALID" } });
      expect(JSON.stringify(result)).not.toContain("synthetic-secret");
      expect(submissions).toBe(phase === "approval" ? 1 : 0);
    }
  });

  it.each(["direct", "MCP"])("binds complete scoped Action IDs through %s", async (transport) => {
    for (const mismatch of ["none", "review", "response", "nested-response"]) {
      const poll = await readJson<CoordinationPollResponse>(join(fixturesDir, "responses", "coordination-pending-actions.json"));
      const request = poll.approvalRequests[0];
      request.actionRef.actionId = { value: "42", scope: "eip155:1:0x1234567890abcdef1234567890abcdef12345678" };
      request.signerReviewSet.actionEnvelope.actionId = { ...request.actionRef.actionId };
      const otherScope = "eip155:2:0x1234567890abcdef1234567890abcdef12345678";
      if (mismatch === "review") request.signerReviewSet.actionEnvelope.actionId.scope = otherScope;
      const hash = computeJsonHash(request.signerReviewSet.actionEnvelope);
      request.actionRef.actionEnvelopeHash = hash;
      request.signerReviewSet.authorizationRequirements!.actionEnvelopeHash = hash;
      const replyRef = structuredClone(request.actionRef);
      if (mismatch === "response") replyRef.actionId.scope = otherScope;
      if (mismatch === "nested-response") Object.assign(replyRef.actionEnvelopeHash, { extra: true });
      const { result, submissions } = await callSignerFixture(poll, "mpas_approve", "42", transport === "MCP", replyRef);
      if (mismatch === "none") expect(result.isError).toBeUndefined();
      else expect(result).toMatchObject({ isError: true, structuredContent: {
        code: mismatch === "review" ? "REVIEW_SET_INTEGRITY_ERROR" : "COORDINATION_RESPONSE_INVALID",
      } });
      expect(submissions).toBe(mismatch === "review" ? 0 : 1);
    }
  });

  it("uses Core's approve default but never treats it as rejection eligibility", async () => {
    for (const decision of ["approve", "reject"] as const) {
      const poll = await readJson<CoordinationPollResponse>(join(fixturesDir, "responses", "coordination-pending-actions.json"));
      const request = poll.approvalRequests[0];
      request.requestedDecision = decision;
      const auth = request.signerReviewSet.authorizationRequirements;
      if (auth?.result !== "additionalApprovalsRequired") throw new Error("Missing fixture path");
      delete auth.approvalRequirements.anyOf![0].decision;
      const { result, submissions } = await callSignerFixture(poll, `mpas_${decision}`, request.actionRef.actionId.value, true);
      if (decision === "approve") expect(result.isError).toBeUndefined();
      else expect(result).toMatchObject({ isError: true, structuredContent: { code: "SIGNER_NOT_ELIGIBLE" } });
      expect(submissions).toBe(decision === "approve" ? 1 : 0);
    }
  });

  it("registers 4 signer tools", async () => {
    const server = new SignerServer({
      signerKey: join(testKeysDir, "maintainer-a.json"),
      coordinationUrl: "http://127.0.0.1:1",
    });

    const tools = server.getToolDefinitions();
    expect(tools.map((tool) => tool.name)).toEqual([
      "mpas_list_pending",
      "mpas_review_action",
      "mpas_approve",
      "mpas_reject",
    ]);
    expect(tools[0].inputSchema).toMatchObject({ additionalProperties: false });
    expect(tools[1].inputSchema).toMatchObject({
      required: ["actionId"],
      properties: { actionId: { type: "string", minLength: 1 } },
      additionalProperties: false,
    });
    for (const tool of tools) {
      expect(tool.outputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it.each([
    ["mpas_list_pending", { unexpected: true }],
    ["mpas_review_action", {}],
    ["mpas_approve", { actionId: "" }],
    ["mpas_reject", { actionId: "a", extra: true }],
  ])("rejects closed-input violation for %s", async (toolName, args) => {
    const server = new SignerServer({
      signerKey: join(testKeysDir, "maintainer-a.json"),
      coordinationUrl: "http://127.0.0.1:1",
    });

    const result = await server.handleToolCall(toolName, args);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: "SIGNER_INPUT_INVALID",
      message: expect.any(String),
    });
    expect(Object.keys(result.structuredContent ?? {}).sort()).toEqual(["code", "message"]);
  });

  it("lists pending actions from coordination", async () => {
    const pollResponse = await readJson<CoordinationPollResponse>(
      join(fixturesDir, "responses", "coordination-pending-actions.json"),
    );
    const coordination = await startMockCoordination((_request, response) => {
      sendJson(response, pollResponse);
    });

    try {
      const server = new SignerServer({
        signerKey: join(testKeysDir, "maintainer-a.json"),
        coordinationUrl: coordination.url,
      });
      const result = await server.handleToolCall("mpas_list_pending", {});

      expect(result.structuredContent).toEqual({ approvalRequests: pollResponse.approvalRequests });
    } finally {
      await coordination.close();
    }
  });

  it("returns verified review data", async () => {
    const pollResponse = await readJson<CoordinationPollResponse>(
      join(fixturesDir, "responses", "coordination-pending-actions.json"),
    );
    const reviewSet = pollResponse.approvalRequests[0].signerReviewSet;
    const coordination = await startMockCoordination((_request, response) => {
      sendJson(response, pollResponse);
    });

    try {
      const server = new SignerServer({
        signerKey: join(testKeysDir, "maintainer-a.json"),
        coordinationUrl: coordination.url,
      });
      const result = await server.handleToolCall("mpas_review_action", {
        actionId: reviewSet.actionEnvelope.actionId.value,
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({ approvalRequest: pollResponse.approvalRequests[0], reviewSet });
    } finally {
      await coordination.close();
    }
  });

  it("builds and submits approvals", async () => {
    const pollResponse = await readJson<CoordinationPollResponse>(
      join(fixturesDir, "responses", "coordination-pending-actions.json"),
    );
    const reviewSet = pollResponse.approvalRequests[0].signerReviewSet;
    let submittedApproval: Approval | undefined;
    let submittedHash: unknown;
    const coordination = await startMockCoordination(async (request, response) => {
      if (request.url === "/mpas/v1/coordination/poll") {
        sendJson(response, pollResponse);
        return;
      }
      if (request.url === "/mpas/v1/coordination/approval") {
        const body = JSON.parse(await readRequestBody(request)) as { actionEnvelopeHash: unknown; approval: Approval };
        submittedApproval = body.approval;
        submittedHash = body.actionEnvelopeHash;
        sendJson(response, {
          version: "1",
          type: "CoordinationApprovalSubmissionResponse",
          accepted: true,
          actionRef: pollResponse.approvalRequests[0].actionRef,
          state: "awaitingApprovals",
          createdAt: "2026-06-05T18:20:00.000Z",
        });
        return;
      }
      response.statusCode = 404;
      response.end();
    });

    try {
      const server = new SignerServer({
        signerKey: join(testKeysDir, "maintainer-a.json"),
        coordinationUrl: coordination.url,
      });
      const result = await server.handleToolCall("mpas_approve", {
        actionId: reviewSet.actionEnvelope.actionId.value,
      });

      expect(result.isError).toBeUndefined();
      expect(submittedApproval?.decision).toBe("approve");
      expect(submittedHash).toEqual(pollResponse.approvalRequests[0].actionRef.actionEnvelopeHash);
      expect(result.structuredContent).toMatchObject({
        approval: { decision: "approve" },
        coordinationResponse: {
          accepted: true,
          actionRef: pollResponse.approvalRequests[0].actionRef,
          state: "awaitingApprovals",
          createdAt: "2026-06-05T18:20:00.000Z",
        },
      });
    } finally {
      await coordination.close();
    }
  });

  it("builds and submits rejections", async () => {
    const pollResponse = await readJson<CoordinationPollResponse>(
      join(fixturesDir, "responses", "coordination-pending-actions.json"),
    );
    const request = pollResponse.approvalRequests[0];
    request.requestedDecision = "reject";
    const requirements = request.signerReviewSet.authorizationRequirements;
    if (!requirements || requirements.result !== "additionalApprovalsRequired") {
      throw new Error("fixture must contain additional approval requirements");
    }
    requirements.approvalRequirements.anyOf![0].decision = "reject";
    let submittedApproval: Approval | undefined;
    const coordination = await startMockCoordination(async (incoming, response) => {
      if (incoming.url === "/mpas/v1/coordination/poll") {
        sendJson(response, pollResponse);
        return;
      }
      const body = JSON.parse(await readRequestBody(incoming)) as { approval: Approval };
      submittedApproval = body.approval;
      sendJson(response, {
        version: "1",
        type: "CoordinationApprovalSubmissionResponse",
        accepted: true,
        actionRef: request.actionRef,
        state: "awaitingApprovals",
        createdAt: "2026-06-05T18:20:00.000Z",
      });
    });

    try {
      const server = new SignerServer({
        signerKey: join(testKeysDir, "maintainer-a.json"),
        coordinationUrl: coordination.url,
      });
      const result = await server.handleToolCall("mpas_reject", {
        actionId: request.actionRef.actionId.value,
      });

      expect(result.isError).toBeUndefined();
      expect(submittedApproval?.decision).toBe("reject");
      expect(result.structuredContent).toMatchObject({
        approval: { decision: "reject" },
        coordinationResponse: { accepted: true, actionRef: request.actionRef },
      });
    } finally {
      await coordination.close();
    }
  });

  it("returns an MCP error when Coordination does not accept the signed decision", async () => {
    const pollResponse = await readJson<CoordinationPollResponse>(
      join(fixturesDir, "responses", "coordination-pending-actions.json"),
    );
    const request = pollResponse.approvalRequests[0];
    request.requestedDecision = "reject";
    const requirements = request.signerReviewSet.authorizationRequirements;
    if (!requirements || requirements.result !== "additionalApprovalsRequired") {
      throw new Error("fixture must contain additional approval requirements");
    }
    requirements.approvalRequirements.anyOf![0].decision = "reject";
    const coordination = await startMockCoordination((_request, response) => {
      if (_request.url === "/mpas/v1/coordination/poll") {
        sendJson(response, pollResponse);
        return;
      }
      sendJson(response, {
        version: "1",
        type: "CoordinationApprovalSubmissionResponse",
        accepted: false,
        actionRef: pollResponse.approvalRequests[0].actionRef,
        state: "awaitingApprovals",
        createdAt: "2026-06-05T18:20:00.000Z",
      });
    });

    try {
      const server = new SignerServer({
        signerKey: join(testKeysDir, "maintainer-a.json"),
        coordinationUrl: coordination.url,
      });
      const result = await server.handleToolCall("mpas_reject", {
        actionId: pollResponse.approvalRequests[0].actionRef.actionId.value,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining("COORDINATION_APPROVAL_REJECTED"),
      });
      expect(result.structuredContent).toMatchObject({
        code: "COORDINATION_APPROVAL_REJECTED",
        details: {
          approval: { decision: "reject" },
          coordinationResponse: { accepted: false, state: "awaitingApprovals" },
        },
      });
    } finally {
      await coordination.close();
    }
  });

  it("does not report success for a malformed Coordination response", async () => {
    const pollResponse = await readJson<CoordinationPollResponse>(
      join(fixturesDir, "responses", "coordination-pending-actions.json"),
    );
    const coordination = await startMockCoordination((_request, response) => {
      if (_request.url === "/mpas/v1/coordination/poll") {
        sendJson(response, pollResponse);
        return;
      }
      sendJson(response, { version: "1", type: "CoordinationApprovalSubmissionResponse", accepted: "yes" });
    });

    try {
      const server = new SignerServer({
        signerKey: join(testKeysDir, "maintainer-a.json"),
        coordinationUrl: coordination.url,
      });
      const result = await server.handleToolCall("mpas_approve", {
        actionId: pollResponse.approvalRequests[0].actionRef.actionId.value,
      });

      expect(result).toMatchObject({
        isError: true,
        structuredContent: { code: "COORDINATION_RESPONSE_INVALID" },
      });
    } finally {
      await coordination.close();
    }
  });

  it("preserves the accepted state returned for an idempotent duplicate decision", async () => {
    const pollResponse = await readJson<CoordinationPollResponse>(
      join(fixturesDir, "responses", "coordination-pending-actions.json"),
    );
    let submissionCount = 0;
    const coordination = await startMockCoordination((_request, response) => {
      if (_request.url === "/mpas/v1/coordination/poll") {
        sendJson(response, pollResponse);
        return;
      }
      submissionCount += 1;
      sendJson(response, {
        version: "1",
        type: "CoordinationApprovalSubmissionResponse",
        accepted: true,
        actionRef: pollResponse.approvalRequests[0].actionRef,
        state: "awaitingApprovals",
        createdAt: "2026-06-05T18:20:00.000Z",
      });
    });

    try {
      const server = new SignerServer({
        signerKey: join(testKeysDir, "maintainer-a.json"),
        coordinationUrl: coordination.url,
      });
      const args = { actionId: pollResponse.approvalRequests[0].actionRef.actionId.value };
      const first = await server.handleToolCall("mpas_approve", args);
      const duplicate = await server.handleToolCall("mpas_approve", args);

      expect(submissionCount).toBe(2);
      expect(first.isError).toBeUndefined();
      expect(duplicate.isError).toBeUndefined();
      expect(duplicate.structuredContent?.coordinationResponse).toEqual(
        first.structuredContent?.coordinationResponse,
      );
    } finally {
      await coordination.close();
    }
  });

  it("rejects tampered review sets before presenting them", async () => {
    const pollResponse = await readJson<CoordinationPollResponse>(
      join(fixturesDir, "responses", "coordination-pending-actions.json"),
    );
    const reviewSet = pollResponse.approvalRequests[0].signerReviewSet;
    const originalPayload = reviewSet.executionPayload as Record<string, unknown>;
    const tamperedReviewSet: SignerReviewSet = {
      ...reviewSet,
      executionPayload: {
        ...originalPayload,
        arguments: {
          ...(originalPayload.arguments as Record<string, unknown>),
          title: "Tampered title",
        },
      },
    };
    const tamperedPollResponse: CoordinationPollResponse = {
      ...pollResponse,
      approvalRequests: [
        {
          ...pollResponse.approvalRequests[0],
          signerReviewSet: tamperedReviewSet,
        },
      ],
    };
    const coordination = await startMockCoordination((_request, response) => {
      sendJson(response, tamperedPollResponse);
    });

    try {
      const server = new SignerServer({
        signerKey: join(testKeysDir, "maintainer-a.json"),
        coordinationUrl: coordination.url,
      });
      const result = await server.handleToolCall("mpas_review_action", {
        actionId: reviewSet.actionEnvelope.actionId.value,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("REVIEW_SET_INTEGRITY_ERROR"),
      });
    } finally {
      await coordination.close();
    }
  });

  it.each([
    ["Action ID binding", (poll: CoordinationPollResponse) => {
      poll.approvalRequests[0].signerReviewSet.actionEnvelope.actionId.value =
        "urn:uuid:22222222-2222-4222-8222-222222222222";
    }, "REVIEW_SET_INTEGRITY_ERROR"],
    ["Action reference hash", (poll: CoordinationPollResponse) => {
      poll.approvalRequests[0].actionRef.actionEnvelopeHash.value = "wrong";
    }, "REVIEW_SET_INTEGRITY_ERROR"],
    ["Authorization Requirements hash", (poll: CoordinationPollResponse) => {
      const requirements = poll.approvalRequests[0].signerReviewSet.authorizationRequirements;
      if (requirements) requirements.actionEnvelopeHash.value = "wrong";
    }, "REVIEW_SET_INTEGRITY_ERROR"],
    ["review expiry", (poll: CoordinationPollResponse) => {
      poll.approvalRequests[0].signerReviewSet.expiresAt = "2020-01-01T00:00:00Z";
    }, "ACTION_EXPIRED"],
    ["Action expiry", (poll: CoordinationPollResponse) => {
      const request = poll.approvalRequests[0];
      request.signerReviewSet.actionEnvelope.expiresAt = "2020-01-01T00:00:00Z";
      const envelopeHash = computeJsonHash(request.signerReviewSet.actionEnvelope);
      request.actionRef.actionEnvelopeHash = envelopeHash;
      if (request.signerReviewSet.authorizationRequirements) {
        request.signerReviewSet.authorizationRequirements.actionEnvelopeHash = envelopeHash;
      }
    }, "ACTION_EXPIRED"],
    ["Authorization Requirements expiry", (poll: CoordinationPollResponse) => {
      const requirements = poll.approvalRequests[0].signerReviewSet.authorizationRequirements;
      if (requirements) requirements.expiresAt = "2020-01-01T00:00:00Z";
    }, "ACTION_EXPIRED"],
    ["Signer eligibility", (poll: CoordinationPollResponse) => {
      const requirements = poll.approvalRequests[0].signerReviewSet.authorizationRequirements;
      if (requirements?.result === "additionalApprovalsRequired") {
        requirements.approvalRequirements.anyOf![0].eligibleSigners = ["did:web:not-this-signer.example"];
      }
    }, "SIGNER_NOT_ELIGIBLE"],
  ])("fails closed for %s", async (_label, mutate, expectedCode) => {
    const pollResponse = await readJson<CoordinationPollResponse>(
      join(fixturesDir, "responses", "coordination-pending-actions.json"),
    );
    mutate(pollResponse);
    const coordination = await startMockCoordination((_request, response) => sendJson(response, pollResponse));

    try {
      const server = new SignerServer({
        signerKey: join(testKeysDir, "maintainer-a.json"),
        coordinationUrl: coordination.url,
      });
      const result = await server.handleToolCall("mpas_review_action", {
        actionId: pollResponse.approvalRequests[0].actionRef.actionId.value,
      });

      expect(result).toMatchObject({ isError: true, structuredContent: { code: expectedCode } });
    } finally {
      await coordination.close();
    }
  });

  it("rejects an accepted Coordination response bound to another Action", async () => {
    const pollResponse = await readJson<CoordinationPollResponse>(
      join(fixturesDir, "responses", "coordination-pending-actions.json"),
    );
    const coordination = await startMockCoordination((request, response) => {
      if (request.url === "/mpas/v1/coordination/poll") return sendJson(response, pollResponse);
      sendJson(response, {
        version: "1",
        type: "CoordinationApprovalSubmissionResponse",
        accepted: true,
        actionRef: {
          ...pollResponse.approvalRequests[0].actionRef,
          actionId: { value: "urn:uuid:22222222-2222-4222-8222-222222222222" },
        },
        state: "awaitingApprovals",
        createdAt: "2026-06-05T18:20:00.000Z",
      });
    });

    try {
      const server = new SignerServer({
        signerKey: join(testKeysDir, "maintainer-a.json"),
        coordinationUrl: coordination.url,
      });
      const result = await server.handleToolCall("mpas_approve", {
        actionId: pollResponse.approvalRequests[0].actionRef.actionId.value,
      });

      expect(result).toMatchObject({
        isError: true,
        structuredContent: { code: "COORDINATION_RESPONSE_INVALID" },
      });
    } finally {
      await coordination.close();
    }
  });

  it("maps an unavailable Coordination Service to a stable MCP error", async () => {
    const server = new SignerServer({
      signerKey: join(testKeysDir, "maintainer-a.json"),
      coordinationUrl: "http://127.0.0.1:1",
    });

    const result = await server.handleToolCall("mpas_list_pending", {});

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: "COORDINATION_UNAVAILABLE" },
    });
  });
});

async function callSignerFixture(
  poll: CoordinationPollResponse,
  tool: string,
  actionId: string,
  wire: boolean,
  actionRef: unknown = poll.approvalRequests[0]?.actionRef,
  pollStatus = 200,
  approvalStatus = 200,
) {
  let submissions = 0;
  let verifiedPolls = 0;
  const coordination = await startMockCoordination(async (request, response) => {
    if (request.url === "/mpas/v1/coordination/poll") {
      const body = Buffer.from(await readRequestBody(request));
      const parsed = JSON.parse(body.toString("utf8")) as { did: string; audience: string };
      const verified = await verifyMpasRfc9421({ method: request.method!, path: request.url,
        headers: request.headers, body, audiences: ["http://" + request.headers.host] });
      expect(verified).toMatchObject({ ok: true, did: parsed.did });
      expect(parsed.audience).toBe("http://" + request.headers.host);
      verifiedPolls += 1;
      sendJson(response, pollStatus === 200 ? poll : { error: "synthetic-secret" }, pollStatus);
      return;
    }
    submissions += 1;
    sendJson(response, approvalStatus === 200 ? {
      version: "1", type: "CoordinationApprovalSubmissionResponse", accepted: true,
      actionRef, state: "awaitingApprovals", createdAt: "2026-09-04T00:00:00.000Z",
    } : { error: "synthetic-secret" }, approvalStatus);
  });
  const signer = new SignerServer({
    signerKey: join(testKeysDir, "maintainer-a.json"), coordinationUrl: coordination.url,
    now: () => Date.parse("2026-09-04T00:00:00.000Z"),
  });
  const server = wire ? signer.buildMcpServer() : undefined;
  const client = wire ? new Client({ name: "signer-contract-test", version: "1" }) : undefined;
  try {
    if (server && client) {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
    }
    const args = tool === "mpas_list_pending" ? {} : { actionId };
    const result = client
      ? await client.callTool({ name: tool, arguments: args })
      : await signer.handleToolCall(tool, args);
    return { result, submissions, verifiedPolls };
  } finally {
    await client?.close();
    await server?.close();
    await coordination.close();
  }
}

async function startMockCoordination(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : "mock coordination error");
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock coordination service did not bind to a TCP port.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

function sendJson(response: ServerResponse, body: unknown, statusCode = 200): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
