# MPAS JSON Verifier Policy Profile

**Status:** Draft v0.2  
**Companion to:** MPAS Core Specification and MPAS HTTP Profile  
**Suggested filename:** `mpas-profile-policy-json.md`  
**Scope:** A deterministic JSON policy profile for MPAS Verifiers evaluating Action Packages for one Application DID and one execution profile.

## 1. Introduction

The MPAS JSON Verifier Policy Profile defines one concrete JSON policy format that a Verifier may use to evaluate MPAS Action Packages. The profile is intended to provide a simple, deterministic baseline policy architecture for implementations that need working Verifier behavior without adopting a full external policy language.

This profile is application-scoped and execution-profile-scoped. The normative policy object is `MpasApplicationPolicy`, which defines additional approval rules for one Application DID under one execution profile. A native MPAS Application may use one such policy directly. A Credential Adapter that supports many applications may maintain a trusted implementation-specific map from (Application DID, execution profile) to `MpasApplicationPolicy`, plugin configuration, operation schemas, and credential configuration. That map is outside the scope of this profile.

This profile does not define a universal action taxonomy or universal Execution Payload field names. Policy conditions are evaluated against the profile-native Execution Payload and the Action Envelope. A policy document is therefore tied to the execution profile and payload format it assumes. For the MCP execution profile, conditions commonly reference `/name` and `/arguments/...` paths. Other execution profiles define their own payload paths and policy-addressable fields.

**Policy applicability:** Policy evaluation applies only to actions that appear either in the associated application plugin's `operations` array or as a key in the `policies` object. Actions that appear in neither are subject only to proposer gating and pass through without additional approval requirements. This rule is stated once here and applies throughout this document.

The default model is that this profile describes when additional approvals are required. If the Verifier determines that the payload is supported and valid under the declared execution profile, and no JSON policy matches that action, the `defaultRequirement` determines what approvals are needed. This MUST NOT be interpreted as permission to execute arbitrary unsupported or malformed operations.

## 2. Scope and Non-Goals

### 2.1 Scope

This profile defines:

- the `MpasApplicationPolicy` JSON object;
- reusable policy objects;
- reusable signer groups;
- match and condition expressions;
- approval requirement expressions;
- default behavior for supported operations with no matching policy;
- deterministic policy evaluation semantics;
- how a Verifier using this profile maps policy results to MPAS Action responses and Authorization Requirements;
- security and conformance requirements for Verifiers implementing this profile;
- an informative alignment section comparing this profile to existing policy standards;
- a JSON Schema appendix for structural validation of `MpasApplicationPolicy` objects.

### 2.2 Non-Goals

This profile does not define:

- a universal MPAS action taxonomy;
- a universal policy engine for all MPAS deployments;
- Credential Adapter plugin architecture;
- Credential Adapter operation schemas;
- credential selection or secret-storage rules;
- application-native execution payload schemas;
- signer UX or clear-signing rendering rules;
- Coordination Service or Action Relay behavior;
- OPA/Rego, Cedar, OpenFGA, IAM, XACML, or smart-contract policy syntax;
- a normative test vector package;
- nondeterministic or LLM-based authorization.

## 3. Relationship to Core MPAS

The MPAS Core Specification defines the Action Package, Execution Payload, Action Envelope, Approval, Approval Bundle, Authorization Requirements, Execution Receipt, and Verifier role. The core Verifier receives an Action Package, validates canonical bindings, determines applicable policy from a trusted source, verifies candidate Approvals, and decides whether the action is authorized, rejected, malformed, unsupported, or requires more approvals.

This profile defines one JSON format for the Verifier policy used during that process. It does not replace the core MPAS verification procedure. A Verifier implementing this profile still performs all core MPAS validation steps, including verifying that:

- the Execution Payload matches `actionEnvelope.executionPayloadHash`;
- the Approval Bundle binds to the computed Action Envelope hash;
- every counted Approval binds to the same Action Envelope hash;
- counted Approvals are cryptographically or externally verifiable;
- signer keys or external approval sources are authorized under trusted configuration;
- the Action Envelope has not expired unless policy permits otherwise;
- replay and Action ID rules are enforced.

This profile is intentionally narrow. It defines policy evaluation for one Application DID and one execution profile. A Credential Adapter that supports many applications may maintain its own trusted configuration mapping many (Application DID, execution profile) pairs to policies, credentials, and endpoint configuration. Such configuration is outside the scope of this profile.

## 4. Policy Model Overview

### 4.1 Application-Scoped Policy

An `MpasApplicationPolicy` applies to one Application DID and one execution profile. A Verifier MUST only use an `MpasApplicationPolicy` for an Action Package whose `actionEnvelope.target.applicationDid` matches the policy's `applicationDid` and whose `actionEnvelope.executionProfile.id` matches the policy's `executionProfile.id`.

If `MpasApplicationPolicy.executionProfile.format` is present, the Verifier MUST only use the policy for Action Packages whose `actionEnvelope.executionProfile.format` matches that value. If `MpasApplicationPolicy.executionProfile.format` is omitted, the policy applies to all formats under the matching execution profile ID, unless deployment policy says otherwise.

Deployments SHOULD use distinct Application DIDs for distinct execution authorities, credential domains, or trust boundaries. For example, production and development instances may use distinct Application DIDs when they use different credentials, Verifier policies, endpoints, or operational controls.

### 4.2 Profile-Native Operations

This profile does not define a global list of operation names or assume universal Execution Payload fields. The operation or command identity is determined by the execution profile. For MCP, the tool identity is the `/name` field in the Execution Payload. For other profiles, it may be a different field or path.

Policies match specific operations by including a condition on the relevant payload field (e.g., `{"source": "executionPayload", "path": "/name", "op": "eq", "value": "payments.send_token"}`). If a policy omits such a condition, it applies to all supported actions when its other conditions match.

### 4.3 Policies as Action-Scoped Objects

The `policies` object contains policy entries keyed by action name (the operation name as defined by the execution profile, e.g., the MCP tool name). Each key maps to an array of policy entries that may include:

- match criteria (parameter-level conditions within the action);
- positive approval requirements.

All matching entries within an action's array apply. The Verifier evaluates all entries, and any whose conditions match contribute their requirements (combined with logical AND).

### 4.4 Signer Groups as Reusable Objects

The `signerGroups` object defines reusable groups of eligible Signers. Approval requirements may refer to signer groups instead of repeating the same list of Signer DIDs in every policy.

