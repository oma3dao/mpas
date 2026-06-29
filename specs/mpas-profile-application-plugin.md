# MPAS Application Plugin Profile

**Status:** Draft v0.2
**Companion to:** MPAS Core Specification, MPAS HTTP Profile, and MPAS JSON Verifier Policy Profile  
**Suggested filename:** `mpas-profile-application-plugin.md`  
**Primary object:** `MpasApplicationPlugin`  
**Scope:** A portable JSON descriptor for an application's MPAS-exposed command surface, including profile-native Execution Payload schemas, credential requirement classes, and policy suggestions.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** are to be interpreted as described in RFC 2119 and RFC 8174.

---

## 1. Introduction

The MPAS Core Specification defines profile-native Execution Payloads. The base specification does not define universal Execution Payload fields. Instead, the Action Envelope identifies the target Application DID and the execution profile used to interpret the Execution Payload, while the Execution Payload remains in the native format defined by that execution profile.

The MPAS Application Plugin Profile defines a portable JSON document that describes an application's MPAS-exposed command surface. An application plugin can be consumed by:

- a Credential Adapter that needs to validate profile-native Execution Payloads and execute them against a non-MPAS-native application;
- a native MPAS Application that wants to publish the operations and payload schemas it supports;
- an MCP gateway that wants to protect high-impact MCP tool calls with MPAS approvals;
- a policy authoring tool that wants to generate or suggest `MpasApplicationPolicy` objects;
- an agent or proposer tool that wants to construct valid Execution Payloads;
- a signer or review tool that wants to understand which payload fields are relevant to an operation.

This profile is intentionally small. It defines the common application-plugin descriptor needed for MPAS v0.2:

- stable plugin identity;
- publisher identity;
- target Application DID;
- execution profile binding;
- operation descriptors;
- profile-native Execution Payload schemas;
- credential requirement classes;
- policy suggestions;
- a normative rule for inferring native tool identity from the operation name under MCP.

This profile does not define deployment activation, credential bindings, signer groups, rendering templates, receipt mappings, OMATrust attestations, marketplace behavior, or plugin code packaging. Those concerns are left to implementations or future profiles.

---

## 2. Scope and Non-Goals

### 2.1 Scope

This profile defines:

- the `MpasApplicationPlugin` JSON object;
- stable plugin identity fields;
- execution profile binding;
- an operation catalog;
- operation-level profile-native Execution Payload schemas;
- credential requirement class descriptors;
- policy suggestions that can help users create `MpasApplicationPolicy` rules;
- security requirements for plugin consumers;
- a JSON Schema appendix for structural validation.

### 2.2 Non-Goals

This profile does not define:

- deployment activation state;
- real credential references, vault handles, API keys, OAuth tokens, private keys, or local secret storage;
- actual signer groups, signer thresholds, or organization-specific policy decisions;
- rendering or clear-signing UI templates;
- receipt mapping rules;
- OMATrust attestation schemas;
- plugin marketplaces;
- binary/plugin packaging rules;
- plugin update channels;
- preconditions or state-root assertions;
- OpenAPI, EVM, x402, browser, desktop, or CLI execution profile details;
- LLM-based plugin generation or documentation ingestion;
- sandboxing of executable plugin code.

---

## 3. Relationship to Other MPAS Documents

### 3.1 Relationship to MPAS Core

The MPAS Core Specification defines the core artifacts and processing rules for Action Packages, Action Envelopes, Approvals, Approval Bundles, Authorization Requirements, and Execution Receipts.

This profile does not change the core MPAS security model. In particular:

- the Execution Payload remains profile-native;
- the Action Envelope binds to the Execution Payload by hash;
- the Action Envelope identifies the target Application DID and execution profile;
- Approvals bind to the Action Envelope hash;
- the Verifier determines whether the Action Package satisfies policy before execution.

An application plugin helps participants interpret and validate profile-native Execution Payloads for a specific Application DID and execution profile.

### 3.2 Relationship to the MPAS JSON Verifier Policy Profile

The MPAS JSON Verifier Policy Profile defines `MpasApplicationPolicy`, a deterministic JSON policy object for one Application DID and one execution profile.

An application plugin may include `policySuggestions`. A policy suggestion is not deployment policy. It identifies payload patterns that the plugin publisher believes are high-impact or otherwise policy-relevant and suggests a non-binding approval pattern.

