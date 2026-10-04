import { describe, expect, it } from "vitest";
import { computeToolSurfaceHash, upstreamBindingMatches, upstreamDigestFromArgs } from "../../src/lib/upstream-binding.js";
import { parseActionRequest } from "../../src/lib/routing.js";
const surface = computeToolSurfaceHash([]);
const request = { version: "1", type: "ActionRequest", actionPackage: { version: "1", type: "ActionPackage" } };

describe("attested surface and non-authoritative binding", () => {
  it("pins a canonical empty tool surface and sorts full definitions", () => {
    expect(surface).toEqual({ alg: "sha-256", value: "T1PNoYwrqgwDVLtfmj7L5e0Sq02OEbqHPC8RFhICuUU" });
    const a = { name: "a", inputSchema: { type: "object" } };
    const z = { name: "z", description: "Z", inputSchema: { type: "object" } };
    expect(computeToolSurfaceHash([z, a])).toEqual(computeToolSurfaceHash([a, z]));
    expect(computeToolSurfaceHash([a])).not.toEqual(computeToolSurfaceHash([{ ...a, inputSchema: { type: "string" } }]));
    expect(() => computeToolSurfaceHash([a, a])).toThrow("Duplicate");
  });
  it("preserves binding outside the Action Package and rejects malformed values", () => {
    expect(parseActionRequest({ ...request, upstreamBinding: { toolSurface: surface } }).upstreamBinding).toEqual({ toolSurface: surface });
    for (const bad of [null, {}, { toolSurface: { alg: "sha-256", value: "bad" } }, { toolSurface: surface, upstreamDigest: "latest" }, { toolSurface: surface, unknown: true }]) {
      expect(() => parseActionRequest({ ...request, upstreamBinding: bad })).toThrow();
    }
  });
  it("requires binding only after adopting a surface and compares both pins", () => {
    const pin = `sha256:${"a".repeat(64)}`;
    expect(upstreamBindingMatches(undefined, undefined)).toBe(true);
    expect(upstreamBindingMatches(undefined, surface)).toBe(false);
    expect(upstreamBindingMatches({ toolSurface: surface }, surface)).toBe(true);
    expect(upstreamBindingMatches({ toolSurface: surface }, surface, pin)).toBe(false);
    expect(upstreamBindingMatches({ toolSurface: surface, upstreamDigest: pin }, surface, pin)).toBe(true);
    expect(upstreamDigestFromArgs(["run", `image@${pin}`])).toBe(pin);
    expect(upstreamDigestFromArgs(["run", "image:latest"])).toBeUndefined();
  });
});

it("validates surface shape through the actual SDK plugin loader", async () => {
  const { readFile, mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadPlugin } = await import("../../src/lib/plugin-loader.js");
  const base = JSON.parse(await readFile(new URL("../fixtures/plugins/github-repo.json", import.meta.url), "utf8"));
  // Historical key-signature fixture carries non-profile policySuggestions.
  delete base.policySuggestions;
  const dir = await mkdtemp(join(tmpdir(), "mpas-surface-plugin-"));
  for (const [i, toolSurface] of [
    { hash: surface, toolNames: ["read"] },
    { hash: surface, toolNames: ["read", "read"] },
    { hash: { alg: "sha-256", value: "bad" }, toolNames: [] },
    { hash: surface, toolNames: [], extra: true },
  ].entries()) {
    const file = join(dir, `${i}.json`);
    await writeFile(file, JSON.stringify({ ...base, toolSurface }));
    expect((await loadPlugin(file)).ok).toBe(i === 0);
  }
});