Signer groups are policy configuration. They MUST come from trusted Verifier configuration or trusted external systems, not from the Proposer, Execution Payload, Action Envelope context, Coordination Service metadata, or Action Relay metadata.

### 4.5 Default Requirement

The policy-level `defaultRequirement` applies when all of the following are true:

1. the Verifier independently determines that the requested action is supported under the declared execution profile;
2. the Execution Payload is valid under trusted application or adapter configuration;
3. no policy in this `MpasApplicationPolicy` matches the action.

If `defaultRequirement` is omitted, the Verifier MUST reject the policy as invalid. There is no implicit default. Operators MUST explicitly declare the baseline approval requirement for safety.

Production deployments SHOULD require at least one non-proposer approval as the default. A `proposerOnly` default is appropriate only for development environments or when every governed operation has an explicit policy entry. Example:

```json
{
  "type": "threshold",
  "threshold": 1,
  "eligibleSignerGroup": "maintainers",
  "decision": "approve"
}
```

### 4.5.1 Explicit Single-Party Defaults

`proposerOnly` is a valid policy requirement, but it permits a governed
operation to execute without an independent Approval. This is explicit by
construction: `defaultRequirement` is mandatory, there is no implicit default,
and threshold requirements MUST use a positive integer. An operator therefore
selects a single-party default by deliberately authoring `proposerOnly`.

The default requirement MUST NOT be used to execute an unknown, unsupported, or malformed action. Operation support and payload validation are determined by the Verifier under the declared execution profile, not by the absence of a matching policy.

**Scope — governed operations only.** `defaultRequirement` is the baseline for *governed* operations: those present in the Application Plugin or named by a policy entry. It does not apply to operations a deployment routes as pass-through (see the MCP Execution Profile §5 step 2): a pass-through operation executes on the Proposer's verified signature alone, after proposer gating (4.6), with no schema validation and no policy evaluation. This is the plugin-anchored trust model: the plugin publisher defines the governed surface, and `defaultRequirement` is the operator's baseline within it. Operators who instead require every conceivable operation to be governed should enumerate all operations in the plugin/policy or configure their deployment to deny pass-through routing (a hardening option, not the default).

### 4.6 Proposer Gating

The Verifier MUST reject any Action Package whose `actionEnvelope.proposer.did` is not recognized. Proposer gating always occurs before policy evaluation.

If `signerGroups` contains a `"proposers"` group, only DIDs in that group may submit Action Packages. If `"proposers"` is absent, the Verifier uses `signerGroups.all` as the allowed proposer set. A proposer DID not found in the applicable group MUST be rejected immediately.

## 5. JSON Policy Object Model

### 5.1 `MpasApplicationPolicy`

An `MpasApplicationPolicy` is the top-level policy object defined by this profile.

Example shape:

```json
{
  "version": "1",
  "type": "MpasApplicationPolicy",
  "policyProfileUrl": "https://github.com/oma3dao/mpas/blob/main/specs/mpas-profile-policy-json.md",
  "applicationDid": "did:web:payments.example",
  "executionProfile": {
    "id": "did:web:profiles.oma3.org:mcp",
    "format": "mcp.toolsCall"
  },
  "defaultRequirement": {
    "type": "threshold",
    "threshold": 1,
    "eligibleSignerGroup": "treasuryOperators",
    "decision": "approve"
  },
  "signerGroups": {
    "all": [
      "did:web:alice.example",
      "did:web:bob.example",
      "did:web:agent.example"
    ],
    "proposers": [
      "did:web:agent.example"
    ],
    "treasuryOperators": [
      "did:web:alice.example",
      "did:web:bob.example"
    ]
  },
  "policies": {
    "payments.send_token": [
      {
        "description": "USDC transfers above 100 require two treasury approvals.",
        "match": {
          "conditions": [
            {
              "source": "executionPayload",
              "path": "/arguments/asset",
              "op": "eq",
              "value": "USDC"
            },
            {
              "source": "executionPayload",
              "path": "/arguments/amount",
              "op": "gt",
              "value": "100"
            }
          ]
        },
        "requirements": {
          "type": "threshold",
          "threshold": 2,
          "eligibleSignerGroup": "treasuryOperators",
          "decision": "approve"
        }
      }
    ]
  }
}
```

Field definitions:

| Field | Required | Description |
| :--- | :---: | :--- |
| `version` | Yes | Policy schema version. For this profile, MUST be `"1"`. |
| `type` | Yes | MUST be `"MpasApplicationPolicy"`. |
| `policyProfileUrl` | Yes | URL identifying the policy profile this document conforms to. For this profile, MUST be `"https://github.com/oma3dao/mpas/blob/main/specs/mpas-profile-policy-json.md"`. |
| `applicationDid` | Yes | DID of the Application governed by this policy. |
| `executionProfile.id` | Yes | DID of the execution profile this policy assumes. Conditions referencing `executionPayload` paths are only meaningful under this profile. |
| `executionProfile.format` | Optional | Specific payload format under the execution profile for narrower matching. |
| `defaultRequirement` | Yes | Requirement used for supported, valid actions with no matching policy. There is no implicit default — operators MUST explicitly declare the baseline requirement. |
| `signerGroups` | Yes | Signer groups keyed by group name. Values are arrays of Signer DIDs. At minimum, the `"all"` group MUST be present. |
| `policies` | Optional | Policy objects keyed by action name (the operation name as defined by the execution profile, e.g., the MCP tool name). Values are arrays of policy entries for that action. Operators may add keys for actions beyond those declared in the plugin. Omitted means an empty policy set. |
| `context` | Optional | Non-authoritative descriptive metadata about the policy document. MUST NOT affect evaluation. |

### 5.2 Policy Objects

A policy entry defines either the positive Approval requirements that apply or a deterministic rejection. A Boolean `reject` field distinguishes these behaviors. If `reject` is omitted, it defaults to `false` for compatibility with existing policy documents.

Example requirement entry (one entry in the array for action `"github.delete_repository"`):

```json
{
  "description": "Deleting repositories requires two admin approvals.",
  "match": {},
  "requirements": {
    "type": "threshold",
    "threshold": 2,
    "eligibleSignerGroup": "admins",
    "decision": "approve"
  }
}
```

Example reject entry:

```json
{
  "reject": true,
  "description": "Repository deletion is disabled for this deployment.",
  "match": {}
}
```