A deployment owner may accept, modify, delete, or add policy rules based on these suggestions. Actual policy is stored in a Verifier, native Application, Credential Adapter, MCP gateway, or other trusted deployment configuration, not in the plugin.

### 3.3 Relationship to the MPAS HTTP Profile

The MPAS HTTP Profile defines transport messages such as `ActionRequest`, `ActionResponse`, `ApprovalRequest`, and `ApprovalResponse`. It does not define application-specific payload schemas or application plugin behavior.

An application plugin may be distributed by HTTP, but its semantics are independent of HTTP transport.

### 3.4 Relationship to MCP

This v0.2 profile is MCP-first. For the MCP execution profile, the Execution Payload is the semantic MCP tool-call parameter object, for example:

```json
{
  "name": "merge_pull_request",
  "arguments": {
    "owner": "oma3dao",
    "repo": "app-registry",
    "pullNumber": 42,
    "baseRef": "main",
    "expectedHeadSha": "abc123",
    "mergeMethod": "squash"
  }
}
```

Under an MCP execution profile, policy conditions commonly reference `/name` and `/arguments/...` paths. The application plugin describes the tool names, argument schemas, credential requirement classes, and suggested policy matches that apply to those MCP payloads.

This profile is designed to be generic enough for future execution profiles such as OpenAPI operation calls, EVM transaction intents, HTTP requests, CLI command objects, browser recipes, desktop recipes, x402 payment payloads, or native application commands.

---

## 4. Conceptual Model

An `MpasApplicationPlugin` is a portable descriptor of an application's MPAS-exposed commands.

It is not a deployment store. It does not say which operations are enabled for a particular user, which real credentials are bound, which signer groups are used, or which thresholds apply. Those decisions belong to the consuming system.

### 4.1 Plugin vs. Deployment State

The plugin describes:

- this application exposes these MPAS-compatible operations;
- these operations use this execution profile and payload format;
- these payload schemas are expected;
- these credential classes may be required;
- these payload patterns are likely high-impact;
- these policy matches may be useful to policy authors.

The consuming system stores:

- which plugin versions are trusted;
- which operations are enabled;
- which resources are allowed;
- which real credentials are bound;
- which signer groups and approval thresholds apply;
- which policy suggestions were accepted, modified, or ignored;
- which endpoints or local runtimes are used.

### 4.2 Plugin Identity vs. Artifact Identity

A plugin should have a stable DID, `pluginDid`, used for durable identity and reputation across versions.

A particular plugin artifact or package may also have an external content-addressed identifier, such as `did:artifact:<cidv1>`, computed over the plugin JSON or packaged bytes. The artifact DID is not included inside the plugin JSON because that would create a self-reference problem if the JSON bytes are the artifact being hashed. The artifact DID can be calculated anytime by converting the canonicalized plugin JSON object into a `did:artifact`.

This plugin profile defines the plugin document itself. It does not define distribution records or artifact attestations.

### 4.3 Application DID and Execution Profile

Each plugin applies to one Application DID and one execution profile.

The consuming Verifier, Credential Adapter, or native Application MUST ensure that an Action Package's:

```text
actionEnvelope.target.applicationDid
actionEnvelope.executionProfile.id
actionEnvelope.executionProfile.format
```

are compatible with the plugin before using the plugin to validate or interpret the Execution Payload.

---

## 5. Top-Level Object: `MpasApplicationPlugin`

An `MpasApplicationPlugin` is a JSON object.

Example shape:

