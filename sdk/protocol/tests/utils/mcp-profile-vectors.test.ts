/**
 * MCP Execution Profile — Appendix A Test Vectors (Normative)
 *
 * These tests verify that canonicalization/hashing in @oma3/mpas
 * produces results identical to the normative vectors in:
 *   specs/mpas-profile-mcp.md  Appendix A
 *
 * Profile: did:web:profiles.oma3.org:mcp, format: mcp.toolsCall
 */
import { describe, expect, it } from "vitest";
import { canonicalize } from "json-canonicalize";
import { DuplicateJsonKeyError, strictJsonParse } from "../../src/utils/strict-json.js";
import { computeHash, computeJsonHash } from "../../src/utils/hash.js";
import { validateMcpPayloadStructure } from "../../src/lib/mcp-payload.js";

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), "utf8");
}

describe("MCP Execution Profile — Appendix A test vectors", () => {
  describe("A.1 Basic payload, key reordering", () => {
    const payload = {
      name: "merge_pull_request",
      arguments: {
        owner: "oma3dao",
        repo: "app-registry",
        pull_number: 42,
        merge_method: "squash",
      },
    };

    it("produces the correct canonical form", () => {
      expect(canonicalize(payload)).toBe(
        '{"arguments":{"merge_method":"squash","owner":"oma3dao","pull_number":42,"repo":"app-registry"},"name":"merge_pull_request"}',
      );
    });

    it("canonical bytes have length 124", () => {
      expect(canonicalBytes(payload).length).toBe(124);
    });

    it("produces the correct executionPayloadHash", () => {
      expect(computeHash(payload)).toEqual({
        alg: "sha-256",
        value: "v1SsNzgjyBBDeNIzNoe7-SU_Of30Wai57epjnDT4W7s",
      });
      expect(computeJsonHash(payload)).toEqual(computeHash(payload));
    });
  });

  describe("A.2 Empty arguments", () => {
    const payload = { name: "list_repositories", arguments: {} };

    it("produces the correct canonical form", () => {
      expect(canonicalize(payload)).toBe('{"arguments":{},"name":"list_repositories"}');
    });

    it("canonical bytes have length 43", () => {
      expect(canonicalBytes(payload).length).toBe(43);
    });

    it("produces the correct executionPayloadHash", () => {
      expect(computeHash(payload)).toEqual({
        alg: "sha-256",
        value: "ZWdl9YWJPkv1Q0PAPNUZNPExf5Q2JJLtQibtV6miwCc",
      });
    });
  });

  describe("A.3 Unicode, arrays, nested objects", () => {
    const payload = {
      name: "create_issue",
      arguments: {
        repo: "app-registry",
        owner: "oma3dao",
        title: "Résumé parsing fails on emoji 😀",
        labels: ["bug", "i18n"],
        metadata: { zIndex: 1, aField: "first" },
      },
    };

    it("produces the correct canonical form (literal UTF-8, not \\u-escaped)", () => {
      expect(canonicalize(payload)).toBe(
        '{"arguments":{"labels":["bug","i18n"],"metadata":{"aField":"first","zIndex":1},"owner":"oma3dao","repo":"app-registry","title":"Résumé parsing fails on emoji 😀"},"name":"create_issue"}',
      );
    });

    it("canonical bytes have length 189", () => {
      expect(canonicalBytes(payload).length).toBe(189);
    });

    it("produces the correct executionPayloadHash", () => {
      expect(computeHash(payload)).toEqual({
        alg: "sha-256",
        value: "Rufh2ztC-7wjA9qsesR-GgMStXac7HdGrOIhCxpjvxg",
      });
    });
  });

  describe("A.4 Precision-sensitive value as string", () => {
    const payload = {
      name: "send_payment",
      arguments: {
        recipient: "acct_9921",
        amount: "1000.00",
        currency: "USD",
      },
    };

    it("produces the correct canonical form", () => {
      expect(canonicalize(payload)).toBe(
        '{"arguments":{"amount":"1000.00","currency":"USD","recipient":"acct_9921"},"name":"send_payment"}',
      );
    });

    it("canonical bytes have length 97", () => {
      expect(canonicalBytes(payload).length).toBe(97);
    });

    it("produces the correct executionPayloadHash", () => {
      expect(computeHash(payload)).toEqual({
        alg: "sha-256",
        value: "sb6XUp-5XoTZ5sIyV3x8x0s7Gk3tLTzvPDlcOb9KOJk",
      });
    });

    it("demonstrates that JSON number 1000.00 would produce a DIFFERENT hash", () => {
      const numericPayload = {
        name: "send_payment",
        arguments: {
          recipient: "acct_9921",
          amount: 1000.0,
          currency: "USD",
        },
      };
      const canonical = canonicalize(numericPayload);
      expect(canonical).toContain('"amount":1000');
      expect(canonical).not.toContain('"amount":"1000.00"');
      expect(computeHash(numericPayload).value).not.toBe("sb6XUp-5XoTZ5sIyV3x8x0s7Gk3tLTzvPDlcOb9KOJk");
    });
  });

  describe("A.5 Required-rejection cases", () => {
    it("extra top-level member is rejected (Section 3.1)", () => {
      const result = validateMcpPayloadStructure({ name: "x", arguments: {}, meta: {} });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("PAYLOAD_STRUCTURE_INVALID");
        expect(result.error.message).toContain("meta");
      }
    });

    it("missing arguments is rejected (Section 3.1)", () => {
      const result = validateMcpPayloadStructure({ name: "x" });
      expect(result.ok).toBe(false);
    });

    it("duplicate member names are rejected (Section 4.2)", () => {
      expect(() => strictJsonParse('{"name":"x","arguments":{"a":1,"a":2}}')).toThrow(DuplicateJsonKeyError);
    });
  });
});