Since the action name is already the key in the `policies` object, conditions within `match` only need to express additional constraints (e.g., parameter-level conditions). An empty `match` or omitted `match` means the policy applies to all invocations of that action.

Field definitions:

| Field | Required | Description |
| :--- | :---: | :--- |
| `reject` | Optional | Boolean deterministic-rejection flag. Defaults to `false` when omitted. |
| `description` | Optional | Human-readable explanation. Non-authoritative. |
| `match` | Optional | Additional conditions determining when this entry applies within the action. Since the action name is already matched by the policy key, conditions here express parameter-level constraints (e.g., target branch, amount thresholds). Omitted or empty means the entry applies to all invocations of the action. |
| `requirements` | Conditional | Positive requirement expression. Required when `reject` is omitted or `false`, and MUST be absent when `reject` is `true`. |
| `context` | Optional | Non-authoritative metadata. MUST NOT affect evaluation. |

A matching entry with `reject: true` is a deterministic policy rejection. It does not describe an Approval requirement and cannot be satisfied or overridden by collecting additional ordinary Approvals. If any reject entry matches an action, rejection overrides all matching requirement entries for that action.

The Verifier MUST reject a policy as invalid if `reject` is not Boolean, an entry with `reject: true` contains `requirements`, or an entry with `reject` omitted or `false` omits `requirements`.

### 5.3 Match Objects

A match object identifies the conditions under which a policy applies.

Example:

```json
{
  "conditions": [
    {
      "source": "executionPayload",
      "path": "/name",
      "op": "eq",
      "value": "payments.send_token"
    },
    {
      "source": "executionPayload",
      "path": "/arguments/amount",
      "op": "gt",
      "value": "100"
    }
  ]
}
```

Field definitions:

| Field | Required | Description |
| :--- | :---: | :--- |
| `conditions` | Optional | Array of condition objects. All conditions MUST evaluate true for the match to apply. |

If `conditions` is omitted or empty, the condition set evaluates true and the policy matches every supported, valid action governed by this policy document.

### 5.4 Conditions

Conditions compare trusted policy inputs against expected values.

Condition shape:

```json
{
  "source": "executionPayload",
  "path": "/arguments/amount",
  "op": "gt",
  "value": "100"
}
```

Field definitions:

| Field | Required | Description |
| :--- | :---: | :--- |
| `source` | Yes | Source object to evaluate. |
| `path` | Conditional | JSON Pointer into the source object. Required unless the source is a fixed scalar value. |
| `op` | Yes | Comparison operator. |
| `value` | Conditional | Comparison value. Required for most operators except `exists` and `notExists`. |

Supported condition sources:

| Source | Description |
| :--- | :--- |
| `executionPayload` | The profile-native Execution Payload exactly as submitted and hash-bound. For MCP, this is the object with `name` and `arguments`. |
| `actionEnvelope` | The Action Envelope, including `target`, `executionProfile`, `proposer`, `actionId`, `createdAt`, and `expiresAt`. The Action Envelope does not contain `context` or `coordination` fields in v0.2. |

Conditions with `source: "executionPayload"` require the Execution Payload to be JSON or require the execution profile to define a deterministic JSON policy view of the payload. If the execution profile does not expose a JSON-addressable representation, policies using `executionPayload` paths cannot be evaluated and the Verifier MUST return `notSupported` or `policyUnavailable` according to deployment policy.

A condition whose `source` is `actionEnvelope` MUST NOT reference paths that do not exist in the v0.2 Action Envelope structure. The Action Envelope does not contain `context` or `coordination` fields.

The Verifier MUST validate the Execution Payload under the declared execution profile before evaluating policy conditions that reference `executionPayload` paths.

Supported operators:

| Operator | Meaning |
| :--- | :--- |
| `eq` | Actual value equals expected value. |
| `neq` | Actual value does not equal expected value. |
| `in` | Actual value is contained in expected array. |
| `notIn` | Actual value is not contained in expected array. |
| `gt` | Actual numeric value is greater than expected numeric value. |
| `gte` | Actual numeric value is greater than or equal to expected numeric value. |
| `lt` | Actual numeric value is less than expected numeric value. |
| `lte` | Actual numeric value is less than or equal to expected numeric value. |
| `exists` | Value exists at the specified path. |
| `notExists` | Value does not exist at the specified path. |
| `contains` | Actual array value contains the expected scalar value. |
| `prefix` | Actual string value begins with expected string prefix. |

Numeric comparisons MUST be deterministic. Implementations SHOULD parse numeric strings and JSON numbers using arbitrary-precision decimal arithmetic. If a value required for a numeric comparison cannot be parsed as a number, the Verifier SHOULD treat the Action Package as malformed unless trusted application validation already rejected it.

For operators other than `exists` and `notExists`, a missing path evaluates false. Verifiers MUST NOT rely on this behavior as a substitute for profile-specific payload validation. Payload structure validation occurs outside this policy object model.

### 5.5 Approval Requirement Expressions

Approval requirement expressions describe which verified Approvals are required when a policy applies.

Supported requirement types in this profile:

- `proposerOnly`
- `threshold`
- `allOf`
- `anyOf`

#### 5.5.1 `proposerOnly`

`proposerOnly` means the Proposer's valid Approval is sufficient and no additional Signer Approvals are required.

```json
{
  "type": "proposerOnly"
}
```

The Verifier MUST still verify the Proposer Approval and all core MPAS bindings before authorizing or executing the action.

#### 5.5.2 `threshold`

`threshold` requires a minimum number of verified Approvals from eligible Signers.

```json
{
  "type": "threshold",
  "threshold": 2,
  "eligibleSignerGroup": "treasuryOperators",
  "decision": "approve",
  "description": "Requires approval from at least two treasury operators."
}
```

Field definitions:

| Field | Required | Description |
| :--- | :---: | :--- |
| `type` | Yes | MUST be `"threshold"`. |
| `threshold` | Yes | Positive integer number of required verified Approvals. |
| `eligibleSignerGroup` | Conditional | Signer group ID. Required unless `eligibleSigners` is present. |
| `eligibleSigners` | Conditional | Explicit array of eligible Signer DIDs. Required unless `eligibleSignerGroup` is present. |
| `decision` | Optional | Approval decision that satisfies the requirement. Defaults to `"approve"`. This profile MUST NOT be used with `decision: "reject"` in requirement expressions. See below. |
| `description` | Optional | Human-readable explanation. Non-authoritative. |

