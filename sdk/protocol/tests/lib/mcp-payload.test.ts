import { describe, expect, it } from "vitest";
import { validateMcpPayloadStructure } from "../../src/lib/mcp-payload.js";

describe("validateMcpPayloadStructure (MCP profile §3.1 / §5 step 1)", () => {
  it("accepts a payload with exactly name and arguments", () => {
    const result = validateMcpPayloadStructure({ name: "merge_pull_request", arguments: { pull_number: 42 } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.name).toBe("merge_pull_request");
      expect(result.arguments).toEqual({ pull_number: 42 });
    }
  });

  it("accepts empty arguments", () => {
    expect(validateMcpPayloadStructure({ name: "list_repositories", arguments: {} }).ok).toBe(true);
  });

  it("rejects extra top-level members (A.5)", () => {
    const result = validateMcpPayloadStructure({ name: "x", arguments: {}, meta: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PAYLOAD_STRUCTURE_INVALID");
      expect(result.error.message).toContain("meta");
    }
  });

  it("rejects missing arguments (A.5)", () => {
    const result = validateMcpPayloadStructure({ name: "x" });
    expect(result.ok).toBe(false);
  });

  it("rejects non-object arguments", () => {
    expect(validateMcpPayloadStructure({ name: "x", arguments: [] }).ok).toBe(false);
    expect(validateMcpPayloadStructure({ name: "x", arguments: "s" }).ok).toBe(false);
    expect(validateMcpPayloadStructure({ name: "x", arguments: null }).ok).toBe(false);
  });

  it("rejects non-string or empty name", () => {
    expect(validateMcpPayloadStructure({ name: 42, arguments: {} }).ok).toBe(false);
    expect(validateMcpPayloadStructure({ name: "", arguments: {} }).ok).toBe(false);
  });

  it("rejects non-object payloads", () => {
    expect(validateMcpPayloadStructure("payload").ok).toBe(false);
    expect(validateMcpPayloadStructure([]).ok).toBe(false);
    expect(validateMcpPayloadStructure(null).ok).toBe(false);
  });
});
