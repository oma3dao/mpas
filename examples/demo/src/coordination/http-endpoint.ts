import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { CoordinationStore, CoordinationStoreError } from "./store.js";
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
}

export function createCoordinationHttpEndpoint(options: CoordinationHttpEndpointOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const store = options.store ?? new CoordinationStore();
  const trace = options.traceLogger ?? new TraceLogger("coordination");

  app.get("/mpas/v1/coordination/health", async () => ({
    status: "ok",
    service: "mpas-local-coordination",
  }));

  app.post("/mpas/v1/coordination/action", async (request, reply) => {
    try {
      const body = request.body as CoordinationActionRequest;
      const actionId = body.actionPackage?.actionEnvelope?.actionId?.value;
      const proposerDid = body.actionPackage?.actionEnvelope?.proposer?.did;

      trace.emit("coordination_submit", {
        actionId,
        did: proposerDid,
        endpoint: "/mpas/v1/coordination/action",
        authorizationRequirements: body.authorizationRequirements,
      });

      const result = store.submitAction(body);
      reply.code(result.created ? 201 : 200);

      trace.emit("state_transition", {
        actionId,
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

      trace.emit("coordination_poll", {
        did: body.did,
        endpoint: "/mpas/v1/coordination/poll",
      });

      const response = store.poll(body.did);

      trace.emit("coordination_poll", {
        did: body.did,
        endpoint: "/mpas/v1/coordination/poll",
        result: "ok",
        approvalRequestCount: response.approvalRequests.length,
        actionUpdateCount: response.actionUpdates.length,
      });

      return response;
    } catch (error) {
      return replyStoreError(reply, error);
    }
  });

  app.post("/mpas/v1/coordination/approval", async (request, reply) => {
    try {
      const body = request.body as CoordinationApprovalSubmission;
      const actionEnvelopeHash = body.actionEnvelopeHash?.value;

      trace.emit("approval_received", {
        endpoint: "/mpas/v1/coordination/approval",
        actionEnvelopeHash,
      });

      const response = store.submitApproval(body);

      trace.emit("approval_received", {
        actionId: response.actionRef.actionId.value,
        endpoint: "/mpas/v1/coordination/approval",
        result: "accepted",
        state: response.state,
      });

      if (response.state === "readyForResubmission") {
        trace.emit("state_transition", {
          actionId: response.actionRef.actionId.value,
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
      const actionId = body.actionId?.value;

      trace.emit("action_cancelled", {
        actionId,
        did: body.proposerDid,
        endpoint: "/mpas/v1/coordination/action-cancel",
      });

      const response = store.cancelAction(body);

      trace.emit("state_transition", {
        actionId,
        toState: "cancelled",
      });

      return response;
    } catch (error) {
      return replyStoreError(reply, error);
    }
  });

  return app;
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