**Reject as a policy requirement:** This profile does not support `decision: "reject"` in requirement expressions. A Signer's `reject` decision is valid workflow and audit information — Signers may express disagreement through a signed Approval with `decision: "reject"`. However, policy MUST NOT depend on collecting `reject` Approvals as a blocking mechanism, because a Proposer-assembled Approval Bundle can simply omit them (censorship problem). If the Verifier determines that an Action should be rejected, it does so as a deterministic policy outcome (result: `rejected`), not because it collected a reject Approval. Future trusted blocking/cancellation profiles with Verifier-discoverable blocking evidence may revisit this constraint.

Exactly one of `eligibleSignerGroup` or `eligibleSigners` SHOULD be present. If both are present, the Verifier MUST either reject the policy as invalid or define a deterministic intersection/union rule in a future profile. This profile RECOMMENDS rejecting such policies as invalid.

#### 5.5.3 `allOf`

`allOf` requires all nested requirements to be satisfied.

```json
{
  "type": "allOf",
  "requirements": [
    {
      "type": "threshold",
      "threshold": 2,
      "eligibleSignerGroup": "treasuryOperators"
    },
    {
      "type": "threshold",
      "threshold": 1,
      "eligibleSignerGroup": "treasuryAdmins"
    }
  ]
}
```

#### 5.5.4 `anyOf`

`anyOf` requires at least one nested requirement to be satisfied.

```json
{
  "type": "anyOf",
  "requirements": [
    {
      "type": "threshold",
      "threshold": 2,
      "eligibleSignerGroup": "treasuryOperators"
    },
    {
      "type": "threshold",
      "threshold": 1,
      "eligibleSignerGroup": "treasuryAdmins"
    }
  ]
}
```

### 5.6 Signer Groups

Signer groups define named sets of eligible Signers. Each group is a JSON object property whose value is an array of Signer DIDs.

Example:

```json
{
  "all": ["did:web:alice.example", "did:web:bob.example", "did:web:carol.example", "did:web:agent.example"],
  "proposers": ["did:web:agent.example"],
  "maintainers": ["did:web:alice.example", "did:web:bob.example", "did:web:carol.example"]
}
```

#### Reserved Group Names

| Group Name | Required | Description |
| :--- | :---: | :--- |
| `all` | Yes | Every DID that may interact with the system (proposers and approvers). A DID MUST appear in `all` to be recognized by the Verifier. |
| `proposers` | Optional | DIDs allowed to submit Action Packages. If absent, all DIDs in `all` may propose. |
| `maintainers` | Optional | Default eligible approvers. If a threshold requirement does not specify `eligibleSignerGroup` or `eligibleSigners`, the Verifier MAY fall back to `maintainers`. If absent, no implicit fallback group exists. |

All other group names are custom and defined by the operator for use in policy rules.

Signer groups MUST be treated as trusted Verifier configuration. A Proposer MUST NOT be able to create, modify, select, or weaken signer group membership through Execution Payload parameters, Action Envelope context, or coordination metadata.

## 6. Policy Evaluation Semantics

### 6.1 Inputs

The policy evaluator receives:

- a validated MPAS Action Package;
- the computed Action Envelope hash;
- the Application DID from `actionEnvelope.target.applicationDid`;
- the execution profile from `actionEnvelope.executionProfile`;
- the profile-native Execution Payload;
- the Action Envelope;
- the verified candidate Approvals needed for policy evaluation;
- the trusted `MpasApplicationPolicy` for the (Application DID, execution profile) pair.

This profile does not define how payload validity is determined. The Verifier MUST determine whether the requested action is supported and whether the Execution Payload can be safely interpreted under the declared execution profile before the policy default can authorize execution. The Verifier obtains this knowledge from its trusted configuration, which may come from the native Application or from Credential Adapter per-application configuration.

### 6.2 Candidate Policy Selection

The Verifier looks up the action name in the `policies` object. Since policies are keyed by action name, the Verifier selects the policy entry matching the operation being requested. If a matching entry exists, all conditions in its `match.conditions` (if present) are evaluated.

A policy entry matches if:

1. the action name matches the policy key; AND
2. every condition in `match.conditions`, if present, evaluates true.

If a policy entry has no `match` object or its `match.conditions` is empty, the policy matches whenever the action name matches the key.

### 6.3 Condition Evaluation

All conditions inside a match object are combined with logical AND. A condition set with zero conditions evaluates true.

A condition evaluates against the source selected by its `source` field. JSON Pointer paths are resolved against that source object. For example, with `source: "executionPayload"`, the path `/arguments/amount` refers to the `arguments.amount` field in the profile-native Execution Payload. With `source: "actionEnvelope"`, the path `/target/resource` refers to `actionEnvelope.target.resource`.

The Verifier MUST evaluate conditions deterministically. A Verifier MUST NOT use nondeterministic LLM output, untrusted summaries, or coordination-channel statements as authoritative condition inputs.

### 6.4 Requirement Combination

If no policy entry matches (no key for the action name, or conditions evaluate false), the Verifier uses `defaultRequirement`.

If one or more matching entries have `reject: true`, the policy outcome is `rejected`. Rejection overrides all matching requirement entries, regardless of whether their requirements are currently satisfied. The Verifier MUST NOT return Authorization Requirements for a rejected action.

Otherwise, each matching entry is a requirement entry (an omitted `reject` is treated as `false`). If one requirement entry matches, the Verifier uses that entry's requirements. If multiple requirement entries within the same action's array match, all contribute their requirements (combined with logical AND).

Since policies are keyed by action name, there is at most one key per action. Multiple conditional requirements for the same action are expressed as multiple entries in the array. Cross-action policies are not supported; use `defaultRequirement` for baseline behavior across all governed operations.

### 6.5 Approval Counting

A Verifier MUST verify an Approval before counting it toward any requirement. Verification includes core MPAS Approval verification and any key authorization or external approval validation required by policy.

For threshold requirements:

- only Approvals binding to the computed Action Envelope hash may be counted;
- only Approvals with the required `decision` value may be counted;
- only Approvals from eligible Signers may be counted;
- duplicate Approvals from the same Signer MUST NOT be counted more than once for the same threshold requirement;
- an Approval from the Proposer MUST NOT count toward a threshold requirement for the same action. A Signer who is also the Proposer of an action is ineligible to satisfy approval thresholds for that action, regardless of signer group membership. This prevents self-approval.

