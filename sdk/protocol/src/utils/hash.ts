import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import type { HashObject } from "../types/mpas.js";

/** Computes the MPAS SHA-256 hash of a JCS-canonicalized JSON value. */
export function computeJsonHash(value: unknown): HashObject {
  return {
    alg: "sha-256",
    value: createHash("sha256").update(canonicalize(value)).digest("base64url"),
  };
}

/** Verifies an MPAS hash against a JCS-canonicalized JSON value. */
export function verifyJsonHash(value: unknown, expected: HashObject): boolean {
  if (expected.alg !== "sha-256") {
    return false;
  }

  const actual = computeJsonHash(value);
  return actual.alg === expected.alg && actual.value === expected.value;
}

/** @deprecated Use {@link computeJsonHash}. */
export const computeHash = computeJsonHash;

/** @deprecated Use {@link verifyJsonHash}. */
export const verifyHash = verifyJsonHash;