```json
{
  "version": "1",
  "type": "MpasApplicationPlugin",
  "pluginDid": "did:web:plugins.example.com:github-pr",
  "pluginVersion": "1.0.0",
  "publisherDid": "did:web:wivity.example",
  "applicationDid": "did:web:github.com",
  "executionProfile": {
    "id": "did:web:profiles.oma3.org:mcp",
    "format": "mcp.toolsCall"
  },
  "credentialRequirements": [
    {
      "type": "oauthToken",
      "requiredCapabilities": ["pullRequest.merge", "pullRequest.read", "issue.write"],
      "description": "GitHub OAuth token with repository access for the configured organizations."
    }
  ],
  "operations": [
    {
      "name": "merge_pull_request",
      "description": "Merge a pull request into its base branch.",
      "executionPayloadSchema": {
        "type": "object",
        "required": ["name", "arguments"],
        "properties": {
          "name": {
            "const": "merge_pull_request"
          },
          "arguments": {
            "type": "object",
            "required": [
              "owner",
              "repo",
              "pullNumber",
              "baseRef",
              "expectedHeadSha",
              "mergeMethod"
            ],
            "properties": {
              "owner": { "type": "string" },
              "repo": { "type": "string" },
              "pullNumber": { "type": "integer" },
              "baseRef": { "type": "string" },
              "expectedHeadSha": { "type": "string" },
              "mergeMethod": {
                "type": "string",
                "enum": ["merge", "squash", "rebase"]
              }
            },
            "additionalProperties": false
          }
        },
        "additionalProperties": false
      }
    }
  ],
  "policySuggestions": [
    {
      "description": "Merging into main is high impact and should require maintainer approval.",
      "impact": "high",
      "match": {
        "conditions": [
          {
            "source": "executionPayload",
            "path": "/name",
            "op": "eq",
            "value": "merge_pull_request"
          },
          {
            "source": "executionPayload",
            "path": "/arguments/baseRef",
            "op": "eq",
            "value": "main"
          }
        ]
      },
      "suggestedRequirement": {
        "kind": "approvalThreshold",
        "eligibleSignerRole": "maintainer",
        "minimumThreshold": 2,
        "decision": "approve"
      }
    }
  ]
}
```

Field definitions:

| Field                      | Required    | Description                                                                                                           |
| :------------------------- | :---------: | :-------------------------------------------------------------------------------------------------------------------- |
| `version`                  | Yes         | Plugin schema version. For this profile, MUST be `"1"`.                                                               |
| `type`                     | Yes         | MUST be `"MpasApplicationPlugin"`.                                                                                    |
| `pluginDid`                | Yes         | Stable DID for the plugin line. Used for discovery, update relationships, and publisher-level reputation. Not the artifact identity (see §6.5). |
| `pluginVersion`            | Yes         | Version of this plugin document. Semantic versioning is RECOMMENDED but not required.                                 |
| `publisherDid`             | Yes         | DID of the entity publishing this plugin version.                                                                     |
| `applicationDid`           | Yes         | DID of the target Application or execution authority.                                                                 |
| `executionProfile.id`      | Yes         | DID of the execution profile this plugin describes.                                                                   |
| `executionProfile.format`  | Recommended | Specific payload format under the execution profile, such as `mcp.toolsCall`.                                         |
| `credentialRequirements`   | Optional    | Array of credential requirement class descriptors for the plugin.                                                     |
| `operations`               | Yes         | Array of operation objects describing operations exposed by this plugin.                                              |
| `policySuggestions`        | Optional    | Array of non-binding policy suggestions.                                                                              |

---

## 6. Identity Fields

### 6.1 `pluginDid`

`pluginDid` is the stable identity of the plugin line — the series of versioned artifacts published under one name. It persists across versions and is used for discovery, update relationships, publisher-level reputation, and long-lived references.

`pluginDid` does NOT uniquely identify a specific reviewed artifact. Security attestations, OMATrust reviews, and per-version reputation SHOULD target the `artifactDid` (§6.5), which is content-addressed and immutable for a given set of plugin bytes.

The `pluginDid` SHOULD be a DID controlled by the plugin publisher or by an organization responsible for the plugin. `did:web` is suitable for early implementations.

Example:

```json
"pluginDid": "did:web:plugins.example.com:github-pr"
```

### 6.2 `pluginVersion`

`pluginVersion` identifies the version of this plugin document.

This profile does not define version ordering rules. Implementations MAY use semantic versioning, date-based versions, content-derived versions, or another deterministic scheme.

### 6.3 `publisherDid`

`publisherDid` identifies the publisher of the plugin document.

The publisher is not automatically trusted. A consumer MUST apply its own trust policy before using a plugin to validate or execute actions.

### 6.4 `applicationDid`

`applicationDid` identifies the Application or execution authority described by the plugin.

A Credential Adapter or Verifier MUST NOT use the plugin to interpret an Action Package unless the plugin's `applicationDid` matches `actionEnvelope.target.applicationDid` or a trusted local configuration explicitly authorizes an equivalent binding.

### 6.5 Artifact Identity

This profile does not include an `artifactDid` field inside `MpasApplicationPlugin`. The `artifactDid` is computed externally from the canonical plugin bytes (e.g., as `did:artifact:<cidv1>`) and recorded outside the document — in a distribution record, registry entry, package lockfile, deployment configuration, or external attestation. This avoids self-reference when the artifact DID is computed over the plugin document bytes.

