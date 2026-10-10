#!/usr/bin/env node
import { createInterface } from "node:readline";

const expectedProtocolVersion = process.env.EXPECTED_MCP_PROTOCOL_VERSION ?? "2024-11-05";
const requiresStdioArgument = process.env.REQUIRE_STDIO_ARGUMENT === "1";

if (requiresStdioArgument && process.argv[2] !== "stdio") {
  process.exit(64);
}

const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  const request = JSON.parse(line);

  if (request.method === "initialize") {
    if (request.params?.protocolVersion !== expectedProtocolVersion) {
      // Reproduce an upstream CLI that closes during initialization when the
      // client offers a protocol revision it does not support.
      process.exit(78);
    }

    respond(request.id, {
      protocolVersion: expectedProtocolVersion,
      capabilities: { tools: {} },
      serverInfo: {
        name: "protocol-version-fixture",
        version: "1.0.0",
      },
    });
    return;
  }

  if (request.method === "tools/call") {
    respond(request.id, {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            initialized: true,
            protocolVersion: expectedProtocolVersion,
            credentialPresent: Boolean(process.env.GITHUB_PERSONAL_ACCESS_TOKEN),
          }),
        },
      ],
    });
  }
});

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
