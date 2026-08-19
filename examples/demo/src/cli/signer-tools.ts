import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const signerToolNames = [
  "mpas_list_pending",
  "mpas_review_action",
  "mpas_approve",
  "mpas_reject",
] as const;

export type SignerToolName = (typeof signerToolNames)[number];
export type ReviewDecision = "approve" | "reject" | "cancel";

export interface SignerToolClient {
  connect(): Promise<void>;
  listTools(): Promise<string[]>;
  callTool(name: SignerToolName, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

export function defaultSignerConfigPath(): string {
  return join(homedir(), ".mpas", "mcp-server-configs", "maintainer-signer-config.json");
}

export function createSignerToolClient(configPath = defaultSignerConfigPath()): SignerToolClient {
  const resolvedConfigPath = resolve(configPath);
  if (!existsSync(resolvedConfigPath)) {
    throw new Error(`Signer server config not found: ${resolvedConfigPath}`);
  }

  const signerEntry = resolve(dirname(fileURLToPath(import.meta.url)), "..", "signer-server", "index.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [signerEntry, "--config", resolvedConfigPath],
    stderr: "pipe",
  });
  const client = new Client({ name: "mpas-human-maintainer-cli", version: "0.0.0" });

  return {
    async connect() {
      await client.connect(transport);
    },
    async listTools() {
      const response = await client.listTools();
      return response.tools.map((tool) => tool.name);
    },
    async callTool(name, args) {
      return await client.callTool({ name, arguments: args }) as CallToolResult;
    },
    async close() {
      await client.close();
    },
  };
}

export async function assertSignerTools(client: SignerToolClient): Promise<void> {
  const available = new Set(await client.listTools());
  const missing = signerToolNames.filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw new Error(`Signer server is missing required MCP tools: ${missing.join(", ")}`);
  }
}

export function toolResultValue(result: CallToolResult): unknown {
  if (result.isError) {
    const message = result.content
      .filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text")
      .map((item) => item.text)
      .join("\n") || "Signer tool call failed.";
    throw new Error(message);
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content
    .filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  return text;
}

export function formatSignerResult(value: unknown): string {
  if (typeof value === "string") return `${value}\n`;
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function promptReviewDecision(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<ReviewDecision> {
  if (input === process.stdin && !process.stdin.isTTY) {
    throw new Error("mpas action review requires an interactive terminal.");
  }
  const prompt = createInterface({ input, output });
  try {
    const answer = (await prompt.question("Decision [a]pprove, [r]eject, [c]ancel: ")).trim().toLowerCase();
    if (answer === "a" || answer === "approve") return "approve";
    if (answer === "r" || answer === "reject") return "reject";
    return "cancel";
  } finally {
    prompt.close();
  }
}