The `artifactDid` is the content-addressed identity of a specific plugin artifact. It is immutable for a given set of bytes and is the appropriate target for:

- integrity verification on install and load;
- security attestations and cybersecurity reviews;
- OMATrust reputation scores and community reviews;
- per-version trust decisions in deployment configurations.

In contrast, `pluginDid` (§6.1) identifies the plugin line across versions. Both are needed: `pluginDid` for discovery and update tracking, `artifactDid` for verifiable trust in specific artifacts.

---

## 7. Execution Profile Binding

The `executionProfile` object identifies the execution profile and payload format described by the plugin.

```json
{
  "id": "did:web:profiles.oma3.org:mcp",
  "format": "mcp.toolsCall"
}
```

Field definitions:

| Field    | Required    | Description                                  |
| :------- | :---------: | :------------------------------------------- |
| `id`     | Yes         | DID of the execution profile.                |
| `format` | Recommended | Specific format under the execution profile. |

A consuming Verifier or Credential Adapter MUST validate that the declared Action Envelope execution profile is permitted for the plugin's Application DID under trusted local configuration.

A plugin MUST NOT cause a Credential Adapter to accept an arbitrary execution profile for an Application DID. The pairing of Application DID and execution profile must be trusted by the consuming deployment.

---

## 8. Operations

The `operations` array describes the MPAS-exposed operations supported by this plugin.

Each operation is identified by its `name` field. For the `mcp.toolsCall` execution profile, the operation `name` MUST equal the native MCP tool name exactly as exposed by the target MCP server (e.g., `merge_pull_request`, not `github.merge_pull_request`). Disambiguation across applications is provided by `actionEnvelope.target.applicationDid`; the operation name MUST NOT carry a namespace prefix for that purpose. For other execution profiles, the operation `name` MUST be the native identifier as defined by that profile.

Example:

```json
{
  "operations": [
    {
      "name": "merge_pull_request",
      "description": "Merge a pull request into its base branch.",
      "executionPayloadSchema": {}
    },
    {
      "name": "create_issue",
      "description": "Create a new issue in a repository.",
      "executionPayloadSchema": {}
    }
  ]
}
```

Field definitions for an operation object:

| Field                    | Required    | Description                                                                        |
| :----------------------- | :---------: | :--------------------------------------------------------------------------------- |
| `name`                   | Yes         | Operation identifier. For MCP, this is the MCP tool name.                          |
| `description`            | Recommended | Human-readable description. Non-authoritative.                                     |
| `executionPayloadSchema` | Yes         | JSON Schema describing valid profile-native Execution Payloads for this operation. |

For the `mcp.toolsCall` format, no separate native binding descriptor is required — the operation `name` is sufficient.

The operation object does not define deployment policy. It does not enable the operation for any particular deployment. It does not bind real credentials.

---

## 9. Execution Payload Schemas

`executionPayloadSchema` is a JSON Schema that describes the profile-native Execution Payload for an operation.

For MCP `mcp.toolsCall`, the schema SHOULD validate the MCP tool-call parameter object, including the expected tool `name` and `arguments` shape.

Example:

```json
{
  "type": "object",
  "required": ["name", "arguments"],
  "properties": {
    "name": {
      "const": "merge_pull_request"
    },
    "arguments": {
      "type": "object",
      "required": [
        "owner",
        "repo",
        "pullNumber",
        "baseRef",
        "expectedHeadSha",
        "mergeMethod"
      ],
      "properties": {
        "owner": { "type": "string" },
        "repo": { "type": "string" },
        "pullNumber": { "type": "integer" },
        "baseRef": { "type": "string" },
        "expectedHeadSha": { "type": "string" },
        "mergeMethod": {
          "type": "string",
          "enum": ["merge", "squash", "rebase"]
        }
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}
```

The `name` constraint in the schema SHOULD match the operation's `name` field. If they conflict, the operation-level `name` field is authoritative.

A consuming Verifier or Credential Adapter MUST validate the Execution Payload under the declared execution profile and trusted configuration before using the payload for policy evaluation or execution.

A plugin's schema is a descriptor, not proof of safety. A consuming system MUST still enforce local trust policy, credential binding policy, and execution restrictions.

---

## 10. Native Tool Identity

For the `mcp.toolsCall` execution profile, the naming rule in Section 8 applies: the operation `name` field is the native MCP tool name. No separate native binding descriptor is needed.

A consumer processing an MCP-profile plugin SHOULD treat the operation `name` as the authoritative MCP tool identifier.

