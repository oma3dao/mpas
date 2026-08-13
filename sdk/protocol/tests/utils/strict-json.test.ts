import { describe, expect, it } from "vitest";
import { DuplicateJsonKeyError, strictJsonParse } from "../../src/utils/strict-json.js";

describe("strictJsonParse", () => {
  it("parses valid JSON identically to JSON.parse", () => {
    const samples = [
      '{"name":"merge_pull_request","arguments":{"owner":"oma3dao","pull_number":42}}',
      '{"a":[1,2.5,-3e2,true,false,null,"s"],"b":{"c":{}},"d":[]}',
      '"plain string"',
      "42",
      "-0.5e-3",
      "true",
      "null",
      '{"unicode":"Résumé 😀","escaped":"line\\nbreak \\u0041"}',
      '  { "ws" : [ 1 , 2 ] }  ',
    ];
    for (const text of samples) {
      expect(strictJsonParse(text)).toEqual(JSON.parse(text));
    }
  });

  it("rejects duplicate member names at the top level", () => {
    expect(() => strictJsonParse('{"a":1,"a":2}')).toThrow(DuplicateJsonKeyError);
  });

  it("rejects duplicate member names in nested objects (MCP profile A.5)", () => {
    expect(() => strictJsonParse('{"name":"x","arguments":{"a":1,"a":2}}')).toThrow(DuplicateJsonKeyError);
  });

  it("rejects duplicates hidden by escape sequences", () => {
    // "a" decodes to "a" — same member name per RFC 8785 semantics.
    expect(() => strictJsonParse('{"a":1,"\\u0061":2}')).toThrow(DuplicateJsonKeyError);
  });

  it("rejects duplicates inside arrays of objects", () => {
    expect(() => strictJsonParse('[{"k":1},{"x":1,"x":2}]')).toThrow(DuplicateJsonKeyError);
  });

  it("allows the same member name in sibling objects", () => {
    expect(strictJsonParse('{"a":{"k":1},"b":{"k":2}}')).toEqual({ a: { k: 1 }, b: { k: 2 } });
  });

  it("parses __proto__ as an ordinary own member without changing the object prototype", () => {
    const parsed = strictJsonParse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(parsed.__proto__).toEqual({ polluted: true });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("reports the key and path of the duplicate", () => {
    try {
      strictJsonParse('{"outer":{"dup":1,"dup":2}}');
      expect.unreachable("should have thrown");
    } catch (error) {
      const duplicate = error as DuplicateJsonKeyError;
      expect(duplicate.key).toBe("dup");
      expect(duplicate.jsonPath).toBe("$.outer");
    }
  });

  it("rejects malformed JSON", () => {
    for (const text of ['{"a":1', "{a:1}", '{"a" 1}', "[1,]", '{"a":1}x', "", "01", "'single'"]) {
      expect(() => strictJsonParse(text)).toThrow(SyntaxError);
    }
  });

  it("rejects unterminated strings and mid-array junk", () => {
    expect(() => strictJsonParse('"abc')).toThrow(/Unterminated string/);
    expect(() => strictJsonParse("[1 2]")).toThrow(/Expected "," or "]"/);
  });
});
