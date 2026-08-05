# OMATrust Plugin Attestation Verification

**Status:** Implemented
**Created:** 2026-07-01
**Scope:** Credential Adapter builds an OMATrust report before loading a plugin
**Goal:** Give operators verified trust evidence for each plugin at startup, clearly distinguish technical verification from responsible-party legitimacy, and require an informed confirmation

---

## 1. Problem

The credential adapter currently verifies a plugin's integrity (artifact DID hash match) but has no mechanism to assess its trustworthiness. A plugin that has never been reviewed, or one that has a known security issue attested on-chain, is loaded the same way as a plugin with multiple positive attestations.

Operators need an evidence gate that presents what OMATrust can verify, explains
what that evidence does not prove, and requires explicit confirmation before
loading a plugin.

---

## 2. Solution Overview

After the adapter verifies a plugin's artifact hash, it calls
`buildTrustReport()` to evaluate the plugin's trust evidence and collect the
evidence shown to the operator. It always displays the result and asks
the operator whether to continue. A responsibility claim or cybersecurity
assessment is sufficient to suppress the warning; both are not required. If
neither primary signal is present—or the check is unavailable—the prompt also
contains a warning.

`canTrust()` exposes the same verdict-only evaluation for callers that do not
need the full report. Neither function decides whether a responsible party is
legitimate or trusted by the operator.

---

## 3. `canTrust` Function

```typescript
interface TrustVerdict {
  primaryEvidenceFound: boolean;
  warningRequired: boolean;
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

The function evaluates two primary-evidence checks. **Either check passing is
sufficient for `warningRequired: false`.** This is not a legitimacy verdict.
Verified linked identifiers are displayed as context, but they are not
interpreted as a third primary check.

#### Check 1: Responsibility claim

Query the OMATrust backend for a verified `responsibility-claim` on the
plugin's `did:artifact`. In the claim, `subject` is the artifact DID and
`responsibleParty` is the separate entity DID accepting responsibility for
that artifact. A returned claim has already passed its proof and the SDK check
that the attesting controller is authorized for the `responsibleParty`
identity at issuance time.

**The artifact DID does not authorize the attester**, so a verified claim only
establishes that *somebody* controls the identity they named — not that this
artifact's publisher endorsed them. Anyone may therefore attest a claim against
any artifact DID. The check counts a claim only when `responsibleParty` equals
the `publisherDid` the plugin itself declares, compared under the SDK's
`normalizeDid` from `@oma3/omatrust/identity`. That is the same normalization
`computeDidHash` applies before hashing, so the adapter uses the notion of
identity the attestations are indexed under, rather than a raw string compare
that would disagree with the backend over `www.` prefixes, DID URL fragments,
whitespace, and per-method casing. Comparison is whole-DID: no domain is
extracted, because `did:web` is DNS-bound and accepting any subdomain of the
publisher's registrable domain would let a dangling subdomain qualify. A
`responsibleParty` that cannot be normalized fails to match rather than
aborting the load.
Without that binding, an unrelated party's claim would satisfy the primary
check and suppress the operator warning on an artifact nobody legitimate had
claimed.

`publisherDid` is read from the plugin, which the loader has already
hash-verified against the configured `artifactDid`. It therefore cannot be
substituted independently of the content being vouched for, and needs no
separate trusted source. The publisher chooses that value, so it is the
publisher's responsibility to declare the identity that will claim the
artifact.

This is a primary v1 signal because it identifies an accountable entity.
Verification proves that the claim is authentic under its schema; it does not
prove that `responsibleParty` is legitimate or worthy of trust. MPAS must show
that DID to the operator, who decides whether to trust it. No attestation type
in v1 speaks to publisher legitimacy — the operator's judgement is the only
control for it.

Claims naming any other party are collected as
`unqualifiedResponsibilityClaims`. They are **not** listed at the prompt: an
operator cannot adjudicate unfamiliar DIDs on a startup screen, and printing
them competes with the claim that does count. The prompt reports their count
and writes the detail to a file. Failure to write that file never blocks
startup.

**Fails when:**
- No verified responsibility claim exists for the artifact DID
- Claims exist, but none names the plugin's declared `publisherDid`

#### Check 2: Cybersecurity assessment

At least one verified `security-assessment` whose verification basis includes
`approved-issuer` must exist. Issuer approval is the schema-specific trust
mechanism for a cybersecurity assessment.

**Fails when:**
- No cybersecurity assessment exists for the artifact DID
- A cybersecurity assessment exists but its issuer is not approved
- Other verified evidence exists without a qualifying cybersecurity assessment

Revoked, expired, malformed, and otherwise invalid records are removed by the
backend and never reach this policy check.

#### Displayed evidence: Linked identifiers

The adapter lists every verified `linked-identifier` returned in
`otherAttestations`, including the linked identifier, attester, and
verification basis. It does not compare the value with the configured
Application DID, call it a pass or failure, or infer that the artifact controls
an MCP transport endpoint. The operator decides whether a linked identifier is
relevant and trustworthy in the plugin's deployment context.

Proof and controller-authorization checks are performed by the backend.
Controller witnesses may support that verification but are not returned as
artifact evidence.

User reviews are not returned by this artifact endpoint in v1. Their schema
does not provide a verifiable binding to a `did:artifact`, so presenting them
as artifact trust evidence would overstate what they prove. Certifications may
be displayed as informational evidence but do not satisfy either primary v1
check.

### TrustContext

`TrustContext` is an internal injection point, not operator configuration.
Normal daemon startup uses the complete production Artifact Trust API URL.
RPC, schema, issuer, and verification policy remain backend concerns. MPAS
binds each endpoint context to the chain and EAS deployment it expects so a
valid response from the wrong network cannot be accepted.

```typescript
interface TrustContext {
  /** Full Artifact Trust API URL */
  artifactTrustApiUrl: string;
  /** Expected chain and EAS deployment for responses from that URL */
  expectedChain: {
    chainId: number;
    easContract: string;
  };
}
```

The default is `https://api.omatrust.org/v1/artifact-trust`, bound to OMAChain
mainnet (`chainId` 6623, CAIP-2 `eip155:6623`) and EAS contract
`0x00Bd6f0Ee99bD76273B57e6dDEc5B00850c6b76C`. The adapter rejects a response
whose chain ID, CAIP-2 identifier, or EAS contract does not match. It adds only
the encoded `artifactDid` query parameter, calls the URL once per plugin load,
and shares that response across both MPAS checks.

