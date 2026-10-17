import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Never answers tools/call; appends every notifications/cancelled it receives
// to the file named by CANCEL_LOG, so tests can see the adapter cancel on timeout.
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
          serverInfo: { name: "cancel-recording-mcp-server", version: "1.0.0" },
        },
      })}\n`,
    );
    return;
  }
  if (request.method === "notifications/cancelled") {
    appendFileSync(process.env.CANCEL_LOG, `${JSON.stringify(request)}\n`);
  }
});