Signer independence requirements, organization diversity requirements, and cross-domain signer constraints are outside this v0.2 profile and may be defined by future profiles or deployment-specific policy.

### 6.6 Policy Results

Policy evaluation produces one of the following policy outcomes:

| Outcome | Meaning |
| :--- | :--- |
| `authorized` | Current verified Approvals satisfy the combined requirements. |
| `additionalApprovalsRequired` | The action is structurally valid but does not satisfy current policy; the Proposer may construct a replacement Action and collect the described Approvals. |
| `rejected` | The action is rejected by policy and cannot be satisfied by collecting ordinary additional Approvals. |
| `notSupported` | The Application DID, execution profile, or action is not supported by the Verifier. |
| `malformed` | The Action Package or Execution Payload is structurally invalid or cannot be safely interpreted. |
| `policyUnavailable` | The Verifier cannot load or evaluate required trusted policy configuration. |

For a matched reject entry, a transport that supports structured response details SHOULD use error code `ACTION_BLOCKED_BY_POLICY` and a safe generic message identifying the requested action as blocked by policy. A policy entry's `description` is non-authoritative operator metadata and MUST NOT be exposed automatically, because it may contain sensitive policy rationale.

## 7. Verifier Evaluation Procedure

A Verifier implementing this profile performs the core MPAS verification procedure and then applies this profile as follows.

### 7.1 Load Application Policy

The Verifier determines the Application DID from `actionEnvelope.target.applicationDid` and the execution profile from `actionEnvelope.executionProfile.id`, then loads the trusted `MpasApplicationPolicy` for that (Application DID, execution profile) pair.

The Verifier MUST reject or return `policyUnavailable` if policy cannot be loaded. The Verifier MUST reject or return `notSupported` if the loaded policy's `applicationDid` does not match the Action Envelope target Application DID or the policy's `executionProfile.id` does not match the Action Envelope execution profile.

### 7.2 Validate Operation Support and Payload Structure

Before applying a default requirement, the Verifier MUST determine that:

- the requested action is supported under the declared execution profile;
- the Execution Payload is valid under trusted configuration;
- the Execution Payload can be safely interpreted and translated, if applicable.

This validation is not defined by this policy profile. The Verifier obtains payload validity knowledge from trusted configuration (native Application internals or Credential Adapter per-application configuration).

If the action is unsupported, the Verifier returns `notSupported`. If the payload is malformed or cannot be safely interpreted, the Verifier returns `malformed`.

### 7.3 Evaluate Policies

The Verifier looks up the action name in the `policies` object as described in Section 6.

If no policy entry matches the action, the Verifier uses `defaultRequirement`.

If any entry with `reject: true` matches the action, the Verifier produces the `rejected` policy outcome immediately. Otherwise, each matching requirement entry contributes its `requirements`.

### 7.4 Build Combined Requirements

When no reject entry matches, the Verifier combines all matching requirement entries with logical AND. If exactly one requirement entry matches, the Verifier may use its requirements directly. If no entry matches, the Verifier uses `defaultRequirement`.

### 7.5 Verify and Count Approvals

The Verifier selects candidate Approvals from the Approval Bundle and verifies those needed to satisfy, block, or otherwise affect policy.

The Verifier MUST NOT count an Approval unless it has been verified and binds to the computed Action Envelope hash.

### 7.6 Produce Action Response

If requirements are satisfied, the Verifier returns or produces the MPAS result appropriate to the transport and execution profile, such as `authorized`, `executed`, or an Execution Receipt.

If requirements are not satisfied but could be satisfied by additional Approvals, the Verifier returns `additionalApprovalsRequired` and SHOULD return Authorization Requirements.

If an entry with `reject: true` matched, the Verifier returns `rejected`, MUST NOT return Authorization Requirements, and MUST NOT dispatch the action. If the action is otherwise rejected, malformed, unsupported, or policy cannot be evaluated, the Verifier returns the corresponding MPAS result.

### 7.7 Produce Authorization Requirements

When the Verifier returns `additionalApprovalsRequired`, it SHOULD produce an Authorization Requirements object.

For this profile:

- Authorization Requirements MUST bind to the computed `actionEnvelopeHash`;
- threshold requirements referring to `eligibleSignerGroup` MUST be expanded into concrete eligible Signer DIDs or represented through a future extension recognized by the relying participants;
- Authorization Requirements are not a guarantee of later execution;
- the returned requirements are advisory feedback for the submitted Action and are not Coordination input for a different Action until the Proposer creates a new requirements object bound to that replacement Action;
- the Verifier MUST evaluate current policy when a completed replacement Action Package is submitted.

### 7.8 Evaluation of Completed Replacement Actions

A Verifier's `additionalApprovalsRequired` response for A1 binds to A1 and does not reserve or pre-authorize later execution. A conforming Proposer retires A1, constructs A2 with a new Action ID and Action Envelope hash, obtains fresh Approvals bound to A2, and submits completed A2 to the Verifier. The Verifier MUST evaluate A2 against current policy as an independent Action.

A later Action Package may be rejected because:

- policy changed;
- the Action Envelope expired;
- required Signer eligibility changed;
- key authorization changed;
- the Application DID or operation is no longer supported;
- external approval evidence is unavailable or invalid;
- replay or Action ID rules prevent execution.

## 8. Examples

### 8.1 Development Environment with Proposer-Only Default

A development or testing environment where the operator accepts self-approval risk.

```json
{
  "version": "1",
  "type": "MpasApplicationPolicy",
  "policyProfileUrl": "https://github.com/oma3dao/mpas/blob/main/specs/mpas-profile-policy-json.md",
  "applicationDid": "did:web:dev-tools.example",
  "executionProfile": {
    "id": "did:web:profiles.oma3.org:mcp",
    "format": "mcp.toolsCall"
  },
  "defaultRequirement": {
    "type": "proposerOnly"
  },
  "signerGroups": {
    "all": ["did:web:agent.example"]
  }
}
```

This does not mean arbitrary actions are supported. The Verifier or Application still determines payload support and validity under the declared execution profile before execution.

### 8.2 Token Transfer Thresholds

