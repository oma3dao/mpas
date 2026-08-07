import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  InMemoryNonceStore,
  isValidMpasAudienceOrigin,
  MPAS_MAX_SIGNATURE_LIFETIME_SECONDS,
  strictJsonParse,
  verifyMpasRfc9421,
  type MpasAuthSuccess,
  type NonceStore,
} from "@oma3/mpas";
import { CoordinationStore, CoordinationStoreError, decodeApprovalSignerDid } from "./store.js";
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

  app.post("/mpas/v1/coordination/action", async (request, reply) => {
    try {
      const body = request.body as CoordinationActionRequest;
      const authenticated = await authenticateRequest(request, reply, rawBodies, auth);
      if (authenticated === AUTH_FAILED) return reply;
      const proposerDid = body?.actionPackage?.actionEnvelope?.proposer?.did;
      if (authenticated !== AUTH_DISABLED && authenticated.did !== proposerDid) {
        return replyPermissionDenied(reply);
      }

      store.validateSubmitAction(body);
      if (authenticated !== AUTH_DISABLED && !(await claimNonce(auth.nonceStore, authenticated))) {
        return replySignatureInvalid(reply);
      }

      trace.emit("coordination_submit", {
        endpoint: "/mpas/v1/coordination/action",
      });

      const result = store.submitAction(body);
      reply.code(result.created ? 201 : 200);

      trace.emit("state_transition", {
        result: result.created ? "created" : "existing",
        state: result.response.state,
      });

      return result.response;
    } catch (error) {
      return replyStoreError(reply, error);
    }
  });

  app.post("/mpas/v1/coordination/poll", async (request, reply) => {
    try {
      const body = request.body as CoordinationPollRequest;
      const authenticated = await authenticateRequest(request, reply, rawBodies, auth);
      if (authenticated === AUTH_FAILED) return reply;
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
      const body = request.body as CoordinationApprovalSubmission;
      const authenticated = await authenticateRequest(request, reply, rawBodies, auth);
      if (authenticated === AUTH_FAILED) return reply;
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
      const response = store.submitApproval(body);

      trace.emit("approval_received", {
        endpoint: "/mpas/v1/coordination/approval",
        result: "accepted",
        state: response.state,
      });

      if (response.state === "readyForResubmission") {
        trace.emit("state_transition", {
          fromState: "awaitingApprovals",
          toState: "readyForResubmission",
        });
      }

      return response;
    } catch (error) {
      return replyStoreError(reply, error);
    }
  });

  app.post("/mpas/v1/coordination/action-cancel", async (request, reply) => {
    try {
      const body = request.body as CoordinationActionCancelRequest;
      const authenticated = await authenticateRequest(request, reply, rawBodies, auth);
      if (authenticated === AUTH_FAILED) return reply;
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
        endpoint: "/mpas/v1/coordination/action-cancel",
      });

      const response = store.cancelAction(body);

      trace.emit("state_transition", {
        toState: "cancelled",
      });

      return response;
    } catch (error) {
      return replyStoreError(reply, error);
    }
  });

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
  if (error instanceof CoordinationStoreError) {
    reply.code(error.statusCode);
    return {
      error: {
        code: error.code,
        message: error.message,
      },
    };
  }

  throw error;
}
