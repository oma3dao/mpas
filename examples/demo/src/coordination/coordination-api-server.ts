import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type RouteHandlerMethod,
} from "fastify";
import {
  InMemoryNonceStore,
  isValidMpasAudienceOrigin,
  MPAS_MAX_SIGNATURE_LIFETIME_SECONDS,
  strictJsonParse,
  verifyMpasRfc9421,
  type MpasAuthSuccess,
  type NonceStore,
  type Did,
} from "@oma3/mpas";
import { CoordinationStore, MpasServiceError, decodeApprovalSignerDid } from "./store.js";
import { CoordinationNotificationHub } from "./notifications.js";
import {
  effectiveIdempotencyKey,
  validateApprovalSubmission,
  validateCancelRequest,
  validateCoordinationActionRequest,
  validatePollRequest,
  validateRelayPollRequest,
  validateRelaySessionRequest,
  validateRelayedActionRequest,
  validateResponseDelivery,
  validateSessionRequest,
} from "./validation.js";
import { TraceLogger } from "../core/trace.js";
import type {
  CoordinationActionRequest,
  CoordinationApprovalSubmission,
  CoordinationActionCancelRequest,
  CoordinationPollRequest,
} from "./types.js";

export interface CoordinationHttpEndpointOptions {
  store?: CoordinationStore;
  traceLogger?: TraceLogger;
  auth?: CoordinationAuthOptions;
  designatedVerifierDid?: Did;
  authorizedRecipientDids?: readonly Did[];
  notificationOrigin?: string;
  /** Demo relay wait bound. Production services should configure this operationally. */
  relayResponseWaitMs?: number;
}

export interface CoordinationAuthOptions {
  enforcement?: boolean;
  audiences?: readonly string[];
  clockSkewSeconds?: number;
  signatureLifetimeSeconds?: number;
  nonceStore?: NonceStore;
  now?: () => Date;
}

