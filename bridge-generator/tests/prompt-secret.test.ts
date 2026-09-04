import { describe, expect, it, vi } from "vitest";
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
  it("rejects when stdin is not a TTY", async () => {
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    try {
      await expect(promptSecret("TOKEN: ")).rejects.toThrow(/stdin is not a TTY/);
    } finally {
      if (original) {
        Object.defineProperty(process.stdin, "isTTY", original);
      } else {
        Reflect.deleteProperty(process.stdin, "isTTY");
      }
    }
  });
});
