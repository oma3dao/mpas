import { afterEach, describe, expect, it, vi } from "vitest";
import { runCoordinationService } from "../../src/coordination/index.js";

afterEach(() => {
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
});

describe("runCoordinationService", () => {
  it("parses --host/--port, starts, and closes on SIGTERM", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((message: unknown) => {
      logs.push(String(message));
    });

    try {
      await runCoordinationService(["--host", "127.0.0.1", "--port", "0"]);
      const started = logs.map((line) => JSON.parse(line) as { status: string; address: string }).at(-1);
      expect(started?.status).toBe("started");
      expect(started?.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);

      const health = await fetch(`${started!.address}/mpas/v1/coordination/health`);
      expect(health.status).toBe(200);

      process.emit("SIGTERM");
      await vi.waitFor(async () => {
        await expect(fetch(`${started!.address}/mpas/v1/coordination/health`)).rejects.toThrow();
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("closes on SIGINT", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((message: unknown) => {
      logs.push(String(message));
    });

    try {
      await runCoordinationService(["--host", "127.0.0.1", "--port", "0"]);
      const started = logs.map((line) => JSON.parse(line) as { status: string; address: string }).at(-1);
      expect(started?.status).toBe("started");

      process.emit("SIGINT");
      await vi.waitFor(async () => {
        await expect(fetch(`${started!.address}/mpas/v1/coordination/health`)).rejects.toThrow();
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("starts with RFC 9421 enforcement when audience flags are provided", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((message: unknown) => {
      logs.push(String(message));
    });

    try {
      await runCoordinationService([
        "--host", "127.0.0.1",
        "--port", "0",
        "--auth-enforcement",
        "--auth-audience", "https://coordination.example.com",
        "--auth-clock-skew-seconds", "15",
        "--auth-signature-lifetime-seconds", "30",
      ]);
      const started = logs.map((line) => JSON.parse(line) as { status: string; address: string }).at(-1);
      expect(started?.status).toBe("started");

      const poll = await fetch(`${started!.address}/mpas/v1/coordination/poll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "1", type: "CoordinationPollRequest", did: "did:web:x" }),
      });
      expect(poll.status).toBe(401);

      process.emit("SIGTERM");
      await vi.waitFor(async () => {
        await expect(fetch(`${started!.address}/mpas/v1/coordination/health`)).rejects.toThrow();
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("fails closed for invalid signature-lifetime and clock-skew flags", async () => {
    await expect(runCoordinationService([
      "--host", "127.0.0.1",
      "--port", "0",
      "--auth-signature-lifetime-seconds", "61",
    ])).rejects.toThrow(/signatureLifetimeSeconds must be from 1 to 60/);

    await expect(runCoordinationService([
      "--host", "127.0.0.1",
      "--port", "0",
      "--auth-clock-skew-seconds", "-1",
    ])).rejects.toThrow(/clockSkewSeconds must be a non-negative integer/);
  });
});
