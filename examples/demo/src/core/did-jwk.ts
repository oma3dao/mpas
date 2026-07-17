/**
 * Re-exports DID utilities from @oma3/mpas.
 * This file exists so that imports from "../core/did-jwk.js" resolve locally.
 */
export { deriveDidJwk, didJwkToJwk, didJwkToKid, isDidJwk, generateEd25519Key } from "@oma3/mpas/did-jwk";
export type { GeneratedKey } from "@oma3/mpas/did-jwk";
