import { createInterface } from "node:readline";

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
          serverInfo: { name: "slow-mcp-server", version: "1.0.0" },
        },
      })}\n`,
    );
    return;
  }
  if (request.method === "notifications/initialized") {
    return;
  }
  setTimeout(() => {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          name: request.params.name,
          arguments: request.params.arguments,
        },
      })}\n`,
    );
  }, 3_000);
});