---

## 4. Flow

```
┌──────────────────┐     ┌─────────────────┐     ┌──────────────┐
│  Config Loader   │────▶│buildTrustReport │────▶│ OMATrust API │
│                  │     │                 │     │              │
│ 1. Load plugin   │     │ Check 1:        │     │              │
│ 2. Verify hash   │     │  attestations   │     │              │
│ 3. Build report  │◀────│ Check 2:        │◀────│              │
│ 4. Show + prompt │     │  approved issuer│     │              │
│ 5. Load or abort │     └─────────────────┘     └──────────────┘
└──────────────────┘
```

### Step-by-step:

1. Adapter loads plugin and verifies `artifactDid` hash (existing behavior)
2. Adapter calls `buildTrustReport(plugin, config, trustContext)`
3. `buildTrustReport` requests the backend's complete, verified artifact
   evidence once and rejects evidence from a different chain or EAS deployment
4. Returns a trust report with pass/fail per check and human-readable reasons
5. Adapter displays responsibility, cybersecurity, informational, and
   linked-identifier evidence
6. The prompt includes a warning only when neither primary signal exists or
   the lookup is unavailable
7. If the operator confirms → load plugin; if operator rejects → skip plugin

---

## 5. Operator Experience

### Plugin with primary evidence (no warning)

```
Plugin: github-repo (did:artifact:bafk...)
  Content integrity: verified (plugin content matches the configured did:artifact)
  OMATrust information:
    Declared publisher: did:web:publisher.example
    Responsibility claim from that publisher: FOUND
      - did:web:publisher.example; responsibility publisher, maintainer;
        verified via proof, controller-authorization, authorization-window
        Technical verification confirms the claim, but does not establish that
        the responsible party is legitimate. Decide whether you trust that party.
    Cybersecurity assessment: FOUND
      - security-assessment; issuer OMA3 Security Lab; verified via approved-issuer
    Linked identifiers (1):
      - did:web:publisher.example; issuer did:web:publisher.example;
        verified via proof, controller-authorization, authorization-window

  [y/N] Would you like to use this plugin given the information shown?
```

### Untrusted plugin (interactive prompt)

```
Plugin: sketchy-tool (did:artifact:bafk...)
  Content integrity: verified (plugin content matches the configured did:artifact)
  OMATrust information:
    WARNING: No verified responsibility claim or cybersecurity assessment was found.
    Declared publisher: did:web:publisher.example
    Responsibility claim from that publisher: NOT FOUND
    Cybersecurity assessment: NOT FOUND
    Linked identifiers (1):
      - did:web:unrecognized-publisher.example; issuer 0x1234...;
        verified via proof, controller-authorization, authorization-window

  [y/N] Would you like to use this plugin given the information shown?
```

### Artifact claimed by someone other than the declared publisher

