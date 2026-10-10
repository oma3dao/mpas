import { createInterface } from "node:readline";

// Always responds to tools/call with a JSON-RPC error so the adapter classifies
// the dispatch as a definitive target error (INVALID_RESPONSE -> receipt "failed").
const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "error-mcp-server", version: "1.0.0" },
        },
      })}\n`,
    );
    return;
  }
  if (request.method === "notifications/initialized") {
    return;
  }
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32603, message: "Target application rejected the request." },
    })}\n`,
  );
});
