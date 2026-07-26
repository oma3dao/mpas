import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export function withInitializeProtocolVersion(
  message: JSONRPCMessage,
  protocolVersion: string,
): JSONRPCMessage {
  if (!isRecord(message)) {
    return message;
  }

  const record: Record<string, unknown> = message;
  if (record.method !== "initialize" || !isRecord(record.params)) {
    return message;
  }

  return {
    ...record,
    params: {
      ...record.params,
      protocolVersion,
    },
  } as unknown as JSONRPCMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