```json
{
  "version": "1",
  "type": "MpasApplicationPolicy",
  "policyProfileUrl": "https://github.com/oma3dao/mpas/blob/main/specs/mpas-profile-policy-json.md",
  "applicationDid": "did:web:treasury.example",
  "executionProfile": {
    "id": "did:web:profiles.oma3.org:mcp",
    "format": "mcp.toolsCall"
  },
  "signerGroups": {
    "all": [
      "did:web:alice.example",
      "did:web:bob.example",
      "did:web:carol.example",
      "did:web:dave.example",
      "did:web:erin.example",
      "did:web:agent.example"
    ],
    "proposers": [
      "did:web:agent.example"
    ],
    "treasuryOperators": [
      "did:web:alice.example",
      "did:web:bob.example",
      "did:web:carol.example"
    ],
    "treasuryAdmins": [
      "did:web:dave.example",
      "did:web:erin.example"
    ]
  },
  "defaultRequirement": {
    "type": "threshold",
    "threshold": 1,
    "eligibleSignerGroup": "treasuryOperators",
    "decision": "approve"
  },
  "policies": {
    "payments.send_token": [
      {
        "description": "USDC transfers above 100 require two operator approvals.",
        "match": {
          "conditions": [
            {
              "source": "executionPayload",
              "path": "/arguments/asset",
              "op": "eq",
              "value": "USDC"
            },
            {
              "source": "executionPayload",
              "path": "/arguments/amount",
              "op": "gt",
              "value": "100"
            }
          ]
        },
        "requirements": {
          "type": "threshold",
          "threshold": 2,
          "eligibleSignerGroup": "treasuryOperators",
          "decision": "approve"
        }
      },
      {
        "description": "USDC transfers above 10000 also require one admin approval.",
        "match": {
          "conditions": [
            {
              "source": "executionPayload",
              "path": "/arguments/asset",
              "op": "eq",
              "value": "USDC"
            },
            {
              "source": "executionPayload",
              "path": "/arguments/amount",
              "op": "gt",
              "value": "10000"
            }
          ]
        },
        "requirements": {
          "type": "threshold",
          "threshold": 1,
          "eligibleSignerGroup": "treasuryAdmins",
          "decision": "approve"
        }
      }
    ]
  }
}
```

Because policies are keyed by action name and the value is an array, all matching entries within the array apply. A transfer of 15000 USDC matches both entries, requiring two operator approvals and one admin approval.

### 8.3 Delete Operation

```json
{
  "version": "1",
  "type": "MpasApplicationPolicy",
  "policyProfileUrl": "https://github.com/oma3dao/mpas/blob/main/specs/mpas-profile-policy-json.md",
  "applicationDid": "did:web:storage.example",
  "executionProfile": {
    "id": "did:web:profiles.oma3.org:mcp",
    "format": "mcp.toolsCall"
  },
  "signerGroups": {
    "all": [
      "did:web:alice.example",
      "did:web:bob.example",
      "did:web:carol.example"
    ],
    "admins": [
      "did:web:alice.example",
      "did:web:bob.example",
      "did:web:carol.example"
    ]
  },
  "defaultRequirement": {
    "type": "threshold",
    "threshold": 1,
    "eligibleSignerGroup": "admins",
    "decision": "approve"
  },
  "policies": {
    "storage.delete_object": [
      {
        "description": "Deleting objects requires two admin approvals.",
        "match": {},
        "requirements": {
          "type": "threshold",
          "threshold": 2,
          "eligibleSignerGroup": "admins",
          "decision": "approve"
        }
      }
    ]
  }
}
```

### 8.4 Pull Request Merge

```json
{
  "version": "1",
  "type": "MpasApplicationPolicy",
  "policyProfileUrl": "https://github.com/oma3dao/mpas/blob/main/specs/mpas-profile-policy-json.md",
  "applicationDid": "did:web:github-adapter.example",
  "executionProfile": {
    "id": "did:web:profiles.oma3.org:mcp",
    "format": "mcp.toolsCall"
  },
  "signerGroups": {
    "all": [
      "did:web:maintainer1.example",
      "did:web:maintainer2.example",
      "did:web:maintainer3.example",
      "did:web:security1.example",
      "did:web:agent.example"
    ],
    "proposers": [
      "did:web:agent.example"
    ],
    "maintainers": [
      "did:web:maintainer1.example",
      "did:web:maintainer2.example",
      "did:web:maintainer3.example"
    ],
    "securityReviewers": [
      "did:web:security1.example"
    ]
  },
  "defaultRequirement": {
    "type": "threshold",
    "threshold": 1,
    "eligibleSignerGroup": "maintainers",
    "decision": "approve"
  },
  "policies": {
    "merge_pull_request": [
      {
        "description": "Merging into main requires two maintainer approvals.",
        "match": {
          "conditions": [
            {
              "source": "executionPayload",
              "path": "/arguments/baseRef",
              "op": "eq",
              "value": "main"
            }
          ]
        },
        "requirements": {
          "type": "threshold",
          "threshold": 2,
          "eligibleSignerGroup": "maintainers",
          "decision": "approve"
        }
      },
      {
        "description": "Security-labeled PRs also require a security reviewer.",
        "match": {
          "conditions": [
            {
              "source": "executionPayload",
              "path": "/arguments/labels",
              "op": "contains",
              "value": "security"
            }
          ]
        },
        "requirements": {
          "type": "threshold",
          "threshold": 1,
          "eligibleSignerGroup": "securityReviewers",
          "decision": "approve"
        }
      }
    ]
  }
}
```

Note: The security-labeled-pr entry assumes the Verifier validates `arguments.labels` against trusted application state. A Proposer-supplied label MUST NOT be trusted to weaken policy.

## 9. Security and Conformance Requirements

### 9.1 Trusted Policy Source

A Verifier MUST load `MpasApplicationPolicy` from trusted configuration or a trusted policy service. The Proposer MUST NOT supply the policy used for authorization as part of the Action Package.

### 9.2 Proposer-Controlled Fields

The Execution Payload contains proposer-supplied executable facts. Policies may inspect those facts, but Proposer-controlled fields MUST NOT be treated as authoritative policy, credential configuration, signer group membership, or risk classification.

### 9.3 Operation Support and Payload Validation

The absence of a matching policy entry means `defaultRequirement` applies — this does not mean the action is unrestricted. A Verifier MUST NOT execute arbitrary unknown actions solely because no policy entry exists for them.

### 9.4 Missing and Malformed Parameters

A Verifier or Application MUST validate that the Execution Payload is well formed and safe to interpret for the requested operation. Policy conditions are not a substitute for operation-specific payload validation.

