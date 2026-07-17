/**
 * Strict JSON parsing with duplicate-member-name rejection.
 *
 * MPAS Core §5.1.2 requires that a parser encountering duplicate member names in
 * a hashed or signed MPAS object treat the object as malformed. `JSON.parse` is
 * last-write-wins and silently discards duplicates, so this module provides a
 * conforming parser for use at ingress boundaries where the raw text is
 * available (HTTP body parsing, file loading).
 *
 * Member names are compared after escape processing (`"a"` and `"a"` are
 * the same name), matching RFC 8785 semantics.
 */

export class DuplicateJsonKeyError extends SyntaxError {
  readonly key: string;
  readonly jsonPath: string;

  constructor(key: string, jsonPath: string) {
    super(`Duplicate JSON member name ${JSON.stringify(key)} at ${jsonPath}`);
    this.name = "DuplicateJsonKeyError";
    this.key = key;
    this.jsonPath = jsonPath;
  }
}

const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

/**
 * Parses JSON text, throwing `DuplicateJsonKeyError` if any object contains a
 * duplicate member name and `SyntaxError` for any other invalid JSON. On
 * success, returns the same value `JSON.parse` would return.
 */
export function strictJsonParse(text: string): unknown {
  let index = 0;

  function error(message: string): SyntaxError {
    return new SyntaxError(`${message} at position ${index}`);
  }

  function skipWhitespace(): void {
    while (index < text.length) {
      const char = text[index];
      if (char === " " || char === "\t" || char === "\n" || char === "\r") {
        index += 1;
      } else {
        return;
      }
    }
  }

  function parseString(): string {
    if (text[index] !== '"') {
      throw error("Expected string");
    }
    const start = index;
    index += 1;
    while (index < text.length) {
      const char = text[index];
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === '"') {
        index += 1;
        // Delegate escape/control-character validation and decoding to JSON.parse.
        return JSON.parse(text.slice(start, index)) as string;
      }
      index += 1;
    }
    throw error("Unterminated string");
  }

  function parseValue(path: string): unknown {
    skipWhitespace();
    const char = text[index];
    if (char === undefined) {
      throw error("Unexpected end of input");
    }
    if (char === "{") {
      return parseObject(path);
    }
    if (char === "[") {
      return parseArray(path);
    }
    if (char === '"') {
      return parseString();
    }
    if (text.startsWith("true", index)) {
      index += 4;
      return true;
    }
    if (text.startsWith("false", index)) {
      index += 5;
      return false;
    }
    if (text.startsWith("null", index)) {
      index += 4;
      return null;
    }
    const match = NUMBER_PATTERN.exec(text.slice(index));
    if (match) {
      index += match[0].length;
      return Number(match[0]);
    }
    throw error("Unexpected token");
  }

  function parseObject(path: string): Record<string, unknown> {
    index += 1; // consume "{"
    const result: Record<string, unknown> = {};
    const seen = new Set<string>();
    skipWhitespace();
    if (text[index] === "}") {
      index += 1;
      return result;
    }
    for (;;) {
      skipWhitespace();
      const key = parseString();
      if (seen.has(key)) {
        throw new DuplicateJsonKeyError(key, path);
      }
      seen.add(key);
      skipWhitespace();
      if (text[index] !== ":") {
        throw error('Expected ":"');
      }
      index += 1;
      result[key] = parseValue(`${path}.${key}`);
      skipWhitespace();
      if (text[index] === ",") {
        index += 1;
        continue;
      }
      if (text[index] === "}") {
        index += 1;
        return result;
      }
      throw error('Expected "," or "}"');
    }
  }

  function parseArray(path: string): unknown[] {
    index += 1; // consume "["
    const result: unknown[] = [];
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return result;
    }
    for (;;) {
      result.push(parseValue(`${path}[${result.length}]`));
      skipWhitespace();
      if (text[index] === ",") {
        index += 1;
        continue;
      }
      if (text[index] === "]") {
        index += 1;
        return result;
      }
      throw error('Expected "," or "]"');
    }
  }

  const value = parseValue("$");
  skipWhitespace();
  if (index !== text.length) {
    throw error("Unexpected trailing characters");
  }
  return value;
}