export function createCoordinationApiServer(options: CoordinationHttpEndpointOptions = {}): FastifyInstance {
  const auth = resolveAuthOptions(options.auth);
  const app = Fastify({ logger: false });
  const store = options.store ?? new CoordinationStore();
  const trace = options.traceLogger ?? new TraceLogger("coordination");
  const rawBodies = new WeakMap<object, Buffer>();
  const coordinationNotificationHub = new CoordinationNotificationHub(
    app.server,
    (did) => store.hasOutstandingCoordinationWork(did),
    auth.now,
  );
  const relayNotificationHub = new CoordinationNotificationHub(
    app.server,
    (did) => store.hasOutstandingRelayWork(did),
    auth.now,
    "/mpas/v1/relay/ws",
    "RelayWorkAvailable",
  );
  app.server.on("upgrade", (request, socket) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/mpas/v1/relay/ws" || path === "/mpas/v1/coordination/ws") return;
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });
  const relayResponseWaitMs = options.relayResponseWaitMs ?? 30_000;
  if (!Number.isFinite(relayResponseWaitMs) || relayResponseWaitMs <= 0) {
    throw new Error("relayResponseWaitMs must be a positive number.");
  }
  const authorizedRecipients = new Set(options.authorizedRecipientDids ?? []);
  if (options.designatedVerifierDid) authorizedRecipients.add(options.designatedVerifierDid);
  app.addHook("onClose", async () => {
    await Promise.all([coordinationNotificationHub.close(), relayNotificationHub.close()]);
  });

  // Strict parsing: duplicate JSON member names in signed artifacts are malformed
  // per MPAS Core §5.1.2 (JSON.parse silently keeps the last value).
  const strictBodyParser = (request: FastifyRequest, body: string | Buffer, done: (error: Error | null, value?: unknown) => void) => {
    try {
      const text = typeof body === "string" ? body : body.toString("utf8");
      rawBodies.set(request, Buffer.from(text, "utf8"));
      done(null, text === "" ? undefined : strictJsonParse(text));
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      (wrapped as Error & { statusCode?: number }).statusCode = 400;
      done(wrapped, undefined);
    }
  };
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, strictBodyParser);
  app.addContentTypeParser("application/mpas+json", { parseAs: "string" }, strictBodyParser);

  app.get("/mpas/v1/coordination/health", async () => ({
    status: "ok",
    service: "mpas-local-coordination",
  }));

  const relayActionHandler: RouteHandlerMethod = async (request, reply) => {
    try {
      const authenticated = await authenticateRequest(request, reply, rawBodies, auth);
      if (authenticated === AUTH_FAILED) return reply;
      if (!options.designatedVerifierDid) {
        return reply.code(503).send({
          version: "1",
          type: "MpasHttpError",
          error: { code: "policy_unavailable", message: "No designated Verifier DID is configured." },
        });
      }
      const body = validateRelayedActionRequest(request.body, options.designatedVerifierDid);
      if (authenticated !== AUTH_DISABLED && authenticated.did !== body.sender) return replyPermissionDenied(reply);
      if (body.recipients.some((did) => !authorizedRecipients.has(did))) {
        return replyPermissionDenied(reply);
      }
      const idempotencyKey = effectiveIdempotencyKey(body.payload.idempotencyKey, request.headers["idempotency-key"]);
      store.validateRelayedAction(body, options.designatedVerifierDid);
      if (authenticated !== AUTH_DISABLED && !(await claimNonce(auth.nonceStore, authenticated))) {
        return replySignatureInvalid(reply);
      }

      const response = store.runIdempotent("relay", body.sender, idempotencyKey, body, async () => {
        const pending = store.beginRelayedAction(body, options.designatedVerifierDid!);
        if (pending.created) relayNotificationHub.notify(body.recipients);
        return pending.response;
      });
      return await waitForRelayedResponse(response, relayResponseWaitMs);
    } catch (error) {
      return replyStoreError(reply, error);
    }
  };
  app.post("/mpas/v1/verifier/action", relayActionHandler);
  app.post("/mpas/v1/action", relayActionHandler);

  const relayDeliveryHandler: RouteHandlerMethod = async (request, reply) => {
    try {
      const authenticated = await authenticateRequest(request, reply, rawBodies, auth);
      if (authenticated === AUTH_FAILED) return reply;
      const body = validateResponseDelivery(request.body);
      if (authenticated !== AUTH_DISABLED &&
          (authenticated.did !== body.sender || authenticated.did !== body.payload.verifier?.did)) {
        return replyPermissionDenied(reply);
      }
      store.validateResponseDelivery(body, authorizedRecipients);
      if (authenticated !== AUTH_DISABLED && !(await claimNonce(auth.nonceStore, authenticated))) {
        return replySignatureInvalid(reply);
      }
      const response = store.submitResponseDelivery(body, authorizedRecipients);
      relayNotificationHub.notify(body.recipients);
      return response;
    } catch (error) {
      return replyStoreError(reply, error);
    }
  };
  app.post("/mpas/v1/relay/delivery", relayDeliveryHandler);
  app.post("/mpas/v1/coordination/delivery", relayDeliveryHandler);

  app.post("/mpas/v1/relay/poll", async (request, reply) => {
    try {
      const authenticated = await authenticateRequest(request, reply, rawBodies, auth);
      if (authenticated === AUTH_FAILED) return reply;
      const body = validateRelayPollRequest(request.body);
      if (authenticated !== AUTH_DISABLED && authenticated.did !== body.did) return replyPermissionDenied(reply);
      return store.pollDeliveries(body.did, body.cursor);
    } catch (error) {
      return replyStoreError(reply, error);
    }
  });

  app.post("/mpas/v1/relay/session", async (request, reply) => {
    try {
      const authenticated = await authenticateRequest(request, reply, rawBodies, auth);
      if (authenticated === AUTH_FAILED) return reply;
      const body = validateRelaySessionRequest(request.body);
      if (authenticated !== AUTH_DISABLED && authenticated.did !== body.did) return replyPermissionDenied(reply);
      if (authenticated !== AUTH_DISABLED && !(await claimNonce(auth.nonceStore, authenticated))) {
        return replySignatureInvalid(reply);
      }
      return {
        version: "1",
        type: "RelaySessionResponse",
        ...relayNotificationHub.issue(
          body.did,
          notificationWebSocketUrl(
            options.notificationOrigin ?? auth.audiences[0] ?? "http://127.0.0.1",
            "/mpas/v1/relay/ws",
          ),
        ),
      };
    } catch (error) {
      return replyStoreError(reply, error);
    }
  });

  app.post("/mpas/v1/coordination/session", async (request, reply) => {
    try {
      const authenticated = await authenticateRequest(request, reply, rawBodies, auth);
      if (authenticated === AUTH_FAILED) return reply;
      const body = validateSessionRequest(request.body);
      if (authenticated !== AUTH_DISABLED && authenticated.did !== body.did) return replyPermissionDenied(reply);
      if (authenticated !== AUTH_DISABLED && !(await claimNonce(auth.nonceStore, authenticated))) {
        return replySignatureInvalid(reply);
      }
      return {
        version: "1",
        type: "CoordinationSessionResponse",
        ...coordinationNotificationHub.issue(
          body.did,
          notificationWebSocketUrl(
            options.notificationOrigin ?? auth.audiences[0] ?? "http://127.0.0.1",
            "/mpas/v1/coordination/ws",
          ),
        ),
      };
    } catch (error) {
      return replyStoreError(reply, error);
    }
  });

  const createWorkflowHandler: RouteHandlerMethod = async (request, reply) => {
    try {
      const authenticated = await authenticateRequest(request, reply, rawBodies, auth);
      if (authenticated === AUTH_FAILED) return reply;
      const body = validateCoordinationActionRequest(request.body);
      const idempotencyKey = effectiveIdempotencyKey(body.idempotencyKey, request.headers["idempotency-key"]);
      const proposerDid = body?.actionPackage?.actionEnvelope?.proposer?.did;
      if (authenticated !== AUTH_DISABLED && authenticated.did !== proposerDid) {
        return replyPermissionDenied(reply);
      }

      store.validateCreateWorkflow(body);
      if (authenticated !== AUTH_DISABLED && !(await claimNonce(auth.nonceStore, authenticated))) {
        return replySignatureInvalid(reply);
      }

      trace.emit("coordination_workflow_create", {
        endpoint: request.routeOptions.url,
      });

      const result = await store.runIdempotent(
        "coordination",
        body.actionPackage.actionEnvelope.proposer.did,
        idempotencyKey,
        body,
        () => store.createWorkflow(body),
      );
      reply.code(result.created ? 201 : 200);
      if (result.created) coordinationNotificationHub.notify(coordinationRecipients(body));

      trace.emit("state_transition", {
        result: result.created ? "created" : "existing",
        state: result.response.state,
      });

      return result.response;
    } catch (error) {
      return replyStoreError(reply, error);
    }
  };

  app.post("/mpas/v1/coordination/workflow", createWorkflowHandler);
  // Temporary migration alias. Both routes share validation, idempotency,
  // authorization, storage, and notification behavior.
  app.post("/mpas/v1/coordination/action", createWorkflowHandler);

  app.post("/mpas/v1/coordination/poll", async (request, reply) => {
    try {
      const authenticated = await authenticateRequest(request, reply, rawBodies, auth);
      if (authenticated === AUTH_FAILED) return reply;
      const body = validatePollRequest(request.body);
      if (authenticated !== AUTH_DISABLED && authenticated.did !== body.did) {
        return replyPermissionDenied(reply);
      }

      trace.emit("coordination_poll", {
        endpoint: "/mpas/v1/coordination/poll",
      });

      const response = store.poll(body.did);

      trace.emit("coordination_poll", {
        endpoint: "/mpas/v1/coordination/poll",
        result: "ok",
      });

      return response;
    } catch (error) {
      return replyStoreError(reply, error);
    }
  });

  app.post("/mpas/v1/coordination/approval", async (request, reply) => {
    try {
      const authenticated = await authenticateRequest(request, reply, rawBodies, auth);
      if (authenticated === AUTH_FAILED) return reply;
      const body = validateApprovalSubmission(request.body);
      const idempotencyKey = effectiveIdempotencyKey(body.idempotencyKey, request.headers["idempotency-key"]);
      const actionEnvelopeHash = body?.actionEnvelopeHash?.value;
      const signerDid = decodeApprovalSignerDid(body?.approval);
      if (authenticated !== AUTH_DISABLED) {
        if (!signerDid || authenticated.did !== signerDid) {
          return replyPermissionDenied(reply);
        }
        if (!store.hasActionEnvelopeHash(actionEnvelopeHash) || !store.isEligibleSigner(actionEnvelopeHash, signerDid)) {
          return replyPermissionDenied(reply);
        }
      }

      store.validateSubmitApproval(body);
      if (authenticated !== AUTH_DISABLED && !(await claimNonce(auth.nonceStore, authenticated))) {
        return replySignatureInvalid(reply);
      }

      trace.emit("approval_received", {
        endpoint: "/mpas/v1/coordination/approval",
      });

      // submitApproval intentionally repeats preflight after the asynchronous
      // nonce claim so a custom store cannot commit against workflow state
      // that changed while claim() was pending.
      const response = await store.runIdempotent(
        "coordination",
        signerDid!,
        idempotencyKey,
        body,
        () => store.submitApproval(body),
      );
      coordinationNotificationHub.notify(store.participantsForActionHash(actionEnvelopeHash));

      trace.emit("approval_received", {
        endpoint: "/mpas/v1/coordination/approval",
        result: "accepted",
        state: response.state,
      });

      if (response.state === "readyForSubmission") {
        trace.emit("state_transition", {
          fromState: "awaitingApprovals",
          toState: "readyForSubmission",
        });
      } else if (response.state === "rejected") {
        trace.emit("state_transition", {
          fromState: "awaitingApprovals",
          toState: "rejected",
        });
      }

      return response;
    } catch (error) {
      return replyStoreError(reply, error);
    }
  });

  const cancelWorkflowHandler: RouteHandlerMethod = async (request, reply) => {
    try {
      const authenticated = await authenticateRequest(request, reply, rawBodies, auth);
      if (authenticated === AUTH_FAILED) return reply;
      const body = validateCancelRequest(request.body);
      const idempotencyKey = effectiveIdempotencyKey(body.idempotencyKey, request.headers["idempotency-key"]);
      const actionId = body?.actionId?.value;
      if (authenticated !== AUTH_DISABLED) {
        const storedProposer = store.proposerForAction(actionId);
        if (authenticated.did !== body.proposerDid || authenticated.did !== storedProposer) {
          return replyPermissionDenied(reply);
        }
      }

      store.validateCancelAction(body);
      if (authenticated !== AUTH_DISABLED && !(await claimNonce(auth.nonceStore, authenticated))) {
        return replySignatureInvalid(reply);
      }

      trace.emit("action_cancelled", {
        endpoint: "/mpas/v1/coordination/workflow-cancel",
      });

      const response = await store.runIdempotent(
        "coordination",
        body.proposerDid,
        idempotencyKey,
        body,
        () => store.cancelAction(body),
      );
      coordinationNotificationHub.notify([body.proposerDid]);

      trace.emit("state_transition", {
        toState: "cancelled",
      });

      return response;
    } catch (error) {
      return replyStoreError(reply, error);
    }
  };
  app.post("/mpas/v1/coordination/workflow-cancel", cancelWorkflowHandler);
  app.post("/mpas/v1/coordination/action-cancel", cancelWorkflowHandler);

  return app;
}

