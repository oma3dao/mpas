#!/usr/bin/env node
/**
 * MPAS echo/dry-run MCP server.
 *
 * Serves as both the unit-test fixture for mcp-stdio dispatch and the demo's
 * Target MCP Server (executionTarget in deployment configs).
 *
 * Returns GitHub-shaped responses per operation so that an LLM agent can
 * interpret the result naturally.  Clearly signals that the action was
 * validated through the full MPAS pipeline but was NOT dispatched to GitHub.
 *
 * Security invariant: the credential (injected via
 * process.env.GITHUB_PERSONAL_ACCESS_TOKEN) is NEVER included in any response.
 * Only a boolean `credentialPresent` field indicates whether one was received.
 */
import { createInterface } from "node:readline";

const tools = [
  {
    name: "create_issue",
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
    name: "delete_branch",
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
    name: "merge_pull_request",
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
  {
    name: "close_issue",
    description: "Close an existing issue.",
    inputSchema: {
      type: "object",
      required: ["owner", "repo", "issueNumber"],
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        issueNumber: { type: "integer" },
      },
      additionalProperties: false,
    },
  },
];

function handleToolCall(name, args) {
  const credentialPresent = Boolean(process.env.GITHUB_PERSONAL_ACCESS_TOKEN);

  switch (name) {
    case "create_issue":
      return {
        mode: "dry_run",
        pid: process.pid,
        credentialPresent,
        message: "MPAS dry run: issue creation validated but not dispatched to GitHub.",
        simulated_result: {
          number: 1,
          title: args.title,
          html_url: `https://github.com/${args.owner}/${args.repo}/issues/1`,
          state: "open",
        },
      };

    case "delete_branch":
      return {
        mode: "dry_run",
        pid: process.pid,
        credentialPresent,
        message: "MPAS dry run: branch deletion validated but not dispatched to GitHub.",
        simulated_result: {
          deleted: true,
          ref: args.branch,
        },
      };

    case "merge_pull_request":
      return {
        mode: "dry_run",
        pid: process.pid,
        credentialPresent,
        message: "MPAS dry run: merge validated but not dispatched to GitHub.",
        simulated_result: {
          merged: true,
          sha: "dry-run-no-real-sha",
          message: "Pull request merge simulated",
        },
      };

    case "close_issue":
      return {
        mode: "dry_run",
        pid: process.pid,
        credentialPresent,
        message: "MPAS dry run: issue close validated but not dispatched to GitHub.",
        simulated_result: {
          number: args.issueNumber ?? 1,
          state: "closed",
        },
      };

    default:
      return null;
  }
}

// --- MCP stdio transport ---

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

const lines = createInterface({ input: process.stdin });
let initialized = false;

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
      serverInfo: { name: "mpas-echo-dry-run-server", version: "1.0.0" },
    });
    return;
  }

  if (method === "notifications/initialized") {
    initialized = true;
    return; // no response needed
  }

  if (method === "tools/list") {
    if (!initialized) {
      respondError(id, -32002, "MCP client must initialize before listing tools.");
      return;
    }
    respond(id, { tools });
    return;
  }

  if (method === "tools/call") {
    if (!initialized) {
      respondError(id, -32002, "MCP client must initialize before calling tools.");
      return;
    }
    const result = handleToolCall(params.name, params.arguments ?? {});
    if (result === null) {
      respondError(id, -32601, `Unknown tool: ${params.name}`);
      return;
    }
    respond(id, {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    });
    return;
  }

  respondError(id, -32601, `Method not found: ${method}`);
});
