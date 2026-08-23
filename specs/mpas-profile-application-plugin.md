# MPAS Application Plugin Profile

**Status:** Draft v0.2
**Companion to:** MPAS Core Specification, MPAS HTTP Profile, and MPAS JSON Verifier Policy Profile  
**Suggested filename:** `mpas-profile-application-plugin.md`  
**Primary object:** `MpasApplicationPlugin`  
**Scope:** A portable JSON descriptor for an application's MPAS-exposed command surface, including profile-native Execution Payload schemas and credential requirement classes.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** are to be interpreted as described in RFC 2119 and RFC 8174.

---

## 1. Introduction

The MPAS Core Specification defines profile-native Execution Payloads. The base specification does not define universal Execution Payload fields. Instead, the Action Envelope identifies the target Application DID and the execution profile used to interpret the Execution Payload, while the Execution Payload remains in the native format defined by that execution profile.

The MPAS Application Plugin Profile defines a portable JSON document that describes an application's MPAS-exposed command surface. An application plugin can be consumed by:

- a Credential Adapter that needs to validate profile-native Execution Payloads and execute them against a non-MPAS-native application;
- a native MPAS Application that wants to publish the operations and payload schemas it supports;
- an MCP gateway that wants to protect high-impact MCP tool calls with MPAS approvals;
- a policy authoring tool that wants to generate `MpasApplicationPolicy` objects from operation metadata;
- an agent or proposer tool that wants to construct valid Execution Payloads;
- a signer or review tool that wants to understand which payload fields are relevant to an operation.

This profile is intentionally small. It defines the common application-plugin descriptor needed for MPAS v0.2:

- stable plugin identity;
- publisher identity;
- target Application DID;
- execution profile binding;
- operation descriptors with optional impact metadata;
- profile-native Execution Payload schemas;
- credential requirement classes;
- a normative rule for inferring native tool identity from the operation name under MCP.

This profile does not define deployment activation, credential bindings, signer groups, approval requirements, approval thresholds, rendering templates, receipt mappings, OMATrust attestations, marketplace behavior, or plugin code packaging. Those concerns are left to implementations, the MPAS JSON Verifier Policy Profile, or future profiles.

---

## 2. Scope and Non-Goals

### 2.1 Scope

This profile defines:

- the `MpasApplicationPlugin` JSON object;
- stable plugin identity fields;
- execution profile binding;
- an operation catalog keyed by operation name;
- operation-level profile-native Execution Payload schemas;
- optional operation-level impact metadata;
- credential requirement class descriptors;
- security requirements for plugin consumers;
- a JSON Schema appendix for structural validation.

### 2.2 Non-Goals

This profile does not define:

- deployment activation state;
- real credential references, vault handles, API keys, OAuth tokens, private keys, or local secret storage;
- signer groups, signer thresholds, approval requirements, or organization-specific policy decisions;
- policy match conditions or approval requirement expressions;
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

The MPAS JSON Verifier Policy Profile defines `MpasApplicationPolicy`, a deterministic JSON policy object for one Application DID and one execution profile. Policy objects define signer groups, approval requirements, match conditions, and default requirements.

An application plugin does not contain policy. It describes the command surface — operations, payload schemas, and credential classes.

A Credential Adapter or policy authoring tool MAY use the plugin's operation catalog and optional impact metadata to help an operator author policy. The operator is responsible for defining signer groups, approval requirements, and match conditions. The plugin MUST NOT prescribe or suggest specific approval thresholds, signer groups, or requirement types — those are deployment decisions that vary by organization.

Actual policy is stored in a Verifier, native Application, Credential Adapter, MCP gateway, or other trusted deployment configuration, not in the plugin.

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

Under an MCP execution profile, policy conditions commonly reference `/name` and `/arguments/...` paths. The application plugin describes the tool names, argument schemas, and credential requirement classes that apply to those MCP payloads. Policy conditions and approval requirements are defined separately in `MpasApplicationPolicy` objects.

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
- these operations carry these impact labels (informational).

The consuming system stores:

- which plugin versions are trusted;
- which operations are enabled;
- which resources are allowed;
- which real credentials are bound;
- which signer groups and approval thresholds apply;
- which policy conditions and requirements govern each operation;
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
  "pluginVersion": "0.1.0",
  "publisherDid": "did:web:wivity.example",
  "applicationDid": "did:web:github.com",
  "executionProfile": {
    "id": "did:web:profiles.oma3.org:mcp",
    "format": "mcp.toolsCall",
    "protocolVersion": "2024-11-05"
  },
  "credentialRequirements": [
    {
      "type": "oauthToken",
      "requiredCapabilities": ["pullRequest.merge", "pullRequest.read", "issue.write"],
      "description": "GitHub OAuth token with repository access for the configured organizations."
    }
  ],
  "operations": {
    "merge_pull_request": {
      "description": "Merge a pull request into its base branch.",
      "impact": "high",
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
  }
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
| `executionProfile.protocolVersion` | Yes | Upstream protocol revision the Credential Adapter MUST use when initializing execution for this plugin. |
| `credentialRequirements`   | Optional    | Array of credential requirement class descriptors for the plugin.                                                     |
| `operations`               | Yes         | Object of operation descriptors keyed by operation name. Each key is the native operation identifier (e.g., MCP tool name). |

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
  "format": "mcp.toolsCall",
  "protocolVersion": "2024-11-05"
}
```

Field definitions:

| Field             | Required    | Description |
| :---------------- | :---------: | :---------- |
| `id`              | Yes         | DID of the execution profile. |
| `format`          | Recommended | Specific format under the execution profile. |
| `protocolVersion` | Yes         | Profile-native upstream protocol revision used to initialize execution. For the MCP profile this is an MCP revision such as `2024-11-05`. |

A consuming Verifier or Credential Adapter MUST validate that the declared Action Envelope execution profile is permitted for the plugin's Application DID under trusted local configuration.

A plugin MUST NOT cause a Credential Adapter to accept an arbitrary execution profile for an Application DID. The pairing of Application DID and execution profile must be trusted by the consuming deployment.

`executionProfile.protocolVersion` is trusted runtime binding metadata from the installed plugin. It is not copied into the Action Envelope and does not change the hash-covered execution intent. A Credential Adapter MUST use this value when initializing the upstream protocol and MUST NOT replace it with a registry hint, discovery record, SDK default, or deployment override.

---

## 8. Operations

The `operations` object describes the MPAS-exposed operations supported by this plugin. Each property key is the operation name; the value is an operation descriptor object.

For the `mcp.toolsCall` execution profile, the operation key MUST equal the native MCP tool name exactly as exposed by the target MCP server (e.g., `merge_pull_request`, not `github.merge_pull_request`). Disambiguation across applications is provided by `actionEnvelope.target.applicationDid`; the operation key MUST NOT carry a namespace prefix for that purpose. For other execution profiles, the operation key MUST be the native identifier as defined by that profile.

Example:

```json
{
  "operations": {
    "merge_pull_request": {
      "description": "Merge a pull request into its base branch.",
      "impact": "high",
      "executionPayloadSchema": {}
    },
    "create_issue": {
      "description": "Create a new issue in a repository.",
      "impact": "low",
      "executionPayloadSchema": {}
    }
  }
}
```

Field definitions for an operation descriptor object:

| Field                    | Required    | Description                                                                        |
| :----------------------- | :---------: | :--------------------------------------------------------------------------------- |
| `description`            | Recommended | Human-readable description. Non-authoritative.                                     |
| `impact`                 | Optional    | Publisher's assessment of the operation's impact level, such as `low`, `medium`, `high`, or `critical`. Informational only — does not define or constrain policy. A Credential Adapter or policy tool MAY use impact metadata to guide an operator during policy authoring. |
| `executionPayloadSchema` | Yes         | JSON Schema describing valid profile-native Execution Payloads for this operation. |

For the `mcp.toolsCall` format, no separate native binding descriptor is required — the operation key is sufficient.

The operation object does not define deployment policy. It does not enable the operation for any particular deployment. It does not bind real credentials. It does not prescribe approval requirements.

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

The `name` constraint in the schema SHOULD match the operation's key in the `operations` object. If they conflict, the operation key is authoritative.

A consuming Verifier or Credential Adapter MUST validate the Execution Payload under the declared execution profile and trusted configuration before using the payload for policy evaluation or execution.

A plugin's schema is a descriptor, not proof of safety. A consuming system MUST still enforce local trust policy, credential binding policy, and execution restrictions.

---

## 10. Native Tool Identity

For the `mcp.toolsCall` execution profile, the naming rule in Section 8 applies: the operation key in the `operations` object is the native MCP tool name. No separate native binding descriptor is needed.

A consumer processing an MCP-profile plugin SHOULD treat the operation key as the authoritative MCP tool identifier.

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
| `requiredCapabilities` | Optional | Array of capability strings describing the authority expected. These are governance artifacts and MUST NOT be transmitted as OAuth scopes.           |
| `refreshScope`         | Optional | Provider-specific OAuth refresh-scope name. Defaults to `offline_access` when omitted (`offline.access` for X/Twitter, `refresh_token` for Salesforce). |
| `description`          | Optional | Human-readable explanation. Non-authoritative.                                                                                                       |

Credential requirements apply to the plugin as a whole. All operations described by the plugin share the same credential class requirements.

A Credential Adapter may use credential requirements to help an administrator bind local credentials. The binding itself is outside this profile.

A Credential Adapter MUST NOT let the Execution Payload, plugin document, or Proposer choose the actual credential. Actual credential selection comes from trusted deployment configuration.

---

## 12. Impact Metadata

Operations MAY include an `impact` field as informational metadata. A Credential Adapter or policy authoring tool MAY use impact metadata to guide the operator during policy creation — for example, by highlighting high-impact operations that likely need non-trivial approval requirements.

Impact metadata is not policy. It does not constrain, suggest, or prescribe approval requirements, signer groups, or thresholds. The operator is solely responsible for defining policy appropriate to their organization.

### 12.1 Separation of Concerns

The plugin defines the command surface. The `MpasApplicationPolicy` defines authorization rules. This separation ensures that:

- a plugin publisher cannot prescribe organizational approval patterns;
- operators retain full authority over their approval requirements;
- the same plugin can be deployed under vastly different policy regimes (solo developer, team threshold, DAO multisig, enterprise CISO chain);
- policy authoring remains an explicit operator action, not a passive acceptance of publisher defaults.

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
5. look up the operation key in the `operations` object and validate the Execution Payload against its `executionPayloadSchema`;
6. use local deployment policy to determine whether the operation is enabled and which credentials, if any, may be used.

### 13.3 Policy Authoring

A policy authoring tool MAY use the plugin's operation catalog and impact metadata to help an operator generate draft `MpasApplicationPolicy` entries.

The generated policy MUST be reviewed and accepted by the operator before it becomes active. The plugin does not contain policy and MUST NOT be used to authorize or block an Action.

### 13.4 Credential Adapter Use

A Credential Adapter MAY use an application plugin to:

- validate profile-native Execution Payloads;
- identify the native MCP tool from the operation key;
- inform an administrator which credential classes are needed;
- present impact metadata during policy authoring;
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

Credential requirements are descriptive. Operation descriptions are non-authoritative. Impact labels are informational. A Verifier or Credential Adapter MUST rely on trusted deployment policy before executing an Action.

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
  "pluginVersion": "0.1.0",
  "publisherDid": "did:web:wivity.example",
  "applicationDid": "did:web:github.com",
  "executionProfile": {
    "id": "did:web:profiles.oma3.org:mcp",
    "format": "mcp.toolsCall",
    "protocolVersion": "2024-11-05"
  },
  "credentialRequirements": [
    {
      "type": "oauthToken",
      "requiredCapabilities": ["pullRequest.merge", "pullRequest.read", "repo.delete"],
      "description": "GitHub OAuth token with repository access for the configured organizations."
    }
  ],
  "operations": {
    "merge_pull_request": {
      "description": "Merge a pull request into its base branch.",
      "impact": "high",
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
    "delete_branch": {
      "description": "Delete a branch from a repository.",
      "impact": "high",
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
    "create_issue": {
      "description": "Create a new issue in a repository.",
      "impact": "low",
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
  }
}
```

