# OMATrust Plugin Attestation Verification

**Status:** Draft  
**Created:** 2026-07-01
**Scope:** Credential Adapter evaluates plugin trustworthiness via `canTrust` before loading  
**Goal:** Give operators a clear trust/no-trust signal for each plugin at startup, prompting for confirmation when trust cannot be established

---

## 1. Problem

The credential adapter currently verifies a plugin's integrity (artifact DID hash match) but has no mechanism to assess its trustworthiness. A plugin that has never been reviewed, or one that has a known security issue attested on-chain, is loaded the same way as a plugin with multiple positive attestations.

Additionally, there's no verification that the plugin is legitimately associated with the service it claims to proxy. A malicious plugin could claim to target `github.com` without any proof of association.

Operators need a trust gate — similar to SSH unknown-host-key prompts — that evaluates trust and requires explicit confirmation before loading untrusted plugins.

---

## 2. Solution Overview

After the adapter verifies a plugin's artifact hash, it calls `canTrust()` to evaluate the plugin's trust posture. If the plugin is not trusted, the operator is prompted with specific reasons and must explicitly confirm before the plugin is loaded.

The `canTrust` function is a single evaluation boundary. Its internal checks will evolve over time (and may eventually become policy-driven), but its contract with the rest of the system is stable: it takes a plugin and returns a verdict with reasons.

---

## 3. `canTrust` Function

```typescript
interface TrustVerdict {
  trusted: boolean;
  reasons: TrustReason[];
}

interface TrustReason {
  check: string;
  passed: boolean;
  message: string;
}

async function canTrust(
  plugin: MpasApplicationPlugin,
  config: DeploymentConfig,
  trustContext: TrustContext,
): Promise<TrustVerdict>
```

### v1 Checks

The function evaluates two checks. **Either check passing is sufficient for `trusted: true`.**

#### Check 1: Attestation from approved issuer

Query OMATrust for attestations on the plugin's `did:artifact`. At least one non-revoked, non-expired attestation from an approved issuer must exist (any schema: security-assessment, certification, or user-review).

**Fails when:**
- Zero attestations exist for the artifact DID
- Attestations exist but none are from an approved issuer
- All attestations from approved issuers are revoked or expired

#### Check 2: Linked identifier (artifact → target URL)

Verify that the `did:artifact` is linked to the plugin's declared target URL (the downstream service it proxies). This is analogous to code signing — it proves the entity controlling the artifact also controls (or is vouched for by) the target service.

Linkage is established by any of:
- **Linked-identifier attestation** on-chain tying the `did:artifact` to the target domain (must include a valid proof)
- **Controller-witness attestation** showing common control between the artifact DID and the target URL's DID
- **DNS TXT record** at the target domain containing the `did:artifact` value
- **`/.well-known/did.json`** at the target domain listing the `did:artifact` in its DID document

**Fails when:**
- No linkage exists between the artifact DID and the plugin's declared target URL via any of the above methods
- A linked-identifier attestation exists but its proof is invalid or missing
- The plugin claims to proxy `github.com` but there's no proof the artifact is associated with GitHub

### TrustContext

`TrustContext` is a derived runtime object. Operators provide `OmaTrustConfig`;
the adapter fetches current trust anchors and constructs this object. It is not
an operator-authored file format.

```typescript
interface TrustContext {
  /** OMATrust backend URL used for trust anchors and controller checks */
  backendUrl: string;
  /** Approved issuers derived from current trust anchors */
  approvedIssuers: Array<{
    address: string;
    label: string;
  }>;
  /** Schema UIDs to query */
  schemas: {
    securityAssessment: string;
    certification: string;
    userReview: string;
    linkedIdentifier: string;
    controllerWitness: string;
  };
  /** Optional schema UID to human-readable label mapping */
  schemaLabels?: Map<string, string>;
  /** RPC endpoint for querying EAS attestations */
  rpcUrl: string;
  /** EAS contract on the configured chain */
  easContractAddress: string;
}
```

Approved issuers are fetched from the OMATrust-backend trust-policy API at startup (not hardcoded in config). This keeps the issuer list centrally managed and up-to-date without requiring operators to maintain it locally.

---

## 4. Flow

```
┌──────────────────┐     ┌─────────────────┐     ┌──────────────┐
│  Config Loader   │────▶│   canTrust()    │────▶│  EAS (chain) │
│                  │     │                 │     │              │
│ 1. Load plugin   │     │ Check 1:        │     │              │
│ 2. Verify hash   │     │  attestations   │     │              │
│ 3. canTrust()    │◀────│ Check 2:        │◀────│              │
│ 4. Prompt if no  │     │  linkage        │     │              │
│ 5. Load or abort │     └─────────────────┘     └──────────────┘
└──────────────────┘
```

### Step-by-step:

1. Adapter loads plugin and verifies `artifactDid` hash (existing behavior)
2. Adapter calls `canTrust(plugin, config, trustContext)`
3. `canTrust` queries OMATrust for attestations and linkage proofs
4. Returns a trust report with pass/fail per check and human-readable reasons
5. Adapter displays all available attestation and linkage information
6. Adapter asks the operator whether to use the plugin regardless of the aggregate verdict
7. If the operator confirms → load plugin; if operator rejects → skip plugin

---

## 5. Operator Experience

### Plugin with trusted evidence

```
Plugin: github-repo (did:artifact:bafk...)
  Content integrity: verified (plugin content matches the configured did:artifact)
  OMATrust information:
    Attestation check: PASS — Attested by: OMA3 Security Lab (security-assessment)
    Target linkage: PASS — Linked to: github.com (controller-witness)

  [y/N] Would you like to use this plugin given the information shown?
```