const AUTH_DISABLED = Symbol("auth-disabled");
const AUTH_FAILED = Symbol("auth-failed");

interface ResolvedAuthOptions {
  enforcement: boolean;
  audiences: readonly string[];
  clockSkewSeconds: number;
  signatureLifetimeSeconds: number;
  nonceStore: NonceStore;
  now: () => Date;
}

function resolveAuthOptions(options: CoordinationAuthOptions = {}): ResolvedAuthOptions {
  const enforcement = options.enforcement ?? false;
  const audiences = options.audiences ?? [];
  const clockSkewSeconds = options.clockSkewSeconds ?? 30;
  const signatureLifetimeSeconds = options.signatureLifetimeSeconds ?? MPAS_MAX_SIGNATURE_LIFETIME_SECONDS;
  const now = options.now ?? (() => new Date());

  if (!Number.isInteger(clockSkewSeconds) || clockSkewSeconds < 0) {
    throw new Error("Coordination authentication clockSkewSeconds must be a non-negative integer.");
  }
  if (
    !Number.isInteger(signatureLifetimeSeconds) ||
    signatureLifetimeSeconds <= 0 ||
    signatureLifetimeSeconds > MPAS_MAX_SIGNATURE_LIFETIME_SECONDS
  ) {
    throw new Error(
      `Coordination authentication signatureLifetimeSeconds must be from 1 to ${MPAS_MAX_SIGNATURE_LIFETIME_SECONDS}.`,
    );
  }
  if (enforcement && (audiences.length === 0 || audiences.some((value) => !isValidMpasAudienceOrigin(value)))) {
    throw new Error("Coordination authentication enforcement requires a non-empty set of valid canonical audience origins.");
  }

  return {
    enforcement,
    audiences: [...new Set(audiences)],
    clockSkewSeconds,
    signatureLifetimeSeconds,
    nonceStore: options.nonceStore ?? new InMemoryNonceStore(() => now().getTime()),
    now,
  };
}