### 15.2 Operator-Authored Policy for Plugin Operations

An operator uses the plugin's operation catalog and impact metadata to author an `MpasApplicationPolicy`. The plugin does not contain or suggest policy — the operator defines requirements appropriate to their organization.

For a normal multi-party deployment, the operator SHOULD use a threshold of at
least one independent maintainer as `defaultRequirement`, so every plugin
operation is reviewed unless a stricter operation-specific rule applies. An
operator may intentionally select `proposerOnly`.

```json
{
  "version": "1",
  "type": "MpasApplicationPolicy",
  "policyProfileUrl": "https://github.com/oma3dao/mpas/blob/main/specs/mpas-profile-policy-json.md",
  "applicationDid": "did:web:github.com",
  "executionProfile": {
    "id": "did:web:profiles.oma3.org:mcp",
    "format": "mcp.toolsCall"
  },
  "defaultRequirement": {
    "type": "threshold",
    "threshold": 1,
    "eligibleSignerGroup": "maintainers",
    "decision": "approve"
  },
  "signerGroups": {
    "all": [
      "did:web:alice.example",
      "did:web:bob.example",
      "did:web:carol.example",
      "did:web:agent.example"
    ],
    "proposers": [
      "did:web:agent.example"
    ],
    "maintainers": [
      "did:web:alice.example",
      "did:web:bob.example",
      "did:web:carol.example"
    ]
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
      }
    ],
    "delete_branch": [
      {
        "description": "Deleting any branch requires one maintainer approval.",
        "requirements": {
          "type": "threshold",
          "threshold": 1,
          "eligibleSignerGroup": "maintainers",
          "decision": "approve"
        }
      }
    ]
  }
}
```

The signer groups, thresholds, and match conditions are deployment choices. They are not defined by the plugin.

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
- specify how the operation key relates to the native dispatch target (whether the key alone is sufficient or additional binding properties are needed);
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
      "required": ["id", "protocolVersion"],
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^did:[a-z0-9]+:.+"
        },
        "format": {
          "type": "string",
          "minLength": 1
        },
        "protocolVersion": {
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
      "type": "object",
      "minProperties": 1,
      "additionalProperties": {
        "$ref": "#/$defs/operation"
      }
    }
  },
  "additionalProperties": false,
  "$defs": {
    "operation": {
      "type": "object",
      "required": ["executionPayloadSchema"],
      "properties": {
        "description": {
          "type": "string"
        },
        "impact": {
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
        "refreshScope": {
          "type": "string",
          "minLength": 1
        },
        "description": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  }
}
```
