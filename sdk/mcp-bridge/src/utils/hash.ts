import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import type { HashObject } from "../types/mpas.js";

export function computeHash(obj: unknown): HashObject {
  return {
    alg: "sha-256",
    value: createHash("sha256").update(canonicalize(obj)).digest("base64url"),
  };
}

export function verifyHash(obj: unknown, expected: HashObject): boolean {
  if (expected.alg !== "sha-256") {
    return false;
  }

  const actual = computeHash(obj);
  return actual.alg === expected.alg && actual.value === expected.value;
}
