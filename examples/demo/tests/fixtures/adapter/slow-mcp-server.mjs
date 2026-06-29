import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  const request = JSON.parse(line);
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
  }, 100);
});