### 9.5 Signer Group Integrity

Signer group membership MUST be protected as trusted authorization configuration. Unauthorized modification of signer groups can weaken policy and compromise authorization.

### 9.6 Approval Verification Before Counting

A Verifier MUST NOT count an Approval unless the Approval has been verified and binds to the computed Action Envelope hash.

### 9.7 Policy Evaluation After Coordination

A Verifier MUST evaluate the completed replacement Action against current policy when it is submitted. Authorization Requirements previously returned for an earlier Action do not guarantee execution of the replacement Action.

### 9.8 Reject-Entry Handling

Reject entries MUST be loaded only from the same trusted policy source as requirement entries. A rejection MUST depend only on the action key and deterministic conditions defined by this profile. Rejection MUST override matching positive requirements so that additional Approvals cannot accidentally authorize a blocked action. Verifiers SHOULD avoid returning sensitive operator rationale and SHOULD use the generic `ACTION_BLOCKED_BY_POLICY` response detail defined in Section 6.6.

### 9.9 Conforming Verifier Requirements

A Verifier conforming to this profile MUST:

- parse and validate `MpasApplicationPolicy` objects with `version: "1"`;
- reject policies that omit required fields (`defaultRequirement`, `signerGroups`, `signerGroups.all`);
- validate requirement expressions, including positive threshold values,
  exactly-one eligible-signer source, non-empty composed requirements, and
  references to defined signer groups;
- reject invalid `reject`/`requirements` combinations;
- reject or ignore unsupported policy versions according to deployment policy;
- ensure `applicationDid` matches the Action Envelope target Application DID and `executionProfile.id` matches the Action Envelope execution profile;
- evaluate all matching entries within the policy array for the requested action;
- apply matching reject entries before evaluating positive requirements;
- combine matching positive requirements with logical AND;
- apply `defaultRequirement` for governed operations with no matching policy entry;
- support the condition operators defined in Section 5.4;
- support the requirement types defined in Section 5.5;
- verify Approvals before counting them;
- expand signer groups into eligible Signers when producing Authorization Requirements;
- produce MPAS-compatible results and Authorization Requirements;
- not rely on nondeterministic LLM output for final authorization.

## 10. Future Work

Future MPAS policy profiles may define:

- domain-specific operation profiles;
- operation schemas and rendering descriptors;
- Credential Adapter application plugin policy bindings;
- trusted derived facts such as environment, resource sensitivity, recipient trust, budget state, or verifier-computed asset value;
- external signer group resolvers;
- signer independence and organization diversity constraints;
- richer condition operators;
- OPA/Rego mappings;
- Cedar mappings;
- OpenFGA or Zanzibar-style relationship mappings;
- enterprise IAM mappings;
- smart-contract policy mappings;
- policy version attestation in Execution Receipts;
- normative policy test vectors.

## 11. Alignment with Existing Policy Standards

### 11.1 Overview

This profile is consistent with the common authorization pattern used by many policy systems:

```text
principal / subject + action / operation + resource / target + context / attributes + policy conditions
```

MPAS adapts this pattern to multi-party approval. Instead of producing only allow or deny, an MPAS Verifier may produce `additionalApprovalsRequired` and concrete approval requirements that can be satisfied by verified MPAS Approvals.

### 11.2 ABAC and XACML

NIST ABAC describes authorization as evaluating attributes associated with subjects, objects, requested operations, and sometimes environment conditions against policy. XACML similarly organizes request context around subject, resource, action, and environment categories. This profile aligns with that model:

| ABAC / XACML concept | MPAS JSON Policy concept |
| :--- | :--- |
| Subject attributes | Proposer DID, signer DIDs, signer groups |
| Object / resource attributes | `actionEnvelope.target`, target resource, application-specific resource identifiers |
| Requested operation | Profile-derived from `executionPayload` (e.g., `/name` for MCP) |
| Context / environment | Action Envelope fields and future trusted derived facts |
| Policy conditions | `match.conditions` |
| Decision | `authorized`, `rejected`, `additionalApprovalsRequired`, etc. |

The main difference is that MPAS evaluates signed Action Packages and Approval Bundles and may return additional approval requirements rather than a simple permit/deny decision.

References:

- NIST SP 800-162, Guide to Attribute Based Access Control (ABAC): https://csrc.nist.gov/pubs/sp/800/162/upd2/final
- OASIS XACML 3.0 Core Specification: https://docs.oasis-open.org/xacml/3.0/xacml-3.0-core-spec-os-en.html

### 11.3 Cedar

Cedar evaluates authorization requests using principal, action, resource, and context. This profile has a similar shape:

| Cedar concept | MPAS JSON Policy concept |
| :--- | :--- |
| Principal | Proposer DID and signer DIDs |
| Action | Profile-derived from `executionPayload` (e.g., `/name` for MCP) |
| Resource | `actionEnvelope.target.resource` or target object |
| Context | Execution Payload fields, Action Envelope fields, future trusted derived facts |
| Decision | MPAS policy outcome and approval requirements |

The main difference is that Cedar generally returns allow/deny, while MPAS may require additional verified Approvals before execution.

Reference:

- Cedar Authorization Documentation: https://docs.cedarpolicy.com/auth/authorization.html

### 11.4 AWS IAM

AWS IAM JSON policies use service-defined actions, resources, principals, and conditions. This profile follows a similar practical approach by allowing each Application DID to define its own operation names instead of imposing a universal MPAS action taxonomy.

| AWS IAM concept | MPAS JSON Policy concept |
| :--- | :--- |
| Service-specific action | Profile-derived from `executionPayload` (e.g., `/name` for MCP) |
| Resource | `actionEnvelope.target.resource` |
| Principal | Proposer DID and signer DID |
| Condition | `match.conditions` |

The main difference is that IAM policies grant permissions, while this profile determines whether a signed MPAS Action Package and Approval Bundle satisfy multi-party approval policy.

Reference:

- AWS IAM JSON Policy Elements: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements.html

### 11.5 OPA/Rego

Open Policy Agent decouples policy decision-making from enforcement and evaluates structured input such as JSON. This profile can be implemented directly as a simple deterministic evaluator or mapped into OPA/Rego in a future profile.

Potential future mapping:

```text
OPA input = Action Package + trusted configuration + verified approval facts
OPA output = MPAS policy outcome + approval requirements
```

