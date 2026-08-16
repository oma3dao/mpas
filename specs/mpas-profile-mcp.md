# MPAS MCP Execution Profile

**Status:** Draft v0.1
**Profile Identifier:** `did:web:profiles.oma3.org:mcp`
**Payload Format:** `mcp.toolsCall`
**Depends on:** [MPAS Core Specification v0.2](./mpas-specification.md), [MPAS Application Plugin Profile v0.2](./mpas-profile-application-plugin.md)
**Related:** [MPAS MCP Proposer Bridge Profile](./mpas-profile-mcp-proposer-bridge-client.md), [MPAS JSON Verifier Policy Profile](./mpas-profile-policy-json.md), [MPAS HTTP Profile](./mpas-profile-http.md)

---

## 1. Overview

This profile defines how actions targeting [Model Context Protocol (MCP)](https://modelcontextprotocol.io) servers are represented, canonicalized, hashed, validated, dispatched, and rendered under MPAS.

MPAS Core deliberately does not define a universal action format. Instead, each execution profile defines the native representation of actions for a class of target systems, together with the rules that make hash binding and verification deterministic across independent implementations. This document is that definition for MCP `tools/call` operations.

An action under this profile represents a single MCP tool invocation: "call tool `name` with `arguments` on the application identified by `target.applicationDid`." The Execution Payload is the native MCP tool-call content itself — not a translation of it — so what signers approve is byte-equivalent (after canonicalization) to what executes.

This profile does not define any client-facing bridge or application interface.
Deferred results, notification responsibility, background workflow processing,
and later result retrieval are outside its scope. The companion
[MPAS MCP Proposer Bridge Profile](./mpas-profile-mcp-proposer-bridge-client.md)
defines the client-facing contract for an MPAS proposer bridge.

### 1.1 Conformance Language

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as described in RFC 2119.

### 1.2 Audience

- **Proposers** (e.g., MCP bridges) constructing Execution Payloads from agent tool calls.
- **Verifiers** (e.g., Credential Adapters, or future MCP servers with embedded verifiers) validating and dispatching payloads.
- **Plugin publishers** authoring Application Plugins for MCP-fronted applications.
- **Signer implementations** rendering payloads for review.

### 1.3 Deployment Models (Non-Normative)

This profile is agnostic to how the Verifier is deployed. Two deployment models are anticipated:

- **Credential Adapter deployment.** An MCP Bridge (Proposer) constructs the payload and Action Package from an agent's tool call. A separate Credential Adapter (Verifier) receives the package, verifies it, and dispatches the `tools/call` to the real MCP server using credentials the agent never sees. This is the current MVP architecture.
- **Native MPAS verification.** The MCP server itself embeds MPAS verification. The agent (or bridge) submits the Action Package directly to the MCP server, which verifies before executing. No adapter or bridge is needed — the MCP server IS the Verifier.

The normative rules in this profile apply identically to both models. "Verifier" is used throughout without assuming either architecture.

---

## 2. Profile Identity

An Action Envelope declares this profile as follows:

```json
"executionProfile": {
  "id": "did:web:profiles.oma3.org:mcp",
  "format": "mcp.toolsCall"
}
```

- `executionProfile.id` MUST be exactly `did:web:profiles.oma3.org:mcp`.
- `executionProfile.format` MUST be exactly `mcp.toolsCall`.
- A Verifier that does not implement this profile MUST NOT attempt to validate or execute the payload and MUST resolve the action as `rejected` with an error indicating an unsupported execution profile (wire result `notSupported` where the transport profile defines it).

> **Note:** The profile DID identifies the MPAS binding for MCP operations — how MPAS represents, hashes, and verifies MCP payloads. It does not claim governance over the MCP protocol itself, which is maintained by the Linux Foundation. If a future MCP working group adopts or supersedes this binding, a new profile DID may be minted and this one deprecated.

Future payload formats under this profile identifier (e.g., resource or prompt operations) would be registered as additional `format` values in revisions of this document.

---

## 3. Execution Payload

### 3.1 Structure

An Execution Payload under `mcp.toolsCall` MUST be a JSON object with **exactly two members**:

| Field       | Type   | Required | Description                                                                                                            |
| :---------- | :----- | :------- | :--------------------------------------------------------------------------------------------------------------------- |
| `name`      | string | REQUIRED | The MCP tool name, verbatim, as exposed by the target MCP server.                                                      |
| `arguments` | object | REQUIRED | The MCP tool-call arguments object, exactly as it would appear in `params.arguments` of an MCP `tools/call` request.   |

```json
{
  "name": "merge_pull_request",
  "arguments": {
    "owner": "oma3dao",
    "repo": "app-registry",
    "pull_number": 42,
    "merge_method": "squash"
  }
}
```

Normative rules:

1. The payload MUST contain `name` and `arguments` and MUST NOT contain any other members. A Verifier MUST reject a payload containing additional members. This rule is deliberate: any field present in the payload is covered by the hash and therefore by every Approval; fields outside this definition would be signed but have undefined execution semantics.
2. `arguments` MUST be a JSON object. For a tool that takes no arguments, `arguments` MUST be present as an empty object (`{}`). Proposers MUST normalize an absent MCP `arguments` to `{}` before hashing.
3. `name` MUST be the **native tool name** exactly as exposed by the target MCP server (e.g., `merge_pull_request`). Names MUST NOT be namespaced, prefixed, aliased, or otherwise transformed. Disambiguation between applications is provided by `actionEnvelope.target.applicationDid`, never by the tool name. (See the Application Plugin Profile, which carries the same rule for plugin operation names.)
4. `arguments` MUST be passed through from the agent's tool call without semantic modification. Proposers MUST NOT add, remove, rename, reorder-with-meaning, or default-fill argument members. (Canonicalization reorders keys lexicographically for hashing; this has no semantic effect.)

### 3.2 Exclusions

The following are **never** part of the Execution Payload and MUST NOT appear in it or influence its hash:

- JSON-RPC framing: `jsonrpc`, `id`, `method`.
- MCP request metadata: `params._meta`, including progress tokens.
- Transport headers, session identifiers, and authentication material of any kind.
- MCP client/host-injected fields not originating from the agent's tool-call arguments.

Rationale: framing and metadata vary per connection and per retry; including them would make identical intents hash differently and would leak transport details into signed artifacts.

### 3.3 Argument Value Constraints

Argument values are subject to the JSON encoding and canonicalization rules in MPAS Core §5.1.2, including the prohibition on duplicate member names and the guidance against floating-point numbers in hashed objects.

For this profile specifically: precision-sensitive values (monetary amounts, token quantities, large identifiers) MUST be typed as JSON strings in arguments, and plugin schemas SHOULD declare such fields with `"type": "string"`. This ensures canonicalization does not alter their lexical form (e.g., JCS renders `1000.00` as `1000`, losing the trailing zero). See Appendix A, vector A.4 for a worked example.

A Proposer MUST reject (and MUST NOT attempt to repair) an agent tool call whose arguments cannot be represented under these constraints.

---

## 4. Canonicalization and Hashing

### 4.1 Procedure

The `executionPayloadHash` referenced by the Action Envelope is computed as:

1. Construct the Execution Payload object per Section 3.
2. Canonicalize the entire payload object using **JCS (RFC 8785)**, producing a UTF-8 byte sequence.
3. Hash the canonical bytes with **SHA-256**.
4. Encode the digest as **base64url without padding**.

```json
"executionPayloadHash": {
  "alg": "sha-256",
  "value": "v1SsNzgjyBBDeNIzNoe7-SU_Of30Wai57epjnDT4W7s"
}
```

- `sha-256` is REQUIRED for this profile version. Other algorithms permitted by MPAS Core MAY be used only where the deployment's Verifier explicitly supports them; interoperable implementations MUST support `sha-256`.
- The hash input is the canonical bytes of the **whole payload object** — not the arguments alone, not a re-serialization with whitespace, not the raw bytes as received on the wire.
- Verifiers MUST recompute the hash from the received payload and compare it to `actionEnvelope.executionPayloadHash`; transport-level integrity is not a substitute.

### 4.2 Determinism Requirements

The determinism requirements of MPAS Core §5.1.2 apply in full, including duplicate-member-name rejection and RFC 8785–conformant JCS canonicalization (UTF-16 code-unit property-name sorting, ECMAScript number serialization).

The test vectors in Appendix A are normative: a conforming implementation MUST reproduce them exactly.

---

## 5. Payload Validation (Profile-Specific)

This section defines the MCP-specific validation that occurs during **Core §6.2.2 Step 4** ("Validate the Execution Payload Under the Declared Profile"). The generic verification steps — parsing, envelope validation, lifecycle checks, hash binding, approval verification, policy evaluation — are defined by Core §6.2.2 and are not repeated here.

After Core verification passes and the Execution Payload hash binding is confirmed, the Verifier MUST apply the following MCP-specific validation:

1. **Validate structure.** The payload MUST have exactly two members: `name` (a string) and `arguments` (an object). Any other shape MUST be rejected as malformed.
2. **Determine the routing class.** Find the plugin operation whose `name` equals the payload `name` (exact, case-sensitive string comparison), and check trusted deployment policy/configuration for an operation entry or pass-through rule. The plugin remains the normal source of operation metadata and schema validation, but a deployment MAY explicitly allow an operation that is absent from the plugin to pass through or be governed by operator policy. If the operation is absent from both trusted plugin metadata and trusted deployment configuration, the Verifier SHOULD treat it as pass-through.
3. **Validate arguments against the plugin schema when present.** If a matched plugin operation exists, evaluate the full Execution Payload against the matched operation's `executionPayloadSchema`.
   - If the schema does not explicitly permit additional properties at a given object level, unknown members at that level MUST cause rejection (fail closed). Plugin publishers SHOULD set `additionalProperties: false` explicitly; Verifiers MUST apply fail-closed semantics even when the schema is silent.
   - Schema evaluation MUST be resource-bounded (see Security Considerations).
4. **Evaluate policy.** If the operation is present in the plugin or has a trusted deployment policy entry, evaluate the Action Package against deployment policy. Deployments commonly rely on the plugin plus default policy, using config only for special cases.

Validation failures in steps 1 and 3 are deterministic properties of the payload and therefore resolve the `actionId` per the Core Action Lifecycle (§6.9) — they can never succeed on resubmission. Policy evaluation outcomes (Core §6.2.2 Steps 7–10) follow the JSON Verifier Policy Profile.

---

## 6. Dispatch Semantics

When verification and policy succeed, the Verifier dispatches the action as a native MCP `tools/call`:

1. The dispatched request's `params.name` MUST equal the payload `name` and `params.arguments` MUST be semantically identical to the payload `arguments`. The Verifier MUST NOT alter, augment, or filter either. (Re-serialization for transport is permitted; semantic content is not negotiable — it is what was signed.)
2. The Verifier supplies JSON-RPC framing (`jsonrpc`, `id`, `method: "tools/call"`) and MAY supply `params._meta` (e.g., progress tokens). These are transport concerns outside the signed payload.
3. Connection establishment, credential injection, and target addressing are deployment concerns defined by the Verifier implementation (e.g., the Credential Adapter's `executionTarget` configuration), not by this profile. Credentials MUST NOT be derived from, or appear in, the Execution Payload.
4. The Verifier MUST initialize the upstream MCP connection using the trusted installed Application Plugin's `executionProfile.protocolVersion`. The Verifier MUST NOT source or override that value from the Action Envelope, registry metadata, discovery metadata, an SDK default, or deployment configuration. Registry and discovery copies are informational and MAY be used to detect packaging drift.
5. Exactly one dispatch attempt sequence occurs per resolved authorization, governed by the MPAS Core Action Lifecycle (`executing` status, write-ahead durability, at most one Execution Receipt per actionId). Retry of transient transport failures within the single dispatch session is a Verifier deployment decision and MUST complete before the receipt is issued.

### 6.1 Outcome Mapping

| MCP dispatch outcome                                                                               | Receipt `result` |
| :------------------------------------------------------------------------------------------------- | ---------------- |
| `tools/call` response received, `isError` absent or `false`                                        | `executed`       |
| `tools/call` response received, `isError: true`                                                    | `failed`         |
| JSON-RPC error response received before execution could occur (e.g., unknown tool, invalid params) | `failed`         |
| Timeout, connection loss after send, process crash, or any outcome that cannot be confirmed        | `indeterminate`  |

A response with `isError: true` is a definitive outcome from the target (the call happened and the application reports failure); it MUST NOT be treated as unconfirmed.

#### 6.1.1 MCP ActionResponse Diagnostics

An HTTP-profile Verifier SHOULD include `ActionResponse.context.diagnostic` for the MCP dispatch conditions below. These diagnostics explain the outcome but do not alter the receipt result or Core lifecycle.

| Diagnostic `code`   | Action result    | `phase`       | Meaning |
| ------------------- | ---------------- | ------------- | ------- |
| `TARGET_UNAVAILABLE`| `rejected`       | `initialize`  | The MCP target could not be launched, connected, or initialized before the dispatch-ledger write. This is a stateless pre-dispatch rejection and has no Execution Receipt. |
| `PROCESS_EXITED`    | `indeterminate`  | `tools/call`  | A stdio MCP process exited after dispatch and before a response was confirmed. |
| `DISPATCH_TIMEOUT`  | `indeterminate`  | `tools/call`  | No definitive response was received before the dispatch timeout. |
| `TRANSPORT_ERROR`   | `indeterminate`  | `tools/call`  | The MCP transport failed after dispatch and the execution outcome cannot be confirmed. |
| `INVALID_RESPONSE`  | `failed`         | `tools/call`  | A definitive JSON-RPC or MCP protocol error was received. |

For this profile, `phase` is either `initialize` or `tools/call`. The interoperable `transport` values are `stdio` and `streamable-http`; implementations MAY define additional transport values. Messages MUST follow the sanitization requirements in the HTTP Profile Section 6.4.2 and SHOULD describe the condition without embedding raw upstream error output.

A bridge SHOULD relay the diagnostic object to the calling agent when it synthesizes a response for an outcome that has no `executionResult`. A bridge MUST preserve the result's lifecycle semantics; specifically, it MUST NOT encourage automatic resubmission of an `indeterminate` action with the same `actionId`.

### 6.2 Tool Availability Drift

Application Plugins are immutable; target MCP servers evolve. If the target server does not expose the payload's tool at dispatch time (e.g., JSON-RPC "unknown tool" error), the receipt result is `failed`. Verifiers SHOULD detect schema drift proactively (e.g., comparing the plugin's operations against the target's `tools/list` at startup or on a schedule) and surface warnings to the operator; drift detection is diagnostic and MUST NOT alter verification semantics, which are defined solely by the installed plugin.

---

## 7. Receipts and Response Material

- In this profile version, **the MCP response content is not hash-bound**. The Execution Receipt attests to the dispatch and its outcome classification (Section 6.1), bound to `actionEnvelopeHash` and `executionPayloadHash` per MPAS Core.
- The receipt's `executionRef` MAY carry an implementation-defined reference to the result (e.g., a resulting resource URL, an audit-log locator, or a digest of the response content). If response content or digests are included, they are informative, MUST NOT contain credential material, and MUST NOT be relied upon as a protocol-level attestation of output.
- Binding response/output content into receipts (output commitment) is identified as future work (Section 10).

---

## 8. Rendering Guidance (Signer Review)

Per MPAS Core, rendering is non-authoritative; Approvals bind to hashes, not renderings. For this profile, signer-facing implementations SHOULD render:

1. The application identity: `target.applicationDid` and, where available, the plugin's human-readable title.
2. The operation: the payload `name`, plus the matched plugin operation's `description` if the renderer has the plugin.
3. The complete `arguments` object, pretty-printed, with no member omitted. If any portion cannot be rendered faithfully (excessive depth, very large values, non-printable content), the renderer MUST indicate that the display is partial rather than silently truncating.
4. Envelope context: proposer DID, target resource, `expiresAt`, and `actionId`.

Renderers MUST NOT display semantic claims not derivable from the hash-covered payload and envelope (e.g., a proposer-supplied free-text justification MUST be visually distinguished from the signed content if shown at all).

---

## 9. Security Considerations

- **Exact-payload discipline.** The two-member rule (3.1) and the exclusion list (3.2) exist so that the bytes signers approve are the bytes that execute. Any relaxation (extra members, host-injected fields, namespace rewriting) reintroduces a gap between reviewed intent and executed action.
- **Fail-closed argument validation for plugin-covered operations.** Unknown argument members are rejected (§5 step 3) because an unvalidated member would ride inside a signed payload and reach the target application without ever being constrained by the plugin schema or rendered meaningfully to signers. Pass-through of operations absent from the plugin follows the plugin-anchored trust model: the plugin publisher — who typically authored or knows the target MCP server, and whose plugin is attested via OMATrust — defines the governed surface, and operations the publisher did not designate for governance proxy on the Proposer's verified signature after proposer gating. The residual risk is drift: tools added to the target after plugin publication were never reviewed by the publisher, so deployments SHOULD monitor upstream tool drift (Section 6.2). Deployments requiring a closed world MAY reject ungoverned operations via deployment configuration; this is a hardening option, not the recommended default.
- **Schema evaluation resource bounds.** Plugin-supplied JSON Schemas are third-party input to the Verifier. Implementations MUST bound schema evaluation (regex execution time or safe-regex subsets, recursion depth, document size) to prevent denial of service against the trust anchor.
- **Number canonicalization.** ECMAScript number serialization under JCS means semantically distinct lexical forms (`1.50` vs `1.5`) canonicalize identically, and very large integers lose precision. The string-typing rule (3.3) removes this class of ambiguity for sensitive values; plugin authors are the first line of enforcement via schema types.
- **TOCTOU / state binding.** This profile binds the request, not the world state it will act upon. Operations whose safety depends on current state (force-pushes, deletions, transfers) SHOULD include state preconditions as explicit arguments (e.g., an expected head SHA) so that the precondition is hash-bound and enforced by the target application. Protocol-level precondition support is future work in MPAS Core.
- **Response is unbound (v0.1).** Receipts classify outcomes but do not commit to response content (Section 7). Deployments requiring output attestation must layer it externally until output commitment is specified.

---

## 10. Future Work

- Additional `format` values for MCP resource and prompt operations.
- Output commitment: hash-binding selected MCP response content into receipts.
- Protocol-level precondition/state-binding fields, pending MPAS Core support.
- Streaming and long-running tool calls (progress-token semantics relative to the `executing` lifecycle status).
- Tool schema attestation via OMATrust (binding plugin operations to attested upstream server versions).

---

## Appendix A — Test Vectors (Normative)

Each vector lists the Execution Payload (shown pretty-printed; whitespace is irrelevant pre-canonicalization), the JCS canonical form (a single line of UTF-8), its byte length, and the resulting `executionPayloadHash.value` (`sha-256`, base64url, no padding).

### A.1 Basic payload, key reordering

Payload:

```json
{
  "name": "merge_pull_request",
  "arguments": {
    "owner": "oma3dao",
    "repo": "app-registry",
    "pull_number": 42,
    "merge_method": "squash"
  }
}
```

Canonical form (124 bytes):

```
{"arguments":{"merge_method":"squash","owner":"oma3dao","pull_number":42,"repo":"app-registry"},"name":"merge_pull_request"}
```

Hash: `v1SsNzgjyBBDeNIzNoe7-SU_Of30Wai57epjnDT4W7s`

### A.2 Empty arguments

Payload:

```json
{ "name": "list_repositories", "arguments": {} }
```

Canonical form (43 bytes):

```
{"arguments":{},"name":"list_repositories"}
```

Hash: `ZWdl9YWJPkv1Q0PAPNUZNPExf5Q2JJLtQibtV6miwCc`

### A.3 Unicode, arrays, nested objects

Payload:

```json
{
  "name": "create_issue",
  "arguments": {
    "repo": "app-registry",
    "owner": "oma3dao",
    "title": "Résumé parsing fails on emoji 😀",
    "labels": ["bug", "i18n"],
    "metadata": { "zIndex": 1, "aField": "first" }
  }
}
```

Canonical form (189 bytes; non-ASCII characters are serialized as literal UTF-8, not escaped):

```
{"arguments":{"labels":["bug","i18n"],"metadata":{"aField":"first","zIndex":1},"owner":"oma3dao","repo":"app-registry","title":"Résumé parsing fails on emoji 😀"},"name":"create_issue"}
```

Hash: `Rufh2ztC-7wjA9qsesR-GgMStXac7HdGrOIhCxpjvxg`

### A.4 Precision-sensitive value as string

Payload:

```json
{
  "name": "send_payment",
  "arguments": {
    "recipient": "acct_9921",
    "amount": "1000.00",
    "currency": "USD"
  }
}
```

Canonical form (97 bytes):

```
{"arguments":{"amount":"1000.00","currency":"USD","recipient":"acct_9921"},"name":"send_payment"}
```

Hash: `sb6XUp-5XoTZ5sIyV3x8x0s7Gk3tLTzvPDlcOb9KOJk`

Note: had `amount` been the JSON number `1000.00`, JCS would canonicalize it as `1000`, producing a different hash and discarding the lexical form — the motivating case for rule 3.3.

### A.5 Required-rejection cases (no hash; MUST be rejected)

- `{"name":"x","arguments":{},"meta":{}}` — extra top-level member (§3.1).
- `{"name":"x"}` — missing `arguments` (§3.1; proposer must normalize to `{}` before hashing, verifier rejects if absent).
- `{"name":"x","arguments":{"a":1,"a":2}}` — duplicate member name (§4.2, Core §5.1.2).
- Payload whose `arguments` contains a member not permitted by the operation schema, where the schema does not explicitly allow additional properties (§5 step 3).

---

## Appendix B — Decisions Requiring Review

These rulings close gaps that a single-implementation MVP never exercised. Each is normative as drafted; reviewers should confirm or veto explicitly.

1. **Exactly-two-members payload with fail-closed rejection of extras** (3.1). Alternative: ignore unknown members — rejected as drafted because ignored-but-signed content is unreviewable.
2. **`arguments` REQUIRED, normalized to `{}`** (3.1 rule 2). Alternative: omit when empty — rejected to avoid two hashes for one intent.
3. **Fail-closed unknown argument members even when the plugin schema is silent** (5.3). Alternative: defer entirely to the schema — rejected because schema-silence then becomes a security hole owned by nobody.
4. **Precision-sensitive values MUST be strings** (3.3). Alternative: forbid only non-representable numbers — weaker; lexical-form loss (`1.50`→`1.5`) would remain.
5. **Response content not hash-bound in v0.1** (7). Alternative: bind a response digest now — deferred for scope; receipts remain dispatch attestations.
6. **`isError: true` maps to `failed`, not `indeterminate`** (6.1) — the call definitively happened.
