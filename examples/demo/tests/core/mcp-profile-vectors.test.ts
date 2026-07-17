/**
 * MCP Execution Profile — Appendix A Test Vectors (Normative)
 *
 * These tests verify that the canonicalization/hashing in mpas-local
 * produces results identical to the normative vectors in:
 *   mpas-docs/specification/mpas-profile-mcp.md  Appendix A
 *
 * Profile: did:web:profiles.oma3.org:mcp, format: mcp.toolsCall
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "json-canonicalize";
import { DuplicateJsonKeyError, strictJsonParse, validateMcpPayloadStructure, validatePayloadAgainstPlugin } from "@oma3/mpas";
import { computeJsonHash } from "../../src/core/verification.js";

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
      const canonical = canonicalize(payload);
      expect(canonical).toBe(
        '{"arguments":{"merge_method":"squash","owner":"oma3dao","pull_number":42,"repo":"app-registry"},"name":"merge_pull_request"}',
      );
    });

    it("canonical bytes have length 124", () => {
      expect(canonicalBytes(payload).length).toBe(124);
    });

    it("produces the correct executionPayloadHash", () => {
      const hash = computeJsonHash(payload);
      expect(hash).toEqual({
        alg: "sha-256",
        value: "v1SsNzgjyBBDeNIzNoe7-SU_Of30Wai57epjnDT4W7s",
      });
    });
  });

  describe("A.2 Empty arguments", () => {
    const payload = { name: "list_repositories", arguments: {} };

    it("produces the correct canonical form", () => {
      const canonical = canonicalize(payload);
      expect(canonical).toBe('{"arguments":{},"name":"list_repositories"}');
    });

    it("canonical bytes have length 43", () => {
      expect(canonicalBytes(payload).length).toBe(43);
    });

    it("produces the correct executionPayloadHash", () => {
      const hash = computeJsonHash(payload);
      expect(hash).toEqual({
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
      const canonical = canonicalize(payload);
      expect(canonical).toBe(
        '{"arguments":{"labels":["bug","i18n"],"metadata":{"aField":"first","zIndex":1},"owner":"oma3dao","repo":"app-registry","title":"Résumé parsing fails on emoji 😀"},"name":"create_issue"}',
      );
    });

    it("canonical bytes have length 189", () => {
      expect(canonicalBytes(payload).length).toBe(189);
    });

    it("produces the correct executionPayloadHash", () => {
      const hash = computeJsonHash(payload);
      expect(hash).toEqual({
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
      const canonical = canonicalize(payload);
      expect(canonical).toBe(
        '{"arguments":{"amount":"1000.00","currency":"USD","recipient":"acct_9921"},"name":"send_payment"}',
      );
    });

    it("canonical bytes have length 97", () => {
      expect(canonicalBytes(payload).length).toBe(97);
    });

    it("produces the correct executionPayloadHash", () => {
      const hash = computeJsonHash(payload);
      expect(hash).toEqual({
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
      // JCS canonicalizes 1000.00 → 1000 (ECMAScript number serialization)
      const canonical = canonicalize(numericPayload);
      expect(canonical).toContain('"amount":1000');
      expect(canonical).not.toContain('"amount":"1000.00"');
      // Hash will differ
      const hash = computeJsonHash(numericPayload);
      expect(hash.value).not.toBe("sb6XUp-5XoTZ5sIyV3x8x0s7Gk3tLTzvPDlcOb9KOJk");
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
      const raw = '{"name":"x","arguments":{"a":1,"a":2}}';
      // JSON.parse is last-write-wins; strictJsonParse is the conforming parser
      // used at the adapter and coordination ingress boundaries.
      expect(() => strictJsonParse(raw)).toThrow(DuplicateJsonKeyError);
    });

    it("unknown argument member rejected when schema silent on additionalProperties (§5 step 3)", () => {
      const plugin = {
        version: "1",
        type: "MpasApplicationPlugin",
        pluginDid: "did:web:plugins.example:x",
        pluginVersion: "1.0.0",
        publisherDid: "did:web:publisher.example",
        applicationDid: "did:web:app.example",
        executionProfile: { id: "did:web:profiles.oma3.org:mcp", format: "mcp.toolsCall" },
        operations: {
          x: {
            description: "silent schema",
            executionPayloadSchema: {
              type: "object",
              required: ["name", "arguments"],
              properties: {
                name: { const: "x" },
                // Deliberately silent on additionalProperties at both levels.
                arguments: { type: "object", properties: { known: { type: "string" } } },
              },
            },
          },
        },
      } as unknown as Parameters<typeof validatePayloadAgainstPlugin>[1];

      const valid = validatePayloadAgainstPlugin({ name: "x", arguments: { known: "a" } }, plugin);
      expect(valid.ok).toBe(true);

      const smuggled = validatePayloadAgainstPlugin({ name: "x", arguments: { known: "a", unknown: "b" } }, plugin);
      expect(smuggled.ok).toBe(false);
      if (!smuggled.ok) {
        expect(smuggled.error.code).toBe("PAYLOAD_SCHEMA_INVALID");
      }
    });
  });
});