The main difference is that OPA/Rego is a general-purpose policy language, while this profile is a constrained baseline JSON format specialized for MPAS Action Package approval policy.

Reference:

- Open Policy Agent Documentation: https://www.openpolicyagent.org/docs

### 11.6 OpenFGA and Zanzibar-Style ReBAC

OpenFGA models authorization through users, objects, relations, roles, and permissions. This is useful for MPAS signer eligibility and resource-specific relationship checks, such as whether a DID is a maintainer of a repository or an approver for a treasury account.

This profile does not require OpenFGA. A future profile may use OpenFGA as a trusted source for signer groups or derived facts while preserving MPAS-specific threshold approval evaluation.

Reference:

- OpenFGA Modeling Documentation: https://openfga.dev/docs/modeling

### 11.7 Kubernetes RBAC

Kubernetes RBAC regulates access using roles, role bindings, subjects, resources, and verbs. MPAS signer groups and operation-matched policy requirements are consistent with RBAC-style thinking, but MPAS needs additional approval and condition semantics.

The main difference is that Kubernetes RBAC is primarily role-based access control for API operations, while MPAS evaluates signed Action Packages, thresholds, parameter constraints, and multi-party approval bundles.

Reference:

- Kubernetes RBAC Documentation: https://kubernetes.io/docs/reference/access-authn-authz/rbac/

### 11.8 Summary

The MPAS JSON Verifier Policy Profile is intentionally consistent with established ABAC, RBAC, ReBAC, and policy-as-code systems. Its distinctive contribution is not a new general-purpose policy theory. Its contribution is a deterministic policy profile for evaluating signed MPAS Action Packages, verified Approvals, approval thresholds, and Authorization Requirements.

## Appendix A. JSON Schema for `MpasApplicationPolicy`

This appendix defines a JSON Schema for structural validation of `MpasApplicationPolicy` objects. The schema validates object shape. The normative semantics of policy evaluation are defined in Sections 5, 6, and 7.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://specs.mpas.dev/schemas/mpas-application-policy-v1.schema.json",
  "title": "MpasApplicationPolicy",
  "type": "object",
  "required": ["version", "type", "policyProfileUrl", "applicationDid", "executionProfile", "defaultRequirement", "signerGroups"],
  "additionalProperties": false,
  "properties": {
    "version": {
      "const": "1"
    },
    "type": {
      "const": "MpasApplicationPolicy"
    },
    "policyProfileUrl": {
      "const": "https://github.com/oma3dao/mpas/blob/main/specs/mpas-profile-policy-json.md"
    },
    "applicationDid": {
      "type": "string",
      "minLength": 1
    },
    "executionProfile": {
      "type": "object",
      "required": ["id"],
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "format": {
          "type": "string",
          "minLength": 1
        }
      }
    },
    "defaultRequirement": {
      "$ref": "#/$defs/requirement"
    },
    "signerGroups": {
      "type": "object",
      "required": ["all"],
      "additionalProperties": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1
        },
        "uniqueItems": true
      }
    },
    "policies": {
      "type": "object",
      "additionalProperties": {
        "type": "array",
        "items": {
          "$ref": "#/$defs/policy"
        }
      }
    },
    "context": {
      "type": "object",
      "additionalProperties": true
    }
  },
  "$defs": {
    "policy": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "reject": {
          "type": "boolean",
          "default": false
        },
        "description": {
          "type": "string"
        },
        "match": {
          "$ref": "#/$defs/match"
        },
        "requirements": {
          "$ref": "#/$defs/requirement"
        },
        "context": {
          "type": "object",
          "additionalProperties": true
        }
      },
      "oneOf": [
        {
          "required": ["requirements"],
          "properties": {
            "reject": {
              "const": false
            }
          }
        },
        {
          "required": ["reject"],
          "not": {
            "required": ["requirements"]
          },
          "properties": {
            "reject": {
              "const": true
            }
          }
        }
      ]
    },
    "match": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "conditions": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/condition"
          }
        }
      }
    },
    "condition": {
      "type": "object",
      "required": ["source", "op"],
      "additionalProperties": false,
      "properties": {
        "source": {
          "enum": ["executionPayload", "actionEnvelope"]
        },
        "path": {
          "type": "string"
        },
        "op": {
          "enum": ["eq", "neq", "in", "notIn", "gt", "gte", "lt", "lte", "exists", "notExists", "contains", "prefix"]
        },
        "value": true
      }
    },
    "requirement": {
      "oneOf": [
        {
          "$ref": "#/$defs/proposerOnlyRequirement"
        },
        {
          "$ref": "#/$defs/thresholdRequirement"
        },
        {
          "$ref": "#/$defs/allOfRequirement"
        },
        {
          "$ref": "#/$defs/anyOfRequirement"
        }
      ]
    },
    "proposerOnlyRequirement": {
      "type": "object",
      "required": ["type"],
      "additionalProperties": false,
      "properties": {
        "type": {
          "const": "proposerOnly"
        }
      }
    },
    "thresholdRequirement": {
      "type": "object",
      "required": ["type", "threshold"],
      "additionalProperties": false,
      "properties": {
        "type": {
          "const": "threshold"
        },
        "threshold": {
          "type": "integer",
          "minimum": 1
        },
        "eligibleSignerGroup": {
          "type": "string",
          "minLength": 1
        },
        "eligibleSigners": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          },
          "uniqueItems": true
        },
        "decision": {
          "type": "string",
          "default": "approve",
          "not": {
            "const": "reject"
          }
        },
        "description": {
          "type": "string"
        }
      },
      "oneOf": [
        {
          "required": ["eligibleSignerGroup"],
          "not": {
            "required": ["eligibleSigners"]
          }
        },
        {
          "required": ["eligibleSigners"],
          "not": {
            "required": ["eligibleSignerGroup"]
          }
        }
      ]
    },
    "allOfRequirement": {
      "type": "object",
      "required": ["type", "requirements"],
      "additionalProperties": false,
      "properties": {
        "type": {
          "const": "allOf"
        },
        "requirements": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/requirement"
          },
          "minItems": 1
        }
      }
    },
    "anyOfRequirement": {
      "type": "object",
      "required": ["type", "requirements"],
      "additionalProperties": false,
      "properties": {
        "type": {
          "const": "anyOf"
        },
        "requirements": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/requirement"
          },
          "minItems": 1
        }
      }
    }
  }
}
```
