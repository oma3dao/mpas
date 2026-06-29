import { createInterface } from "node:readline";

// Always responds to tools/call with a JSON-RPC error so the adapter classifies
// the dispatch as a definitive target error (INVALID_RESPONSE -> receipt "failed").
const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32000, message: "Target application rejected the request." },
    })}\n`,
  );
});
