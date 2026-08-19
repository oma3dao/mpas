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

export function createSignerToolClient(
  configPath = defaultSignerConfigPath(),
  diagnosticStream: Pick<NodeJS.WritableStream, "write"> = process.stderr,
  signerEntry = resolve(dirname(fileURLToPath(import.meta.url)), "..", "signer-server", "index.js"),
): SignerToolClient {
  const resolvedConfigPath = resolve(configPath);
  if (!existsSync(resolvedConfigPath)) {
    throw new Error(`Signer server config not found: ${resolvedConfigPath}`);
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [signerEntry, "--config", resolvedConfigPath],
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer | string) => diagnosticStream.write(chunk));
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

function structuredToolResult(result: CallToolResult, toolName: SignerToolName): Record<string, unknown> {
  if (result.isError) {
    const message = result.content
      .filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text")
      .map((item) => item.text)
      .join("\n") || "Signer tool call failed.";
    throw new Error(message);
  }
  if (!isRecord(result.structuredContent)) {
    throw new Error(`${toolName} returned missing or malformed structured content.`);
  }
  return result.structuredContent;
}

export function pendingResultValue(result: CallToolResult): Record<string, unknown> {
  const value = structuredToolResult(result, "mpas_list_pending");
  if (!Array.isArray(value.approvalRequests)) {
    throw new Error("mpas_list_pending returned malformed structured content: approvalRequests must be an array.");
  }
  for (const [index, request] of value.approvalRequests.entries()) {
    if (!readActionId(request, ["actionRef", "actionId", "value"])) {
      throw new Error(`mpas_list_pending returned malformed structured content: approvalRequests[${index}] has no Action ID.`);
    }
  }
  return value;
}

export function reviewResultValue(result: CallToolResult, requestedActionId: string): Record<string, unknown> {
  const value = structuredToolResult(result, "mpas_review_action");
  if (!isRecord(value.approvalRequest) || !isRecord(value.reviewSet)) {
    throw new Error("mpas_review_action returned malformed structured content: approvalRequest and reviewSet are required.");
  }
  const approvalRequestActionId = readActionId(value.approvalRequest, ["actionRef", "actionId", "value"]);
  const reviewSetActionId = readActionId(value.reviewSet, ["actionEnvelope", "actionId", "value"]);
  if (!approvalRequestActionId || !reviewSetActionId) {
    throw new Error("mpas_review_action returned malformed structured content: review Action IDs are required.");
  }
  if (approvalRequestActionId !== requestedActionId || reviewSetActionId !== requestedActionId) {
    throw new Error(
      `mpas_review_action returned an Action ID mismatch: requested ${requestedActionId}, ` +
      `approval request ${approvalRequestActionId}, review set ${reviewSetActionId}.`,
    );
  }
  return value;
}

export function decisionResultValue(
  result: CallToolResult,
  toolName: "mpas_approve" | "mpas_reject",
  requestedActionId: string,
): Record<string, unknown> {
  const value = structuredToolResult(result, toolName);
  if (!isRecord(value.approval)) {
    throw new Error(`${toolName} returned malformed structured content: approval is required.`);
  }
  const actionId = readActionId(value.approval, ["actionId", "value"]);
  if (!actionId) {
    throw new Error(`${toolName} returned malformed structured content: approval Action ID is required.`);
  }
  if (actionId !== requestedActionId) {
    throw new Error(`${toolName} returned an Action ID mismatch: requested ${requestedActionId}, receipt ${actionId}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readActionId(value: unknown, path: string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === "string" && current.length > 0 ? current : undefined;
}

export function formatSignerResult(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function promptReviewDecision(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<ReviewDecision> {
  if ((input as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY !== true) {
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
