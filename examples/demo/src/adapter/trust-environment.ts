import { DEFAULT_TRUST_CONTEXT, type TrustContext } from "./trust.js";

/** Operator-controlled endpoint and expected identity must change together. */
export function trustContextFromEnvironment(env: NodeJS.ProcessEnv = process.env): TrustContext {
  const keys = ["MPAS_ARTIFACT_TRUST_API_URL", "MPAS_ARTIFACT_TRUST_CHAIN_ID", "MPAS_ARTIFACT_TRUST_EAS_CONTRACT"] as const;
  const values = keys.map(key => env[key]);
  if (values.every(value => value === undefined)) return DEFAULT_TRUST_CONTEXT;
  if (values.some(value => value === undefined || value.trim() === "")) {
    throw new Error(`Artifact trust override requires all of ${keys.join(", ")}.`);
  }
  const [endpoint, chain, contract] = values as [string, string, string];
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error("Artifact trust override requires a valid HTTPS endpoint."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Artifact trust endpoint must use HTTPS without credentials, query or fragment.");
  }
  const chainId = Number(chain);
  if (!/^[1-9][0-9]*$/.test(chain) || !Number.isSafeInteger(chainId)) {
    throw new Error("Artifact trust chain ID must be a positive safe integer.");
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) {
    throw new Error("Artifact trust EAS contract must be a 20-byte hex address.");
  }
  return { artifactTrustApiUrl: url.toString(), expectedChain: { chainId, easContract: contract } };
}
