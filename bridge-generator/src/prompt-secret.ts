import { stdin, stderr } from "node:process";

/**
 * Prompt on stderr for a secret value with echo disabled (like an SSH key passphrase).
 * Characters are not written to the terminal; Ctrl+C cancels.
 */
export async function promptSecret(prompt: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Cannot prompt for a secret: stdin is not a TTY.");
  }

  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  let value = "";
  return await new Promise<string>((resolve, reject) => {
    const onData = (chunk: string | Buffer): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const char of text) {
        if (char === "\n" || char === "\r") {
          cleanup();
          stderr.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          cleanup();
          stderr.write("\n");
          reject(new Error("Interrupted."));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        // Ignore other control characters.
        if (char < " ") {
          continue;
        }
        value += char;
      }
    };

    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };

    stdin.on("data", onData);
  });
}

/**
 * Ensure each env var is set. Already-set vars are left alone; missing ones are
 * read via a hidden TTY prompt and written into `env` (defaults to process.env).
 */
export async function applyPromptSecrets(
  names: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    prompt?: (promptText: string) => Promise<string>;
    log?: (message: string) => void;
  } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const prompt = options.prompt ?? promptSecret;
  const log = options.log ?? ((message: string) => stderr.write(`${message}\n`));

  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid --prompt-secret name: ${name}`);
    }
    if (env[name]) {
      log(`Using existing ${name} from the environment.`);
      continue;
    }
    const value = await prompt(`${name}: `);
    if (!value) {
      throw new Error(`${name} is required (empty value).`);
    }
    env[name] = value;
  }
}
