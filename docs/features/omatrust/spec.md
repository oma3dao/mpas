# OMATrust Plugin Attestation Verification

**Status:** Draft  
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

```typescript
interface TrustContext {
  /** OMATrust SDK instance for querying attestations */
  sdk: OmaTrustSdk;
  /** OMATrust backend URL for fetching trusted issuers */
  backendUrl: string;
  /** Schema UIDs to query */
  schemas: {
    securityAssessment: string;
    certification: string;
    userReview: string;
    linkedIdentifier: string;
    controllerWitness: string;
  };
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
4. Returns `TrustVerdict` with pass/fail per check and human-readable reasons
5. If either check passes → `trusted: true`, load plugin
6. If both checks fail → prompt operator with reasons, ask to confirm or abort
7. If operator confirms → load plugin; if operator rejects → skip plugin

---

## 5. Operator Experience

### Trusted plugin (no prompt)

```
Plugin: github-repo (did:artifact:bafk...)
  ✓ Trust verified
    Attested by: OMA3 Security Lab (security-assessment)
    Linked to: github.com (controller-witness)
  Loading plugin...
```

### Untrusted plugin (interactive prompt)

```
Plugin: sketchy-tool (did:artifact:bafk...)
  ⚠️  Plugin has a low trust score. Do you want to continue?

  Reasons:
  • Zero attestations: No attestations found for this artifact on OMATrust.
  • No linkage: did:artifact is not linked to the URL this plugin targets (api.example.com).
    Without linkage, there is no trusted issuer that vouches for this plugin's
    association with its declared target.

  [y/N] Continue loading this plugin?
```

### Network unreachable (graceful degradation)

```
Plugin: github-repo (did:artifact:bafk...)
  ⚠️  OMATrust check skipped: network unavailable
  Cannot verify trust posture. Do you want to continue? [y/N]
```

---

## 6. Integration Point

The check hooks into `config-loader.ts` → `loadDeploymentConfigFile()`, after the existing hash verification passes (the line where `computeArtifactDid` is compared to `config.plugin.artifactDid`).

```typescript
// After hash verification passes:
const verdict = await canTrust(pluginResult.plugin, config, trustContext);

if (!verdict.trusted) {
  const confirmed = await promptOperator(verdict, config);
  if (!confirmed) {
    return loadError("PLUGIN_TRUST_REJECTED", "Operator declined to load untrusted plugin.", filePath);
  }
}
```

If `canTrust` throws (network failure, SDK error), the adapter treats it as untrusted and prompts the operator with the degraded-mode message.

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

If `disabled: true` or no config is provided, the adapter skips `canTrust` and loads plugins as it does today (no regression).

---

## 10. Dependencies

| Dependency | Purpose |
|---|---|
| `omatrust-sdk` | `getAttestationsForDid`, `deduplicateReviews`, `calculateAverageUserReviewRating`, linkage queries |
| `omatrust-backend` | Trust-policy API (provides the approved issuers list) |
| `ethers` | JSON-RPC provider for on-chain queries |
| EAS on OMAchain | Source of attestation and linkage data |
| DNS resolver | For DNS TXT record linkage verification |

---

## 11. Scope Boundaries

**In scope (v1):**
- `canTrust()` function with two built-in checks (attestation + linkage)
- Interactive operator prompt when trust fails
- Graceful degradation when network is unavailable
- Trust report for logging/audit
- `disabled` flag to skip entirely

**Out of scope (future):**
- Configurable trust policy (operator-defined rules, thresholds)
- Strict mode (auto-reject without prompting)
- Non-interactive mode for CI (pre-approved plugin allowlists)
- Runtime re-verification after initial load
- Attestation caching
- Plugin update detection (new version → re-check)
