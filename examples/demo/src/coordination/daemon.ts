import type { FastifyInstance } from "fastify";
import { createCoordinationApiServer, type CoordinationAuthOptions } from "./coordination-api-server.js";
import { TraceLogger, TraceWriter } from "../core/trace.js";
import type { Did } from "../core/types.js";

export interface CoordinationDaemonOptions {
  host?: string;
  port?: number;
  tracePath?: string;
  auth?: CoordinationAuthOptions;
  designatedVerifierDid?: Did;
  authorizedRecipientDids?: readonly Did[];
  notificationOrigin?: string;
}

export interface StartedCoordinationDaemon {
  app: FastifyInstance;
  address: string;
}

export async function startCoordinationDaemon(options: CoordinationDaemonOptions = {}): Promise<StartedCoordinationDaemon> {
  const traceWriter = options.tracePath ? new TraceWriter(options.tracePath) : undefined;
  const traceLogger = new TraceLogger("coordination", traceWriter);
  const app = createCoordinationApiServer({
    traceLogger,
    auth: options.auth,
    designatedVerifierDid: options.designatedVerifierDid,
    authorizedRecipientDids: options.authorizedRecipientDids,
    notificationOrigin: options.notificationOrigin,
  });
  const address = await app.listen({
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 7545,
  });

  return {
    app,
    address,
  };
}
