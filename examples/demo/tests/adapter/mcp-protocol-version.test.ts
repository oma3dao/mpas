import { describe, expect, it } from "vitest";
import { withInitializeProtocolVersion } from "../../src/adapter/dispatch/mcp-protocol-version.js";

describe("withInitializeProtocolVersion", () => {
  it("returns non-record messages unchanged", () => {
    expect(withInitializeProtocolVersion(null as never, "2024-11-05")).toBeNull();
    expect(withInitializeProtocolVersion("not-jsonrpc" as never, "2024-11-05")).toBe("not-jsonrpc");
  });

  it("rewrites initialize params.protocolVersion", () => {
    const rewritten = withInitializeProtocolVersion(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "old" } } as never,
      "2024-11-05",
    );
    expect(rewritten).toMatchObject({
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
  });
});
