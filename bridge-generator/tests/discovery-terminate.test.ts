import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn };
});

const { discoverUpstream } = await import("../src/discovery.js");

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal?: NodeJS.Signals) => boolean;
}

function hangingUpstream(killed: string[]): FakeChild {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const child = new EventEmitter() as FakeChild;
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    killed.push(signal ?? "");
    if (signal === "SIGKILL") {
      child.exitCode = 1;
      child.signalCode = "SIGKILL";
      child.emit("exit", 1, "SIGKILL");
    }
    return true;
  };

  stdin.on("data", (chunk: Buffer) => {
    const line = chunk.toString("utf8").trim();
    if (!line) return;
    const message = JSON.parse(line) as { id?: number; method?: string };
    if (typeof message.id !== "number") return;
    if (message.method === "initialize") {
      stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: "2024-11-05", serverInfo: { name: "hang", version: "0" } },
        })}\n`,
      );
      return;
    }
    if (message.method === "tools/list") {
      stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: [{ name: "noop", inputSchema: { type: "object" } }] },
        })}\n`,
      );
    }
  });

  return child;
}

describe("discoverUpstream terminate", () => {
  afterEach(() => {
    spawn.mockReset();
    vi.restoreAllMocks();
  });

  it("sends SIGKILL when the upstream ignores SIGTERM", async () => {
    const killed: string[] = [];
    const child = hangingUpstream(killed);
    spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });

    const originalSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      const ms = delay === 5_000 ? 5 : delay;
      return originalSetTimeout(handler as (...inner: unknown[]) => void, ms, ...args);
    }) as typeof setTimeout);

    await expect(discoverUpstream("node", ["fake-upstream"])).resolves.toMatchObject({
      serverName: "hang",
      tools: [{ name: "noop" }],
    });
    expect(killed).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("classifies an exit before spawn as an upstream spawn failure", async () => {
    spawn.mockImplementation(() => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      const child = new EventEmitter() as FakeChild;
      child.stdin = stdin;
      child.stdout = stdout;
      child.stderr = stderr;
      child.exitCode = 1;
      child.signalCode = null;
      child.kill = () => true;
      queueMicrotask(() => child.emit("exit", 1, null));
      return child;
    });

    await expect(discoverUpstream("node", ["never-spawned"])).rejects.toThrow(/Failed to spawn: node/);
  });
});
