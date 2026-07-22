#!/usr/bin/env node
/**
 * Minimal stdio MCP server for bridge-generator tests.
 *
 * Behavior flags (argv):
 *   --zero-tools       tools/list returns an empty array
 *   --malformed-tool   tools/list includes a tool without a name
 *   --paginated        tools/list returns two pages
 *   --no-server-info   initialize result omits serverInfo
 *   --silent           never responds (for timeout tests)
 *   --exit-early       exits before responding to initialize
 */
import { createInterface } from "node:readline";

const flags = new Set(process.argv.slice(2));

const TOOLS = [
  {
    name: "create_issue",
    title: "Create Issue",
    description: "Create an issue in a repository.",
    inputSchema: {
      type: "object",
      required: ["owner", "repo", "title"],
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
      },
    },
    outputSchema: {
      type: "object",
      required: ["number"],
      properties: { number: { type: "integer" } },
    },
    annotations: {
      destructiveHint: false,
      readOnlyHint: false,
      openWorldHint: true,
    },
    icons: [{ src: "https://example.test/create-issue.png", mimeType: "image/png" }],
    _meta: { "example.test/category": "issues" },
  },
  {
    name: "delete_branch",
    description: "Delete a branch from a repository.",
    annotations: { destructiveHint: true, idempotentHint: true },
    inputSchema: {
      type: "object",
      required: ["owner", "repo", "branch"],
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        branch: { type: "string" },
      },
    },
  },
  {
    name: "merge_pull_request",
    description: "Merge a pull request into its base branch.",
    inputSchema: {
      type: "object",
      required: ["owner", "repo", "pull_number"],
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        pull_number: { type: "integer" },
        merge_method: { type: "string", enum: ["merge", "squash", "rebase"] },
      },
    },
  },
];

if (flags.has("--exit-early")) {
  process.exit(7);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (flags.has("--silent")) {
    return;
  }
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.method === "initialize") {
    const result = {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      ...(flags.has("--no-server-info") ? {} : { serverInfo: { name: "mock-mcp", version: "1.2.3" } }),
    };
    send({ jsonrpc: "2.0", id: request.id, result });
    return;
  }
  if (request.method === "tools/list") {
    let tools = TOOLS;
    if (flags.has("--zero-tools")) {
      tools = [];
    } else if (flags.has("--malformed-tool")) {
      tools = [...TOOLS, { description: "tool with no name", inputSchema: { type: "object" } }];
    }
    if (flags.has("--paginated")) {
      const secondPage = request.params?.cursor === "page-2";
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: secondPage ? { tools: tools.slice(1) } : { tools: tools.slice(0, 1), nextCursor: "page-2" },
      });
    } else {
      send({ jsonrpc: "2.0", id: request.id, result: { tools } });
    }
    return;
  }
  if (typeof request.id === "number") {
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
  }
});
