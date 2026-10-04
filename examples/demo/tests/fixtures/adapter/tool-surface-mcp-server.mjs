import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

const tools = JSON.parse(process.argv[2]);
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  let result;
  if (request.method === "initialize") {
    result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: "tool-surface-fixture", version: "1" } };
  } else if (request.method === "tools/list") {
    result = { tools };
  } else if (request.method === "tools/call") {
    writeFileSync(process.argv[3], "unexpected dispatch");
    result = { content: [], isError: true };
  }
  if (result) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});
