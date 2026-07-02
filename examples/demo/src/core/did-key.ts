/**
 * Re-exports DID key utilities from @oma3/mpas.
 * This file exists so that existing imports from "../core/did-key.js" continue to work.
 */
export { deriveDidKey, didKeyToKid, generateEd25519Key } from "@oma3/mpas/did-key";
export type { GeneratedKey } from "@oma3/mpas/did-key";
