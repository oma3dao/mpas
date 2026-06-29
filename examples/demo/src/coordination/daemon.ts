import type { FastifyInstance } from "fastify";
import { createCoordinationHttpEndpoint } from "./http-endpoint.js";
import { TraceLogger, TraceWriter } from "../core/trace.js";

export interface CoordinationDaemonOptions {
  host?: string;
  port?: number;
  tracePath?: string;
}

export interface StartedCoordinationDaemon {
  app: FastifyInstance;
  address: string;
}

export async function startCoordinationDaemon(options: CoordinationDaemonOptions = {}): Promise<StartedCoordinationDaemon> {
  const traceWriter = options.tracePath ? new TraceWriter(options.tracePath) : undefined;
  const traceLogger = new TraceLogger("coordination", traceWriter);
  const app = createCoordinationHttpEndpoint({ traceLogger });
  const address = await app.listen({
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 7545,
  });

  return {
    app,
    address,
  };
}