async function authenticateRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  rawBodies: WeakMap<object, Buffer>,
  auth: ResolvedAuthOptions,
): Promise<MpasAuthSuccess | typeof AUTH_DISABLED | typeof AUTH_FAILED> {
  if (!auth.enforcement) return AUTH_DISABLED;
  const body = rawBodies.get(request) ?? Buffer.alloc(0);

  const result = await verifyMpasRfc9421({
    method: request.method,
    path: request.url,
    headers: request.headers,
    body,
    audiences: auth.audiences,
    now: auth.now(),
    clockSkewSeconds: auth.clockSkewSeconds,
    maxLifetimeSeconds: auth.signatureLifetimeSeconds,
  });

  if (!result.ok) {
    reply.code(result.status).send({
      version: "1",
      type: "MpasHttpError",
      error: {
        code: result.code,
        message:
          result.code === "authentication_required"
            ? "Authentication is required."
            : result.code === "artifact_hash_mismatch"
              ? "Request body digest does not match."
              : "Signature verification failed.",
      },
    });
    return AUTH_FAILED;
  }

  return result;
}

async function claimNonce(store: NonceStore, authenticated: MpasAuthSuccess): Promise<boolean> {
  return store.claim(authenticated.did, authenticated.nonce, authenticated.expiresAt);
}

