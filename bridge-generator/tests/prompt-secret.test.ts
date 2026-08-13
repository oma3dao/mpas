import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPromptSecrets, promptSecret } from "../src/prompt-secret.js";

describe("applyPromptSecrets", () => {
  it("prompts only for unset variables and writes them into env", async () => {
    const env: NodeJS.ProcessEnv = { ALREADY_SET: "from-shell" };
    const prompt = vi.fn(async (text: string) => {
      expect(text).toBe("MISSING: ");
      return "secret-value";
    });
    const log = vi.fn();

    await applyPromptSecrets(["ALREADY_SET", "MISSING"], { env, prompt, log });

    expect(env.ALREADY_SET).toBe("from-shell");
    expect(env.MISSING).toBe("secret-value");
    expect(prompt).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("Using existing ALREADY_SET from the environment.");
  });

  it("rejects an empty prompted value", async () => {
    const env: NodeJS.ProcessEnv = {};
    await expect(
      applyPromptSecrets(["TOKEN"], { env, prompt: async () => "", log: () => {} }),
    ).rejects.toThrow(/TOKEN is required/);
  });

  it("rejects invalid env var names", async () => {
    await expect(applyPromptSecrets(["bad-name"], { env: {}, prompt: async () => "x" })).rejects.toThrow(
      /Invalid --prompt-secret name/,
    );
  });
});

describe("promptSecret", () => {
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const originalSetRawMode = process.stdin.setRawMode?.bind(process.stdin);

  afterEach(() => {
    vi.restoreAllMocks();
    process.stdin.removeAllListeners("data");
    if (typeof process.stdin.setRawMode === "function") {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore when not a TTY in CI
      }
    }
    if (originalIsTTY) {
      Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
    }
    if (originalSetRawMode) {
      process.stdin.setRawMode = originalSetRawMode;
    }
  });

  it("rejects when stdin is not a TTY", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    delete (process.stdin as { setRawMode?: unknown }).setRawMode;
    await expect(promptSecret("TOKEN: ")).rejects.toThrow(/stdin is not a TTY/);
  });

  it("collects characters, supports backspace, and resolves on enter", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    const setRawMode = vi.fn();
    process.stdin.setRawMode = setRawMode as typeof process.stdin.setRawMode;
    const resume = vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
    const pause = vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
    const setEncoding = vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const pending = promptSecret("SECRET: ");
    await Promise.resolve();

    process.stdin.emit("data", "ab");
    process.stdin.emit("data", "\u0001");
    process.stdin.emit("data", "\u007f");
    process.stdin.emit("data", Buffer.from("c\r"));

    await expect(pending).resolves.toBe("ac");
    expect(setRawMode).toHaveBeenCalledWith(true);
    expect(setRawMode).toHaveBeenCalledWith(false);
    expect(resume).toHaveBeenCalled();
    expect(pause).toHaveBeenCalled();
    expect(setEncoding).toHaveBeenCalledWith("utf8");
    expect(stderrWrite).toHaveBeenCalledWith("SECRET: ");
    expect(stderrWrite).toHaveBeenCalledWith("\n");
  });

  it("rejects on Ctrl+C", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    const setRawMode = vi.fn();
    process.stdin.setRawMode = setRawMode as typeof process.stdin.setRawMode;
    vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
    vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
    vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const pending = promptSecret("SECRET: ");
    await Promise.resolve();
    process.stdin.emit("data", "\u0003");

    await expect(pending).rejects.toThrow(/Interrupted/);
    expect(setRawMode).toHaveBeenCalledWith(false);
  });
});