For future execution profiles where the native dispatch target cannot be derived from the operation name alone (for example, OpenAPI operations that require a path and method, or EVM transactions that require a contract address and function selector), the operation object MAY include a `nativeBinding` property. The structure of `nativeBinding` will be defined by the corresponding execution profile specification. This profile does not define `nativeBinding` properties for any execution profile.

See Section 16 (Future Work) for planned native binding types.

---

## 11. Credential Requirements

`credentialRequirements` is a top-level array that describes the classes of credential or capability that the plugin's operations may require.

Credential requirements do not contain real credentials, credential references, vault handles, tokens, keys, passwords, endpoint secrets, or deployment-specific bindings.

Example:

```json
{
  "credentialRequirements": [
    {
      "type": "oauthToken",
      "requiredCapabilities": ["pullRequest.merge", "pullRequest.read", "issue.write"],
      "description": "GitHub OAuth token with repository access for the configured organizations."
    }
  ]
}
```

Field definitions:

| Field                  | Required | Description                                                                                                                                          |
| :--------------------- | :------: | :--------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`                 | Yes      | Credential class, such as `oauthToken`, `apiKey`, `sshKey`, `serviceAccount`, `walletKey`, `sessionCredential`, `passkey`, or profile-defined value. |
| `requiredCapabilities` | Optional | Array of capability strings describing the authority expected.                                                                                        |
| `description`          | Optional | Human-readable explanation. Non-authoritative.                                                                                                       |

Credential requirements apply to the plugin as a whole. All operations described by the plugin share the same credential class requirements.

A Credential Adapter may use credential requirements to help an administrator bind local credentials. The binding itself is outside this profile.

A Credential Adapter MUST NOT let the Execution Payload, plugin document, or Proposer choose the actual credential. Actual credential selection comes from trusted deployment configuration.

---

## 12. Policy Suggestions

`policySuggestions` is an array of non-binding suggestions that help policy authors identify high-impact payload patterns.

A policy suggestion may include:

- a human-readable description;
- an impact label;
- a `match` object compatible with the MPAS JSON Verifier Policy Profile;
- a suggested requirement shape.

Example:

```json
{
  "description": "Merging into main is high impact and should require maintainer approval.",
  "impact": "high",
  "match": {
    "conditions": [
      {
        "source": "executionPayload",
        "path": "/name",
        "op": "eq",
        "value": "merge_pull_request"
      },
      {
        "source": "executionPayload",
        "path": "/arguments/baseRef",
        "op": "eq",
        "value": "main"
      }
    ]
  },
  "suggestedRequirement": {
    "kind": "approvalThreshold",
    "eligibleSignerRole": "maintainer",
    "minimumThreshold": 2,
    "decision": "approve"
  }
}
```

Field definitions:

| Field                  | Required    | Description                                                                                |
| :--------------------- | :---------: | :----------------------------------------------------------------------------------------- |
| `description`          | Recommended | Human-readable explanation of the suggested policy.                                        |
| `impact`               | Optional    | Suggested impact label, such as `low`, `medium`, `high`, or `critical`. Non-authoritative. |
| `match`                | Yes         | Match object compatible with the MPAS JSON Verifier Policy Profile.                        |
| `suggestedRequirement` | Optional    | Non-binding suggested approval requirement shape.                                          |

### 12.1 Suggested Requirement Shape

The `suggestedRequirement` object describes a non-binding approval pattern. Its structure aligns with the MPAS JSON Verifier Policy Profile requirement model.

Example:

```json
{
  "suggestedRequirement": {
    "kind": "approvalThreshold",
    "eligibleSignerRole": "maintainer",
    "minimumThreshold": 2,
    "decision": "approve"
  }
}
```

Field definitions for `suggestedRequirement`:

| Field                | Required | Description                                                                                               |
| :------------------- | :------: | :-------------------------------------------------------------------------------------------------------- |
| `kind`               | Yes      | Requirement kind, such as `approvalThreshold`, `notification`, or `autoApprove`.                          |
| `eligibleSignerRole` | Optional | Suggested signer role for approval, such as `maintainer`, `owner`, `securityReviewer`. Non-authoritative. |
| `minimumThreshold`   | Optional | Suggested minimum number of approvals.                                                                    |
| `decision`           | Optional | Suggested decision value, such as `approve` or `reject`.                                                  |

These fields are suggestions. A consuming system MUST NOT use them as active policy. Deployment owners decide actual signer roles, thresholds, and requirement kinds.

### 12.2 Policy Suggestion Safety

Policy suggestions are not policy. A consuming system MUST NOT treat a policy suggestion as an active rule unless an operator or trusted policy process instantiates it into actual Verifier policy.

A plugin publisher should use policy suggestions to call out payloads that are likely high-impact. Deployment owners remain responsible for deciding actual approval requirements.

Policy suggestions may be incomplete, outdated, or too permissive for a deployment. Operators remain responsible for actual policy.

---

## 13. Processing Model

A consuming system using an `MpasApplicationPlugin` SHOULD process it as follows.

### 13.1 Plugin Loading

1. Obtain the plugin document from a trusted or configured source.
2. Validate the plugin document against this profile and, if available, the JSON Schema in Appendix A.
3. Confirm the plugin's `pluginDid`, `publisherDid`, `applicationDid`, and `executionProfile` are acceptable under local trust policy.
4. If the plugin was obtained by artifact reference, verify the artifact bytes against the external artifact identifier before relying on the plugin.

### 13.2 Action Package Validation

When evaluating an Action Package, a consumer using this plugin SHOULD:

1. validate the Action Package under MPAS Core;
2. verify that `actionEnvelope.target.applicationDid` matches the plugin `applicationDid`;
3. verify that `actionEnvelope.executionProfile.id` matches the plugin `executionProfile.id`;
4. if both formats are present, verify that `actionEnvelope.executionProfile.format` matches the plugin `executionProfile.format`;
5. select an operation whose `executionPayloadSchema` validates the supplied Execution Payload;
6. use local deployment policy to determine whether the operation is enabled and which credentials, if any, may be used.

### 13.3 Policy Authoring

A policy authoring tool MAY use `policySuggestions` to generate draft `MpasApplicationPolicy` entries.

The generated policy MUST be reviewed or accepted under deployment policy before it becomes active. Plugin policy suggestions alone MUST NOT authorize or block an Action.

### 13.4 Credential Adapter Use

A Credential Adapter MAY use an application plugin to:

- validate profile-native Execution Payloads;
- identify the native MCP tool from the operation `name`;
- inform an administrator which credential classes are needed;
- help generate policy suggestions;
- reject unsupported or malformed payloads.

A Credential Adapter MUST still use trusted local or cloud configuration to decide:

- whether the plugin is trusted;
- whether the operation is enabled;
- whether the target resource is allowed;
- which real credential is bound;
- whether policy is satisfied;
- whether execution should proceed.

---

## 14. Security Considerations

### 14.1 Plugin Documents Are Not Deployment Policy

A plugin document is a descriptor. It is not deployment policy and is not proof that an action is safe.

Policy suggestions are non-binding. Credential requirements are descriptive. Operation descriptions are non-authoritative. A Verifier or Credential Adapter MUST rely on trusted deployment policy before executing an Action.

### 14.2 No Secrets in Plugins

An `MpasApplicationPlugin` MUST NOT contain real secrets, API keys, OAuth tokens, passwords, private keys, session cookies, vault handles, or deployment-specific credential references.

Credential requirement objects describe credential classes only.

### 14.3 Application DID and Execution Profile Pairing

A consuming Verifier or Credential Adapter MUST validate that the plugin's Application DID and execution profile are trusted together.

A malicious plugin MUST NOT be able to cause a Credential Adapter to interpret one application's payloads using an unrelated or overly permissive execution profile.

### 14.4 Payload Validation Is Necessary but Not Sufficient

`executionPayloadSchema` validates the shape of an Execution Payload. It does not prove that execution is safe.

A consuming system MUST still verify MPAS bindings, evaluate policy, enforce credential restrictions, and execute only through trusted runtime configuration.

### 14.5 Artifact Verification

If a plugin is distributed with an external content-addressed identifier, such as `did:artifact`, a consumer SHOULD verify the fetched bytes against that identifier before relying on the plugin.

This profile does not define the artifact method or distribution record format.

---

## 15. Examples

### 15.1 GitHub Repository Operations over MCP (Multi-Operation)

```json
{
  "version": "1",
  "type": "MpasApplicationPlugin",
  "pluginDid": "did:web:plugins.example.com:github-repo",
  "pluginVersion": "1.0.0",
  "publisherDid": "did:web:wivity.example",
  "applicationDid": "did:web:github.com",
  "executionProfile": {
    "id": "did:web:profiles.oma3.org:mcp",
    "format": "mcp.toolsCall"
  },
  "credentialRequirements": [
    {
      "type": "oauthToken",
      "requiredCapabilities": ["pullRequest.merge", "pullRequest.read", "repo.delete"],
      "description": "GitHub OAuth token with repository access for the configured organizations."
    }
  ],
  "operations": [
    {
      "name": "merge_pull_request",
      "description": "Merge a pull request into its base branch.",
      "executionPayloadSchema": {
        "type": "object",
        "required": ["name", "arguments"],
        "properties": {
          "name": {
            "const": "merge_pull_request"
          },
          "arguments": {
            "type": "object",
            "required": [
              "owner",
              "repo",
              "pullNumber",
              "baseRef",
              "expectedHeadSha",
              "mergeMethod"
            ],
            "properties": {
              "owner": { "type": "string" },
              "repo": { "type": "string" },
              "pullNumber": { "type": "integer" },
              "baseRef": { "type": "string" },
              "expectedHeadSha": { "type": "string" },
              "mergeMethod": {
                "type": "string",
                "enum": ["merge", "squash", "rebase"]
              }
            },
            "additionalProperties": false
          }
        },
        "additionalProperties": false
      }
    },
    {
      "name": "delete_branch",
      "description": "Delete a branch from a repository.",
      "executionPayloadSchema": {
        "type": "object",
        "required": ["name", "arguments"],
        "properties": {
          "name": {
            "const": "delete_branch"
          },
          "arguments": {
            "type": "object",
            "required": ["owner", "repo", "branch"],
            "properties": {
              "owner": { "type": "string" },
              "repo": { "type": "string" },
              "branch": { "type": "string" }
            },
            "additionalProperties": false
          }
        },
        "additionalProperties": false
      }
    },
    {
      "name": "create_issue",
      "description": "Create a new issue in a repository.",
      "executionPayloadSchema": {
        "type": "object",
        "required": ["name", "arguments"],
        "properties": {
          "name": {
            "const": "create_issue"
          },
          "arguments": {
            "type": "object",
            "required": ["owner", "repo", "title"],
            "properties": {
              "owner": { "type": "string" },
              "repo": { "type": "string" },
              "title": { "type": "string" },
              "body": { "type": "string" },
              "labels": {
                "type": "array",
                "items": { "type": "string" }
              }
            },
            "additionalProperties": false
          }
        },
        "additionalProperties": false
      }
    }
  ],
  "policySuggestions": [
    {
      "description": "Merging into main is high impact and should require maintainer approval.",
      "impact": "high",
      "match": {
        "conditions": [
          {
            "source": "executionPayload",
            "path": "/name",
            "op": "eq",
            "value": "merge_pull_request"
          },
          {
            "source": "executionPayload",
            "path": "/arguments/baseRef",
            "op": "eq",
            "value": "main"
          }
        ]
      },
      "suggestedRequirement": {
        "kind": "approvalThreshold",
        "eligibleSignerRole": "maintainer",
        "minimumThreshold": 2,
        "decision": "approve"
      }
    },
    {
      "description": "Deleting any branch is a destructive operation.",
      "impact": "medium",
      "match": {
        "conditions": [
          {
            "source": "executionPayload",
            "path": "/name",
            "op": "eq",
            "value": "delete_branch"
          }
        ]
      },
      "suggestedRequirement": {
        "kind": "approvalThreshold",
        "eligibleSignerRole": "maintainer",
        "minimumThreshold": 1,
        "decision": "approve"
      }
    }
  ]
}
```

### 15.2 Generated Policy from Suggestion

A policy tool could convert a policy suggestion into an `MpasApplicationPolicy` entry selected by the operator.

```json
{
  "description": "Merging into main requires two maintainer approvals.",
  "match": {
    "conditions": [
      {
        "source": "executionPayload",
        "path": "/name",
        "op": "eq",
        "value": "merge_pull_request"
      },
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
}
```

The signer group and threshold are deployment choices. They are not defined by the plugin.

---

## 16. Future Work

Future documents or versions may define:

- native binding descriptors for non-MCP execution profiles, including:
  - `openapi.operation` bindings (path, method, operationId);
  - `evm.transactionIntent` bindings (contract address, function selector, chain identifier);
  - `graphql.operation` bindings (operation type, field name, schema reference);
  - `x402.payment` bindings;
  - `http.request` bindings;
  - `cli.command` bindings;
  - `browser.recipe` and `desktop.recipe` bindings;
- per-operation credential requirements (if future use cases require credential differentiation at the operation level);
- plugin activation or deployment configuration;
- rendering and clear-review descriptors;
- receipt mappings;
- OMATrust attestations and trust scoring for plugins;
- `did:artifact` distribution and lockfile formats;
- MCP Apps or rich UI review integration;
- preconditions and state assertions;
- plugin packaging, signing, and update channels;
- executable plugin sandboxing;
- LLM-assisted plugin generation from application documentation;
- conformance test vectors.

### 16.1 Native Binding Design Guidance

When a future execution profile specification defines `nativeBinding` for the operation object, it SHOULD:

- define the required and optional properties for the binding object;
- specify how the operation `name` relates to the native dispatch target (whether the name alone is sufficient or additional binding properties are needed);
- provide a JSON Schema fragment for validation;
- identify which binding properties are plugin-level facts versus deployment-specific configuration.

Expected binding shapes (non-normative sketches):

**OpenAPI:**
```json
{
  "nativeBinding": {
    "path": "/v2/users/{id}",
    "method": "DELETE",
    "operationId": "deleteUser"
  }
}
```

**EVM:**
```json
{
  "nativeBinding": {
    "functionSignature": "transfer(address,uint256)",
    "functionSelector": "0xa9059cbb"
  }
}
```
Note: `contractAddress` and `chainId` may be deployment-specific and therefore not included in the plugin binding.

**GraphQL:**
```json
{
  "nativeBinding": {
    "operationType": "mutation",
    "fieldName": "deleteRepository"
  }
}
```

These sketches are illustrative. Normative definitions will be provided by the corresponding execution profile specifications.

---

## Appendix A. JSON Schema for `MpasApplicationPlugin`

This appendix provides an initial JSON Schema for structural validation. The schema validates the shape of an application plugin document. Normative semantics are defined in the body of this profile.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.oma3.org/mpas/application-plugin/v1/schema.json",
  "title": "MpasApplicationPlugin",
  "type": "object",
  "required": [
    "version",
    "type",
    "pluginDid",
    "pluginVersion",
    "publisherDid",
    "applicationDid",
    "executionProfile",
    "operations"
  ],
  "properties": {
    "version": {
      "const": "1"
    },
    "type": {
      "const": "MpasApplicationPlugin"
    },
    "pluginDid": {
      "type": "string",
      "pattern": "^did:[a-z0-9]+:.+"
    },
    "pluginVersion": {
      "type": "string",
      "minLength": 1
    },
    "publisherDid": {
      "type": "string",
      "pattern": "^did:[a-z0-9]+:.+"
    },
    "applicationDid": {
      "type": "string",
      "pattern": "^did:[a-z0-9]+:.+"
    },
    "executionProfile": {
      "type": "object",
      "required": ["id"],
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^did:[a-z0-9]+:.+"
        },
        "format": {
          "type": "string",
          "minLength": 1
        }
      },
      "additionalProperties": false
    },
    "credentialRequirements": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/credentialRequirement"
      }
    },
    "operations": {
      "type": "array",
      "minItems": 1,
      "items": {
        "$ref": "#/$defs/operation"
      }
    },
    "policySuggestions": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/policySuggestion"
      }
    }
  },
  "additionalProperties": false,
  "$defs": {
    "operation": {
      "type": "object",
      "required": ["name", "executionPayloadSchema"],
      "properties": {
        "name": {
          "type": "string",
          "minLength": 1
        },
        "description": {
          "type": "string"
        },
        "executionPayloadSchema": {
          "type": "object"
        }
      },
      "additionalProperties": false
    },
    "credentialRequirement": {
      "type": "object",
      "required": ["type"],
      "properties": {
        "type": {
          "type": "string"
        },
        "requiredCapabilities": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "description": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "policySuggestion": {
      "type": "object",
      "required": ["match"],
      "properties": {
        "description": {
          "type": "string"
        },
        "impact": {
          "type": "string"
        },
        "match": {
          "type": "object"
        },
        "suggestedRequirement": {
          "$ref": "#/$defs/suggestedRequirement"
        }
      },
      "additionalProperties": false
    },
    "suggestedRequirement": {
      "type": "object",
      "required": ["kind"],
      "properties": {
        "kind": {
          "type": "string"
        },
        "eligibleSignerRole": {
          "type": "string"
        },
        "minimumThreshold": {
          "type": "integer",
          "minimum": 1
        },
        "decision": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  }
}
```