function replySignatureInvalid(reply: FastifyReply): FastifyReply {
  return reply.code(401).send({
    version: "1",
    type: "MpasHttpError",
    error: { code: "signature_invalid", message: "Signature verification failed." },
  });
}

function replyPermissionDenied(reply: FastifyReply): FastifyReply {
  return reply.code(403).send({
    version: "1",
    type: "MpasHttpError",
    error: { code: "permission_denied", message: "The authenticated identity is not permitted for this request." },
  });
}

function replyStoreError(reply: FastifyReply, error: unknown) {
  if (error instanceof MpasServiceError) {
    reply.code(error.statusCode);
    return {
      version: "1",
      type: "MpasHttpError",
      error: {
        code: error.code,
        message: error.message,
        ...(error.code === "timeout" ? { retryable: true } : {}),
      },
    };
  }

  throw error;
}

function waitForRelayedResponse<T>(response: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new MpasServiceError(
      503,
      "timeout",
      "The designated Verifier did not respond within this relay wait.",
    )), timeoutMs);
    timer.unref();
    void response.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function coordinationRecipients(body: CoordinationActionRequest): Did[] {
  const requirements = body.authorizationRequirements.approvalRequirements;
  return [...new Set<Did>([
    body.actionPackage.actionEnvelope.proposer.did,
    ...(requirements.anyOf ?? []).flatMap((threshold) => threshold.eligibleSigners),
    ...(requirements.allOf ?? []).flatMap((threshold) => threshold.eligibleSigners),
    ...(requirements.overrideSigners ?? []).map((entry) => entry.signer),
  ])];
}

function notificationWebSocketUrl(origin: string, path: "/mpas/v1/relay/ws" | "/mpas/v1/coordination/ws"): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new MpasServiceError(500, "policy_unavailable", "Notification origin is not a valid URL.");
  }
  if (url.origin !== origin || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new MpasServiceError(500, "policy_unavailable", "Notification origin must be a canonical HTTP(S) origin.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !local) {
    throw new MpasServiceError(500, "policy_unavailable", "Notification origin must use HTTPS outside local development.");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = path;
  return url.toString();
}
