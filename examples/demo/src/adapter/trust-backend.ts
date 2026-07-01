/**
 * Client for the OMATrust-backend trust-policy API.
 *
 * Fetches the approved issuers list from the centrally managed trust anchors endpoint.
 */

import type { ApprovedIssuer, OmaTrustConfig, TrustContext } from "./trust.js";

export interface TrustAnchorsResponse {
  version: number;
  updatedAt: string;
  chains: Record<
    string,
    {
      name: string;
      easContract: string;
      schemas: Record<string, string>;
    }
  >;
  registries: Array<{
    type: string;
    issuers: Array<{ address: string; label: string; schemas?: string[] }>;
  }>;
}

/**
 * Fetches approved issuers from the OMATrust backend trust-anchors API.
 * Throws on network failure — callers should handle gracefully.
 */
export async function fetchApprovedIssuers(backendUrl: string): Promise<ApprovedIssuer[]> {
  const response = await fetch(`${backendUrl}/api/public/trust-anchors`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Trust anchors API returned ${response.status}: ${response.statusText}`);
  }

  const body = (await response.json()) as TrustAnchorsResponse;

  const approvedIssuersRegistry = body.registries.find((r) => r.type === "approved-issuers");
  if (!approvedIssuersRegistry) {
    return [];
  }

  return approvedIssuersRegistry.issuers.map((issuer) => ({
    address: issuer.address,
    label: issuer.label,
  }));
}

/**
 * Builds a TrustContext from OmaTrustConfig by fetching approved issuers from the backend.
 * Returns null if the config is disabled or missing.
 */
export async function buildTrustContext(config: OmaTrustConfig): Promise<TrustContext | null> {
  if (config.disabled) {
    return null;
  }

  const anchors = await fetchTrustAnchors(config.backendUrl);
  const approvedIssuers = extractApprovedIssuers(anchors);
  const schemaLabels = extractSchemaLabels(anchors);

  return {
    backendUrl: config.backendUrl,
    approvedIssuers,
    schemas: config.schemas,
    schemaLabels,
    rpcUrl: config.rpcUrl,
    easContractAddress: config.easContractAddress,
  };
}

/**
 * Fetches the full trust-anchors response from the backend.
 */
async function fetchTrustAnchors(backendUrl: string): Promise<TrustAnchorsResponse> {
  const response = await fetch(`${backendUrl}/api/public/trust-anchors`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Trust anchors API returned ${response.status}: ${response.statusText}`);
  }

  return (await response.json()) as TrustAnchorsResponse;
}

function extractApprovedIssuers(anchors: TrustAnchorsResponse): ApprovedIssuer[] {
  const registry = anchors.registries.find((r) => r.type === "approved-issuers");
  if (!registry) return [];
  return registry.issuers.map((issuer) => ({
    address: issuer.address,
    label: issuer.label,
  }));
}

/**
 * Builds a map from schema UID → human-readable label.
 * Inverts the chains[].schemas map (which is label → UID) to UID → label.
 */
function extractSchemaLabels(anchors: TrustAnchorsResponse): Map<string, string> {
  const labels = new Map<string, string>();
  for (const chain of Object.values(anchors.chains)) {
    for (const [label, uid] of Object.entries(chain.schemas)) {
      labels.set(uid, label);
    }
  }
  return labels;
}