### Untrusted plugin (interactive prompt)

```
Plugin: sketchy-tool (did:artifact:bafk...)
  Content integrity: verified (plugin content matches the configured did:artifact)
  OMATrust information:
  Attestation check: NOT VERIFIED — Zero attestations: No attestations found for this artifact on OMATrust.
  Target linkage: NOT VERIFIED — No linkage: did:artifact is not linked to the URL this plugin targets (api.example.com).
    Without linkage, there is no trusted issuer that vouches for this plugin's
    association with its declared target.

  [y/N] Would you like to use this plugin given the information shown?
```

### Network unreachable (graceful degradation)

```
Plugin: github-repo (did:artifact:bafk...)
  Content integrity: verified (plugin content matches the configured did:artifact)
  WARNING: OMATrust context could not be loaded.
  No OMATrust attestations, approved-issuer checks, target linkage, or other
  legitimacy and provenance checks were performed.

  [y/N] Would you like to use this plugin given the information shown?
```

If no OMATrust context is configured, the adapter displays the same warning with
`No OMATrust context was provided`. Content integrity verification still occurs;
the warning concerns legitimacy, provenance, attestations, and target linkage.

---

## 6. Integration Point

The check hooks into `config-loader.ts` → `loadDeploymentConfigFile()`, after the existing hash verification passes (the line where `computeArtifactDid` is compared to `config.plugin.artifactDid`).

```typescript
// After hash verification passes:
const assessment = trustContext
  ? { status: "checked", report: await buildTrustReport(pluginResult.plugin, config, trustContext) }
  : { status: "notChecked", reason: "notConfigured" };

const confirmed = await promptPluginUse(assessment, config);
if (!confirmed) {
  return loadError("PLUGIN_TRUST_REJECTED", "Operator declined to use the plugin.", filePath);
}
```

If the trust context cannot be loaded or a check is unavailable, the adapter reports the failure and prompts the operator with the degraded-mode message.

---

## 7. Relevant Schemas

| Schema | Role in `canTrust` |
|--------|-------------------|
| `security-assessment` | Check 1: counts as attestation from approved issuer |
| `certification` | Check 1: counts as attestation from approved issuer |
| `user-review` | Check 1: counts as attestation from approved issuer |
| `linked-identifier` | Check 2: proves artifact ↔ URL linkage |
| `controller-witness` | Check 2: proves common control (artifact DID ↔ target URL DID) |

---

## 8. Trust Report

Even when trusted, the adapter produces a `PluginTrustReport` for logging/audit:

```typescript
interface PluginTrustReport {
  artifactDid: string;
  pluginDid: string;
  pluginVersion: string;
  targetUrl: string;
  verdict: TrustVerdict;
  attestations: {
    securityAssessments: AttestationSummary[];
    certifications: AttestationSummary[];
    userReviews: UserReviewSummary;
  };
  linkage: {
    linkedIdentifier: boolean;  // must have valid proof
    controllerWitness: boolean;
    dnsTxt: boolean;
    wellKnownDid: boolean;
  };
}

interface AttestationSummary {
  uid: string;
  attester: string;
  attesterLabel?: string;
  isApprovedIssuer: boolean;
  time: bigint;
  expirationTime: bigint;
  revoked: boolean;
}

interface UserReviewSummary {
  count: number;
  averageRating: number;
}
```

---

## 9. Configuration

```typescript
interface OmaTrustConfig {
  /** RPC endpoint for the chain where attestations live */
  rpcUrl: string;
  /** EAS contract address on that chain */
  easContractAddress: string;
  /** OMATrust backend URL (trust-policy API provides approved issuers) */
  backendUrl: string;
  /** Schema UIDs to query */
  schemas: {
    securityAssessment: string;
    certification: string;
    userReview: string;
    linkedIdentifier: string;
    controllerWitness: string;
  };
  /** Skip OMATrust check entirely (e.g., offline/CI environments) */
  disabled?: boolean;
}
```

Pass the configuration programmatically as `DaemonOptions.omaTrust`, or provide a
JSON file through `mpas daemon start --omatrust-config <file>` or the
`MPAS_OMATRUST_CONFIG` environment variable.

The canonical operator-facing format, complete JSON example, and startup
instructions are documented in the demo
[OMATrust Plugin Verification README section](../../../examples/demo/README.md#omatrust-plugin-verification).

If `disabled: true` or no configuration is provided, the adapter still verifies
the plugin's `did:artifact`, warns that no OMATrust legitimacy or provenance
checks were performed, and requires operator confirmation.

---

## 10. Dependencies

| Dependency | Purpose |
|---|---|
| `@oma3/omatrust` | `getAttestationsForDid`, DID conversion, and linkage queries |
| `omatrust-backend` | Trust-policy API (provides the approved issuers list) |
| `ethers` | JSON-RPC provider for on-chain queries |
| EAS on OMAchain | Source of attestation and linkage data |
| DNS resolver | For DNS TXT record linkage verification |

---

## 11. Scope Boundaries

**In scope (v1):**
- `canTrust()` function with two built-in checks (attestation + linkage)
- Interactive operator prompt after every plugin trust report
- Graceful degradation when network is unavailable
- Explicit warning and confirmation when no trust context is configured
- Trust report for logging/audit
- `disabled` flag to skip entirely

**Out of scope (future):**
- Configurable trust policy (operator-defined rules, thresholds)
- Strict mode (auto-reject without prompting)
- Non-interactive mode for CI (pre-approved plugin allowlists)
- Runtime re-verification after initial load
- Attestation caching
- Plugin update detection (new version → re-check)
