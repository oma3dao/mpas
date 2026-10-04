import { computeJsonHash } from "../utils/hash.js";
import type { HashObject, UpstreamBinding } from "../types/mpas.js";

/** JCS hash of complete tools/list definitions sorted by UTF-16 tool name. */
export function computeToolSurfaceHash<T extends { name: string }>(tools: readonly T[]): HashObject {
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error("Duplicate tool names");
  return computeJsonHash([...tools].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Extract explicit OCI content pins, never resolve floating tags over the network. */
export function upstreamDigestFromArgs(args: readonly string[]): string | undefined {
  const pins = [...new Set(args.flatMap(arg => {
    const match = /^[^\s]+@(sha256:[a-fA-F0-9]{64})$/.exec(arg);
    return match ? [match[1]!.toLowerCase()] : [];
  }))];
  if (pins.length > 1) throw new Error("Ambiguous upstream image digest pins");
  return pins[0];
}

/** Non-authoritative deployment synchronization. Never authorize from this value. */
export function upstreamBindingMatches(binding: UpstreamBinding | undefined, surface: HashObject | undefined, digest?: string): boolean {
  if (!binding) return surface === undefined; // legacy plugin compatibility
  if (!surface || binding.toolSurface.alg !== surface.alg || binding.toolSurface.value !== surface.value) return false;
  return binding.upstreamDigest === digest;
}
