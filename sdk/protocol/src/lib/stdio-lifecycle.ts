import { DEFAULT_SHUTDOWN_GRACE_MS } from "./bridge-runtime.js";

/** Streams and process hooks used by {@link bindStdioShutdown}; injectable for tests. */
export interface StdioShutdownHost {
  stdin: Pick<NodeJS.ReadableStream, "once" | "off">;
  stdout: Pick<NodeJS.WritableStream, "once" | "off">;
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
  exit(code: number): void;
}

export interface StdioShutdownOptions {
  /**
   * Called once, on the first trigger. Abort in-flight requests, shut the
   * bridge down, and close the workflow store here.
   */
  shutdown: () => Promise<void>;
  /** Exit with code 1 if `shutdown` has not finished by then. Default 6000ms. */
  forceExitAfterMs?: number;
  /** Notified with the trigger, for logging. */
  onTrigger?: (reason: string) => void;
  /** Defaults to the current process. */
  host?: StdioShutdownHost;
}

const SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];

/**
 * Exit a stdio MCP server when its client goes away (feature reduce-polling
 * §6): stdin `end` or `close`, an stdout write error such as `EPIPE`, or
 * SIGTERM, SIGINT or SIGHUP. The process exits with code 0 once `shutdown`
 * resolves, or 1 if it rejects or exceeds `forceExitAfterMs`.
 *
 * Returns `dispose`, which removes the listeners without shutting down.
 */
export function bindStdioShutdown(options: StdioShutdownOptions): () => void {
  const host = options.host ?? (process as unknown as StdioShutdownHost);
  const forceExitAfterMs = options.forceExitAfterMs ?? DEFAULT_SHUTDOWN_GRACE_MS + 1_000;
  let triggered = false;

  const onStdinEnd = () => trigger("stdin_end");
  const onStdinClose = () => trigger("stdin_close");
  const onStdoutError = () => trigger("stdout_error");
  const onSignal = new Map(SIGNALS.map((signal) => [signal, () => trigger(signal)] as const));

  const dispose = () => {
    host.stdin.off("end", onStdinEnd);
    host.stdin.off("close", onStdinClose);
    host.stdout.off("error", onStdoutError);
    for (const [signal, listener] of onSignal) host.off(signal, listener);
  };

  function trigger(reason: string): void {
    if (triggered) return;
    triggered = true;
    dispose();
    options.onTrigger?.(reason);
    const force = setTimeout(() => host.exit(1), forceExitAfterMs);
    force.unref?.();
    let shutdown: Promise<void>;
    try {
      shutdown = Promise.resolve(options.shutdown());
    } catch (error) {
      shutdown = Promise.reject(error);
    }
    shutdown.then(
      () => {
        clearTimeout(force);
        host.exit(0);
      },
      () => {
        clearTimeout(force);
        host.exit(1);
      },
    );
  }

  host.stdin.once("end", onStdinEnd);
  host.stdin.once("close", onStdinClose);
  host.stdout.once("error", onStdoutError);
  for (const [signal, listener] of onSignal) host.once(signal, listener);
  return dispose;
}
