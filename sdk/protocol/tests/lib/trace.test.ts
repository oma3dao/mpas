import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TraceLogger, TraceWriter } from "../../src/lib/trace.js";

describe("TraceWriter / TraceLogger (sdk)", () => {
  it("appends JSONL events when enabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mpas-sdk-trace-"));
    const path = join(dir, "trace.jsonl");
    const writer = new TraceWriter(path);
    const logger = new TraceLogger("adapter", writer);

    expect(logger.enabled).toBe(true);
    logger.emit("incoming_action", { actionId: "act-1", did: "did:jwk:x" });
    logger.emit("dispatch", { actionId: "act-1", result: "executed" });

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({
      service: "adapter",
      type: "incoming_action",
      actionId: "act-1",
      did: "did:jwk:x",
    });
    expect(JSON.parse(lines[1])).toMatchObject({
      type: "dispatch",
      result: "executed",
    });
  });

  it("is a no-op when no writer is provided", () => {
    const logger = new TraceLogger("coordination");
    expect(logger.enabled).toBe(false);
    expect(() => logger.emit("coordination_poll", { did: "did:jwk:y" })).not.toThrow();
  });
});
