#!/usr/bin/env node
/**
 * Minimal MCP server that wraps the GitHub REST API for the MPAS demo.
 * Exposes: create_issue_demo, delete_branch_demo, merge_pull_request_demo.
 * Requires GITHUB_PERSONAL_ACCESS_TOKEN in the environment.
 */
import { createInterface } from "node:readline";

const TOKEN = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
const API = "https://api.github.com";

const tools = [
  {
    name: "create_issue_demo",
    description: "Create a new issue in a GitHub repository.",
    inputSchema: {
      type: "object",
      required: ["owner", "repo", "title"],
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "delete_branch_demo",
    description: "Delete a branch from a GitHub repository.",
    inputSchema: {
      type: "object",
      required: ["owner", "repo", "branch"],
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        branch: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "merge_pull_request_demo",
    description: "Merge a pull request.",
    inputSchema: {
      type: "object",
      required: ["owner", "repo", "pullNumber", "baseRef", "expectedHeadSha", "mergeMethod"],
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        pullNumber: { type: "integer" },
        baseRef: { type: "string" },
        expectedHeadSha: { type: "string" },
        mergeMethod: { type: "string", enum: ["merge", "squash", "rebase"] },
      },
      additionalProperties: false,
    },
  },
];

async function handleToolCall(name, args) {
  switch (name) {
    case "create_issue_demo": {
      const res = await gh("POST", `/repos/${args.owner}/${args.repo}/issues`, {
        title: args.title,
        body: args.body ?? "",
        labels: args.labels ?? [],
      });
      return res;
    }
    case "delete_branch_demo": {
      const ref = `heads/${args.branch}`;
      const res = await gh("DELETE", `/repos/${args.owner}/${args.repo}/git/refs/${ref}`);
      return res ?? { deleted: true, ref: args.branch };
    }
    case "merge_pull_request_demo": {
      const res = await gh("PUT", `/repos/${args.owner}/${args.repo}/pulls/${args.pullNumber}/merge`, {
        merge_method: args.mergeMethod ?? "merge",
      });
      return res;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function gh(method, path, body) {
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mpas-demo-github-mcp-server",
    },
  };
  if (body) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, options);
  if (res.status === 204) return null;
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${json.message ?? JSON.stringify(json)}`);
  }
  return json;
}

// --- MCP stdio transport ---

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

const lines = createInterface({ input: process.stdin });

// Keep process alive while async operations are in flight.
let pending = 0;

lines.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = request;

  if (method === "initialize") {
    respond(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "mpas-demo-github-server", version: "1.0.0" },
    });
    return;
  }

  if (method === "notifications/initialized") {
    return; // no response needed
  }

  if (method === "tools/list") {
    respond(id, { tools });
    return;
  }

  if (method === "tools/call") {
    pending++;
    handleToolCall(params.name, params.arguments ?? {})
      .then((result) => {
        respond(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      })
      .catch((error) => {
        respond(id, {
          content: [{ type: "text", text: error.message }],
          isError: true,
        });
      })
      .finally(() => {
        pending--;
      });
    return;
  }

  respondError(id, -32601, `Method not found: ${method}`);
});

// Don't exit until all in-flight requests complete.
lines.on("close", () => {
  const check = () => {
    if (pending === 0) process.exit(0);
    else setTimeout(check, 50);
  };
  check();
});