```
Plugin: sketchy-tool (did:artifact:bafk...)
  Content integrity: verified (plugin content matches the configured did:artifact)
  OMATrust information:
    WARNING: No verified responsibility claim or cybersecurity assessment was found.
    Declared publisher: did:web:publisher.example
    Responsibility claim from that publisher: NOT FOUND
    Claims naming a different responsible party: 2 (not counted as evidence)
      Details written to /var/folders/../mpas-trust-a1b2c3/unqualified-responsibility-claims.json
    Cybersecurity assessment: NOT FOUND
    Linked identifiers (0):
      - None found.

  [y/N] Would you like to use this plugin given the information shown?
```

Before this binding existed, those two claims would have set
`primaryEvidenceFound: true` and removed the warning entirely.

### Network unreachable (graceful degradation)

```
Plugin: github-repo (did:artifact:bafk...)
  Content integrity: verified (plugin content matches the configured did:artifact)
  WARNING: OMATrust information could not be loaded.
  No OMATrust responsibility claims, attestations, linked identifiers, or
  other legitimacy and provenance evidence was loaded.

  [y/N] Would you like to use this plugin given the information shown?
```

---

## 6. Integration Point

The check hooks into `config-loader.ts` → `loadDeploymentConfigFile()`, after the existing hash verification passes (the line where `computeArtifactDid` is compared to `config.plugin.artifactDid`).

```typescript
// After hash verification passes:
let assessment;
try {
  assessment = {
    status: "checked",
    report: await buildTrustReport(
      pluginResult.plugin,
      config,
      DEFAULT_TRUST_CONTEXT,
    ),
  };
} catch (error) {
  assessment = {
    status: "notChecked",
    reason: "unavailable",
    detail: error instanceof Error ? error.message : String(error),
  };
}

const confirmed = await promptPluginUse(assessment, config);
if (!confirmed) {
  return loadError("PLUGIN_TRUST_REJECTED", "Operator declined to use the plugin.", filePath);
}
```

If the API check is unavailable, the adapter reports the failure and prompts
the operator with the degraded-mode message.
The prompt is always shown so the operator can evaluate the responsible-party
DID and other evidence; only the warning is conditional.

---

## 7. Relevant Schemas

| Schema                 | Role in `canTrust`                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `responsibility-claim` | Primary: identifies a verified responsible party and independently satisfies v1 policy                     |
| `security-assessment`  | Primary: satisfies v1 policy when verified with `approved-issuer` basis                                    |
| `linked-identifier`    | Secondary: listed for operator judgment; its authorization proof does not independently change the verdict |
| `certification`        | Informational: displayed when returned but does not satisfy either primary check                           |
| `user-review`          | Excluded: its schema cannot establish a provable `did:artifact` binding                                    |
| `controller-witness`   | Backend-only supporting evidence used to verify controller relationships; never displayed                  |

---

## 8. Trust Report

The adapter produces a `PluginTrustReport` for display and logging/audit:

```typescript
interface PluginTrustReport {
  artifactDid: string;
  pluginDid: string;
  pluginVersion: string;
  targetApplicationDid: string;
  verdict: TrustVerdict;
  attestation: {
    primaryEvidenceFound: boolean;
    responsibilityClaim: boolean;
    cybersecurityAssessment: boolean;
    responsibilityClaims: AttestationSummary[];
    attestations: AttestationSummary[];
  };
  linkedIdentifiers: LinkedIdentifierSummary[];
}

interface AttestationSummary {
  uid: string;
  attester: string;
  attesterLabel?: string;
  isApprovedIssuer: boolean;
  schemaUid: string;
  schemaLabel: string;
  time: string;
  expirationTime: string;
  verificationBasis: string[];
  data: Record<string, unknown>;
}

interface LinkedIdentifierSummary {
  uid: string;
  linkedId: string;
  attester: string;
  attesterLabel?: string;
  verificationBasis: string[];
}
```

---

## 9. Endpoint Selection

No OMATrust configuration is required in v1. MPAS uses the production/mainnet
Artifact Trust API URL and its pinned OMAChain mainnet deployment by default.
It does not expose a backend base URL, chain override, RPC URL, or API-key
setting. Tests and embedded callers may inject a different endpoint only by
also specifying its expected chain and EAS contract. A future premium endpoint
may introduce an explicit configuration contract containing the endpoint and
authentication material; that contract is outside this feature.

---

## 10. Dependencies

| Dependency              | Purpose                                       |
| ----------------------- | --------------------------------------------- |
| `omatrust-backend`      | Public verified artifact-trust API            |
| `fetch` / `AbortSignal` | Bounded HTTP lookup with a ten-second timeout |

---

## 11. Scope Boundaries

**In scope (v1):**
- `canTrust()` function with two built-in checks (responsibility claim +
  approved-issuer cybersecurity assessment)
- Display of all verified linked identifiers without a target-match verdict
- Display and confirmation for every report so the operator can judge the
  responsible party
- Warning only when both primary signals are absent or the lookup is
  unavailable; interactive confirmation for every plugin
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
