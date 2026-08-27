# Multi-Party Action Standard (MPAS) Core Specification

## Overview and Architecture

**Status:** Draft v0.2
**Intended venue:** MSF Economy and Trust Working Group / OMA3
**Scope:** Multi-party approval and execution of high-impact digital actions across Web2, Web3, AI agents, cloud infrastructure, local applications, and future digital environments

## Normative Keywords

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** in this document are to be interpreted as described in RFC 2119 and RFC 8174.

## Scope

MPAS Core defines portable data structures and protocol rules for representing an action, collecting multi-party approvals, verifying those approvals, executing the approved action, and emitting receipts.

## 1. Introduction

Digital systems increasingly rely on humans, agents, applications, wallets, devices, cloud services, and automated systems to initiate consequential digital actions. These actions may include transferring digital assets, deleting data, deploying software, granting API access, executing payments, changing infrastructure, approving agent activity, calling smart contract functions, rotating credentials, or running sensitive commands.

Today, these actions are authorized through fragmented, application-specific mechanisms. A blockchain wallet may request a transaction signature. A cloud console may ask an administrator to approve a deployment. A SaaS API may require an OAuth token or API key. A local application may rely on operating-system permissions. An AI agent may be granted broad credentials and then act unilaterally.

For high-impact actions, unilateral authority is risky. Agents and automated systems should not generally hold powerful ambient credentials. Signers should be able to see and verify what they are approving. Applications should be able to determine whether required approvals were obtained before execution. Organizations should be able to audit who proposed, approved, rejected, executed, or failed a consequential action.

The Multi-Party Action Standard (MPAS) defines a portable architecture for representing an action, binding it to an executable payload, collecting multi-party approvals, verifying approvals, executing the approved action, and emitting receipts.

MPAS is centered on an **Action Package**: a portable package containing the Execution Payload, Action Envelope, Approval Bundle, and optional authorization, policy, or audit evidence. This package can be delivered to an application such as a smart contract, local service, or other verifier. The receiving verifier determines whether the package satisfies the applicable policy before execution.

An Agent Signer may produce Approvals, but MPAS does not require or assume that nondeterministic LLM judgment is authoritative. A nondeterministic LLM MUST NOT be the sole or final authorization authority unless its output is constrained by deterministic Verifier policy. Final authorization is always determined by the Verifier under deterministic policy.

MPAS maintains coordination flexibility. Approval coordination may occur through a separate coordination service, smart contract approval registry, application-native workflow, peer-to-peer messages, enterprise workflow tool, local IPC, email, messaging application, or manual transfer. Coordination is a transport and workflow concern. Authorization is enforced by the application or other verifier that decides whether an Action Package is valid.

MPAS ideally is integrated directly into the application, but it supports existing applications through a **Credential Adapter Pattern**, where an MPAS-aware verifier converts approved MPAS actions into the credential, signature, token, session, or request format accepted by a non-MPAS-native downstream system. This allows time for **Native MPAS Verification**, where applications directly verify MPAS artifacts before executing consequential actions.

MPAS Execution Payloads are **profile-native**. The base specification does not prescribe a universal Execution Payload format. Each execution profile (MCP tool calls, OpenAPI operations, EVM transaction intents, HTTP requests, CLI commands, etc.) defines the payload shape, hashing rules, and interpretation semantics. The Action Envelope carries the MPAS interpretation layer — target identity, execution profile, replay protection, and expiration — while the Execution Payload remains in its native application or protocol format.

## 2. Definitions and Terminology

This section defines the core terms used throughout MPAS.

| Term                       | Definition                                                                                                                                                                                                          |
| :------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Action                     | A digital operation executed by an Application.                                                                                                                                                                     |
| Execution Payload          | The profile-native application command, transaction, request, message, or instruction that the Application must execute.                                                                                            |
| Execution Profile          | An identifier and optional format descriptor that tells participants how to interpret, validate, hash, and render an Execution Payload.                                                                             |
| Signer                     | Any entity (human, agent, device, smart contract, organization, or component) that signs an Action Envelope.                                                                                                        |
| Action Envelope            | An object signed by Signers containing the Execution Payload hash, target identity, execution profile, and other metadata.                                                                                          |
| Approval                   | Any signed artifact or reference showing that a Signer approved, rejected, or contributed to authorization of an Action Envelope.                                                                                   |
| Approval Bundle            | An object containing all Approvals and other metadata.                                                                                                                                                              |
| Action Package             | The portable package delivered to a Verifier, containing the Execution Payload, Action Envelope, and Approval Bundle.                                                                                               |
| Authorization Requirements | Verifier-returned requirements describing what approvals are required for an Action.                                                                                                                                |
| Proposer                   | The actor that initiates an Action. The Proposer creates the Execution Payload, constructs the Action Envelope, produces an initial Approval, assembles the Action Package, and delivers the package for execution. |
| Verifier                   | The component that determines whether an Action Package satisfies the applicable policy and may be executed. Can be part of an Application or a Credential Adapter.                                                 |
| Application                | The component that executes the Action desired by the Proposer.                                                                                                                                                     |
| Credential Adapter         | A component that is not an Application but includes a Verifier. Verifies the Action Package and uses stored or constructed credentials to instruct the Application.                                                 |
| Coordination Channel       | Any channel used to communicate proposed actions, Execution Payloads, Action Envelopes, approvals, rejections, or Action Packages.                                                                                  |
| Coordination Service       | An optional service that stores, routes, synchronizes, and tracks Action Envelopes and Approval Bundles.                                                                                                            |
| Policy Engine              | A system inside the Verifier that determines whether an Action has sufficient approval to proceed.                                                                                                                  |
| Execution Receipt          | Evidence that an approved Action was executed, failed, or resolved.                                                                                                                                                 |
| Signature Suite            | Identifies the cryptographic or provider-specific mechanism used to approve or sign an Action Envelope.                                                                                                             |
| Participant                | Any entity involved in the lifecycle of an Action.                                                                                                                                                                  |
| Agent                      | An autonomous or semi-autonomous software actor that can request, review, approve, or execute Actions.                                                                                                              |

**Signer Subtypes:** The Signer category broadly includes any component that contributes to authorization. Subtypes should include at least: Human Signer, Agent Signer, Organization Signer, Policy Signer, and Threshold Signer.

## 3. Problem Statement and Goals

Modern systems for approving high-impact digital Actions suffer from several recurring weaknesses:

1. **Unilateral agent authority**
   Agents are often granted broad credentials or tool access that allow them to act without independent review. This creates risk when agents perform destructive, expensive, privacy-sensitive, or security-sensitive Actions.

2. **Ambiguous Action objects**
   Users, Agents, devices, and organizations often approve Actions without a canonical, verifiable representation of what is being approved. A signer may see a summary or preview but cannot independently verify that the displayed information matches the payload that will actually be executed.

3. **Fragmented signing and execution systems**
   MPC providers, HSMs, smart contract wallets, hardware wallets, local signers, passkeys, account abstraction systems, and institutional custody platforms use incompatible interfaces. This makes it difficult to switch providers, combine mechanisms, or build interoperable approval clients.

4. **Weak auditability**
   Enterprises, users, insurers, regulators, and security teams lack a standard way to reconstruct who proposed, approved, rejected, signed, executed, revoked, or failed a sensitive Action.

5. **No cross-domain approval standard**
   Existing approaches are application-specific. Blockchain wallets, Web2 SaaS applications, cloud consoles, local applications, custody platforms, and agent frameworks each define their own Action and approval semantics.

MPAS is designed to:

* Create a common standard for Action approvals across all types of Applications.
* Bring checks and balances to agentic workflows without requiring a human for every approval.
* Define a canonical object representing a requested Action.
* Allow signers, agents, users, devices, and organizations to independently verify what is being approved.
* Support a variety of approval clients, including web, mobile, desktop, CLI, hardware, and agent clients.
* Support different signing and execution mechanisms including MPC, HSMs, smart contract wallets, account abstraction, local signer services, passkeys, institutional custody platforms, and future schemes.
* Allow policies such as thresholds, roles, budgets, risk controls, and signer diversity requirements to be defined outside the base standard.
* Provide a minimal portable audit-log model.

MPAS does not define:

* The number of approvals required for any Action.
* Authentication protocols such as OAuth2, FIDO/WebAuthn, SIWE, SAML, or OpenID Connect.
* A universal policy engine.
* A universal Execution Payload format. Each execution profile defines the payload shape for its domain.

These concerns belong to relying applications, policy engines, enterprises, wallets, coordinators, execution adapters, execution profiles, or other domain-specific systems.

## 4. Architecture

### 4.1 End-to-End Flow

A typical high-level MPAS flow proceeds as follows:

1. Proposer constructs a profile-native Execution Payload and an Action Envelope (identifying target, execution profile, and binding to the payload by hash), then assembles an Action Package with the Proposer's own Approval and submits it to the Verifier.
2. Verifier evaluates the Action Package against policy. If the Proposer's Approval alone is insufficient, the Verifier responds with Authorization Requirements.
3. Proposer makes the Action Envelope and Execution Payload available to eligible Signers. A Coordination Service may be used to facilitate this exchange.
4. Each Signer verifies the Action Envelope and Execution Payload using the declared execution profile.
5. Signer signs an Approval and returns it to the Proposer.
6. Once the Proposer has collected the required Approvals, it assembles a completed Action Package with an updated Approval Bundle and submits it to the Verifier.
7. Verifier approves the Action Package and instructs the Application to execute based on the Execution Payload.
8. Application returns an Execution Receipt to the Proposer.

### 4.2 Coordination Service

A Coordination Service is optional. MPAS artifacts may be exchanged over any Coordination Channel, including direct messaging, local IPC, enterprise workflow systems, smart contracts, hosted services, or manual transfer.

Assembling an Approval Bundle and a completed Action Package requires communicating with Signers, transmitting the Execution Payload and Action Envelope, collecting Approvals, tracking approval status, and optionally distributing Execution Receipts. This functionality may be performed by the Proposer or outsourced to a Coordination Service.

A Coordination Service may:

* store proposed Action Packages and Authorization Requirements;
* make Execution Payloads, Action Envelopes, and Authorization Requirements available to Signers;
* route messages to Signers;
* collect Approvals and Rejections;
* synchronize approval status;
* assemble Approval Bundles;
* assemble completed Action Packages ready for resubmission to the Verifier;
* make assembled Approval Bundles or completed Action Packages available to the Proposer;
* publish audit logs;
* distribute Execution Receipts.

Trust boundaries and security requirements for Coordination Services are defined in Section 7.7.

### 4.3 Credential Adapter

A Credential Adapter is an MPAS-aware Verifier that converts an approved MPAS Action Package into the traditional credential-based authorization mechanism accepted by a non-MPAS-native Application.

A Credential Adapter verifies the completed Action Package, including the Execution Payload (using `actionEnvelope.target.applicationDid` and `actionEnvelope.executionProfile`), Action Envelope, Approval Bundle, nonce, expiration, replay domain, target, and applicable policy. If verification succeeds, it uses, obtains, transforms, signs with, injects, forwards, or releases a credential or authorization artifact accepted by the Application.

Examples of credentials and authorization artifacts include:

* API keys;
* OAuth access tokens;
* service accounts;
* SSH keys;
* wallet keys;
* session credentials;
* passkeys;
* provider-specific signing APIs;
* signed blockchain transactions.

A Credential Adapter may either:

* return a signed artifact, such as a signed transaction or detached signature; or
* perform the outbound authenticated request internally when the credential must not be exposed to the Proposer or agent.

Examples of the Credential Adapter pattern include:

* **API Key Adapter:** An agent proposes an HTTP API call. The Credential Adapter verifies the Action Package and injects an API key only if policy is satisfied.
* **OAuth Adapter:** An agent proposes an action against a SaaS API. The Credential Adapter obtains or uses a scoped OAuth access token only after MPAS verification.
* **SSH/Deployment Adapter:** An agent proposes a deployment command. The Credential Adapter verifies the Action Package and uses a protected SSH or deploy key to execute the approved command.
* **Wallet Adapter:** An agent proposes a blockchain transaction. The Credential Adapter verifies the Action Package and signs or submits the transaction using a protected wallet key, custody provider, HSM/KMS, or smart-account execution path.

The Credential Adapter enables MPAS adoption by existing applications without requiring native MPAS integration. It is a practical migration path that allows existing key-based applications to benefit from MPAS while keeping powerful ambient credentials away from agents. Native MPAS Verification is the highest-assurance model and the long-term target for Applications.

Security requirements and trust boundaries for Credential Adapters are defined in Section 7.6.

## 5. Data Structures

This section defines the core MPAS data structures used to represent, review, approve, verify, execute, and audit an Action.

MPAS data structures are designed to be transport-neutral. They may be transmitted over HTTP, local IPC, messaging systems, smart contract calldata, files, enterprise workflow systems, or a Coordination Service.

The core MPAS data structures are:

* Execution Payload
* Action Envelope
* Signer Review Set
* Approval
* Approval Bundle
* Action Package
* Authorization Requirements
* Execution Receipt

### 5.1 Common Data Structure Rules

#### 5.1.1 Encoding

MPAS protocol objects (Action Envelopes, Approvals, Approval Bundles, Action Packages, Authorization Requirements, Execution Receipts, and Signer Review Sets) are represented as JSON objects.

An Execution Payload is the profile-native application command, request, transaction, message, or instruction. An Execution Payload MAY be a JSON object, JSON-RPC parameter object, transaction object, byte string, or other profile-native representation. The execution profile defines the payload format, hashing rules, and interpretation semantics. See Section 5.1.2 for canonicalization and hashing requirements.

#### 5.1.2 Canonicalization

MPAS protocol objects that are hashed or signed MUST be canonicalized using the JSON Canonicalization Scheme defined in RFC 8785 before hashing or signing.

For Execution Payloads, the execution profile defines the hashing and canonicalization rules. If the execution profile does not define deterministic hashing rules for its payload format, a Verifier MUST treat the payload format as unsupported.

For JWS Signature Approvals and JWS Execution Receipts, the JWS payload MUST be the JCS-canonicalized (RFC 8785) Canonical Approval Payload or Receipt Payload, encoded as the JWS payload per RFC 7515 Section 3 (base64url without padding).

The following additional rules apply to hashed or signed MPAS JSON protocol objects:

* JSON MUST be encoded as UTF-8 before canonicalization and signing.
* Duplicate JSON object member names MUST be rejected. A parser encountering duplicate keys in a hashed or signed MPAS object MUST treat the object as malformed.
* Timestamps MUST be strings in RFC 3339 / ISO 8601 UTC form with exactly three fractional digits (millisecond precision) and the `Z` suffix (e.g., `"2026-05-27T18:00:00.000Z"`). Implementations MUST NOT omit fractional digits or use a UTC offset other than `Z`. This ensures deterministic string representation for canonical hashing.
* Hash values MUST be strings (base64url-encoded without padding).
* Binary values MUST use base64url encoding without padding unless the field definition specifies otherwise.
* Floating-point numbers SHOULD NOT be used in hashed or signed MPAS protocol objects. Profiles needing precise numeric values SHOULD use string representations or define exact arbitrary-precision decimal/integer rules.
* If Unicode normalization matters for a field, the execution profile MUST define normalization requirements. MPAS Core does not silently normalize signed values.

#### 5.1.3 Version Field

All MPAS protocol objects other than profile-native Execution Payloads MUST include a `version` field. The `version` field identifies the schema version of the object and allows participants to determine how to parse and process the object.

For this version of the specification, the `version` value MUST be `"1"`.

An execution profile MAY require a version field inside its Execution Payload format.

#### 5.1.4 Hash Algorithm Requirements

`sha-256` MUST be implemented by all conforming MPAS implementations (mandatory-to-implement).

Implementations MUST NOT use MD5, SHA-1, or other algorithms known to be vulnerable to collision attacks or deprecated per current NIST guidance (SP 800-131A or equivalent).

Additional hash algorithms MAY be supported by future profiles or registries.

A Verifier MUST reject an Action Package that uses an unsupported or unrecognized hash algorithm.

Hash objects use the following form:

```json
{
  "alg": "sha-256",
  "value": "base64url-encoded-digest"
}
```

The `alg` field identifies the hash algorithm. The `value` field contains the base64url-encoded digest (base64url without padding).

#### 5.1.5 DID Method Requirements

MPAS does not require a specific DID method. Participants MAY use `did:web`, `did:jwk`, `did:pkh`, `did:ethr`, or any other DID method appropriate to their deployment.

This specification RECOMMENDS `did:jwk` for signing-key identities (Proposer agents, Signers, Verifiers) and `did:pkh` for wallet-backed identities. Baseline implementations SHOULD support `did:jwk` and `did:web`. Future conformance classes may require specific DID method support.

Implementations MUST reject DID methods they do not support rather than silently treating them as valid or ignoring identity verification for unsupported methods.

##### 5.1.5.1 DID Comparison

DIDs are compared as exact strings on their canonical form (per DID Core, the method-specific identifier is case-sensitive). Implementations MUST NOT case-fold or otherwise normalize DIDs at comparison time. Method-specific normalization (e.g., lowercasing a `did:web` host, checksumming a `did:pkh` account address) is an ingest concern: it happens once, when an identifier enters configuration or is minted, never during verification or policy evaluation.

##### 5.1.5.2 did:jwk Derivation (Normative)

The `did:jwk` method does not mandate a canonical JWK serialization: the same public key can yield different identifiers depending on member order and optional members. The method's contract is that the minted DID string is the identifier of record ("store the fully serialized URI"). To make independent MPAS implementations mint identical DIDs for identical keys, MPAS fixes the derivation:

1. Construct the minimal public JWK containing exactly the members required by RFC 7638 for the key type. For Ed25519 (OKP): `crv`, `kty`, `x`. Private members (`d`) MUST NOT be present.
2. Canonicalize with JCS (RFC 8785). For the minimal member set this equals the RFC 7638 thumbprint input: members in lexicographic order, no whitespace, UTF-8.
3. Encode the canonical bytes as base64url without padding and prefix with `did:jwk:`.

This rule governs minting only. At verification time the DID string is compared exactly (5.1.5.1) and, for `did:jwk`, is the source of truth for the key: implementations resolve the verification key by base64url-decoding the method-specific identifier. A decoded JWK containing private key material MUST be rejected. Where a deployment also configures a `publicJwk` alongside a `did:jwk` identity, the key embedded in the DID is authoritative; implementations SHOULD reject configurations where the two disagree.

Test vector (Ed25519):

```
publicJwk (minimal): {"crv":"Ed25519","kty":"OKP","x":"k6O7ciQkmphuEEt1i3yAimJJWeGKmOq3t_fsNkzza6o"}
did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Ims2TzdjaVFrbXBodUVFdDFpM3lBaW1KSldlR0ttT3EzdF9mc05renphNm8ifQ
```

The DID URL fragment for the single verification method of a `did:jwk` document is always `#0`.

### 5.2 Execution Payload

#### 5.2.1 Purpose

The Execution Payload is the application-specific command, transaction, request, message, or instruction that the Application may execute after the Action Package is verified.

The Execution Payload tells the Application what to do. It is not itself proof that the Action is authorized. The exact shape of the Execution Payload is defined by the execution profile, Application, or Credential Adapter — not by the base MPAS specification.

#### 5.2.2 Requirements

An Execution Payload MUST be deterministically hashable using the rules defined by the execution profile.
An Execution Payload MUST be interpretable under the `actionEnvelope.executionProfile` or other trusted Verifier/Application configuration.
An Execution Payload MUST NOT itself be treated as proof of authorization.
An Execution Payload MAY be a JSON object, JSON-RPC parameter object, transaction object, byte string, or other profile-native representation if hashing rules are defined by the execution profile.

#### 5.2.3 Fields

The base MPAS specification does not define universal Execution Payload fields. Each execution profile defines how the payload represents its native command, transaction, request, or operation semantics.

Target identity, execution profile, expiration, replay protection, and Proposer identity belong in the Action Envelope, not inside the Execution Payload.

#### 5.2.4 Referenced Payload Data

An Execution Payload MAY embed all data needed for execution directly in the payload.

Execution profiles MAY define referenced payload data mechanisms where the payload uses hashes, content-addressed identifiers, or application-local references for data not embedded directly.

If referenced data can affect the action's effect, the execution profile MUST define how the referenced data is cryptographically bound, content-addressed, immutable, or otherwise safely verified.

#### 5.2.5 Relationship to the Action Envelope

The Execution Payload is not signed directly by Signers.

Instead, the Action Envelope binds to the Execution Payload by hash. Signers approve the Action Envelope, and the Verifier later checks that the Execution Payload in the Action Package matches the hash bound in the Action Envelope.

The Action Envelope carries the MPAS interpretation layer — target Application DID, execution profile, replay protection, expiration — while the Execution Payload remains in its native format. Signers approve both:

* the hash-bound profile-native Execution Payload; and
* the Action Envelope metadata that defines how that payload is interpreted.

#### 5.2.6 Credential Adapter Interpretation

A Credential Adapter MUST use `actionEnvelope.target.applicationDid` and `actionEnvelope.executionProfile` to locate trusted Application configuration and interpret the Execution Payload.

A Credential Adapter MUST NOT allow the Execution Payload, Proposer, or unsigned metadata to select credentials, credential storage, credential scope, execution endpoint, or policy. Those decisions come from trusted adapter configuration and policy.

If the Credential Adapter cannot safely interpret the Execution Payload under the declared execution profile and trusted Application configuration, it MUST NOT execute.

#### 5.2.7 Example: MCP Tool Call

This example uses the MCP tool-call parameter object as the Execution Payload. It does not include the JSON-RPC `jsonrpc`, `id`, or `method` fields. The MCP execution profile defines how this object is converted into a native MCP `tools/call` JSON-RPC request at execution time.

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

> **Non-normative note:** Blockchain execution payloads are profile-specific. For EVM systems, a future profile may define whether the payload is an unsigned transaction request, smart-account execution request, contract call intent, or other transaction intent. The base specification does not define the EVM payload format.

### 5.3 Action Envelope

#### 5.3.1 Purpose

The **Action Envelope** is the canonical object approved by Signers. It:

* binds to exactly one Execution Payload by hash;
* identifies the Proposer;
* identifies the target Application;
* identifies the execution profile used to interpret the payload;
* carries replay and expiration data.

The Action Envelope is not the executable instruction. The Execution Payload tells the Application what to do. The Action Envelope tells Signers and Verifiers which Execution Payload is being approved, which Application it targets, and how it should be interpreted.

#### 5.3.2 Requirements

An Action Envelope MUST bind to exactly one Execution Payload using `executionPayloadHash`.
An Action Envelope MUST identify the Proposer by DID.
An Action Envelope MUST include `target.applicationDid`.
An Action Envelope MUST include `executionProfile.id`.
An Action Envelope MUST include an `actionId`.
An Action Envelope MUST include a `version` field.
An Action Envelope MUST include `createdAt`.
An Action Envelope MUST include `expiresAt`.
An Action Envelope SHOULD include `target.resource` when the affected resource can be identified.
An Action Envelope SHOULD include `executionProfile.format` when a profile supports multiple payload formats.
An Action Envelope MUST be canonicalizable and hashable.

#### 5.3.3 Fields

| Field                   | Required    | Description                                                                                                                                       |
| :---------------------- | :---------: | :------------------------------------------------------------------------------------------------------------------------------------------------ |
| version                 | Yes         | MUST be `"1"`.                                                                                                                                    |
| type                    | Yes         | MUST be `ActionEnvelope`.                                                                                                                         |
| proposer.did            | Yes         | DID identifying the Proposer.                                                                                                                     |
| target.applicationDid   | Yes         | DID identifying the target Application or execution authority. Used by Verifiers and Credential Adapters to locate trusted configuration.         |
| target.resource         | Recommended | Application-specific resource affected by the Action (repository, contract, account, endpoint, file, etc.).                                       |
| executionProfile.id     | Yes         | DID identifying the MPAS execution profile used to interpret the Execution Payload. The profile DID MAY resolve to a profile descriptor document. |
| executionProfile.format | Recommended | Specific payload format under the execution profile (e.g., `mcp.toolsCall`, `evm.transactionRequest`, `openapi.operation`, `http.request`).       |
| executionPayloadHash    | Yes         | Hash of the Execution Payload being approved, computed using the profile-defined hashing rules.                                                   |
| actionId.value          | Yes         | Identifier for the Action. MUST be globally unique unless `actionId.scope` is included.                                                           |
| actionId.scope          | Conditional | Required if `actionId.value` is not globally unique. Defines the replay domain.                                                                   |
| createdAt               | Yes         | Timestamp when the Action Envelope was created. MUST be an RFC 3339 / ISO 8601 UTC timestamp string.                                              |
| expiresAt               | Yes         | Timestamp after which the Action Envelope MUST NOT be accepted. MUST be an RFC 3339 / ISO 8601 UTC timestamp string.                              |

Profiles MAY define additional `target.*` fields specific to their execution domain (such as `target.chainId`, `target.namespace`, `target.region`, or `target.tenant`).

#### 5.3.4 Field Details

**target**

Identifies the Application and resource where the Action will have effect. The `target.applicationDid` is used by Verifiers and Credential Adapters to locate trusted Application configuration, determine supported operations, select credentials, and apply policy. For Credential Adapter deployments, `target.applicationDid` SHOULD identify the Application or credential domain for which the Verifier is authorized to act, not merely a generic upstream service name.

**executionProfile**

Identifies the MPAS execution profile used to interpret the Execution Payload. The `executionProfile.id` MUST be a DID. The profile DID MAY resolve to a profile descriptor document that defines payload format, hashing rules, validation rules, rendering metadata, and Credential Adapter mappings.

The `executionProfile.format` identifies the specific payload format when a profile supports multiple formats (e.g., an MCP profile might support both `mcp.toolsCall` and `mcp.resourceRead`).

**executionPayloadHash**

Binds the Action Envelope to the Execution Payload. The hash MUST be computed over the canonicalized Execution Payload or over another deterministic representation accepted by the Application or Verifier.

Recommended form:

```json
"executionPayloadHash": {"alg": "sha-256", "value": "base64url-encoded-digest"}
```

The Action Envelope MUST NOT be accepted if the supplied Execution Payload does not match `executionPayloadHash`.

**actionId**

Identifies the Action and supports replay protection. `actionId.value` MUST be unique either globally or within `actionId.scope`.

For target applications with no native nonce or idempotency concept, the `actionId` is the nonce MPAS supplies — two intentional submissions of identical payloads are distinguished by their Action Envelopes (each with a unique `actionId`).

A globally unique `actionId.value` SHOULD use a collision-resistant identifier format such as UUID URN, ULID URN, or DID-based URI.

Example globally unique actionId:

```json
"actionId": {"value": "urn:uuid:3f82f6e1-135e-44c5-90a9-58f760f6d9f1"}
```

Example scoped actionId:

```json
"actionId": {"scope": "eip155:1:0x1234567890abcdef1234567890abcdef12345678", "value": "42"}
```

The scope MUST identify the replay domain in which `actionId.value` is unique. A Verifier MUST reject an Action Package if `actionId.value` is not globally unique and `actionId.scope` is absent or insufficient to determine the replay domain. A Verifier MUST reject an Action Package with a scope format it does not recognize.

Scoped action IDs are needed when the value is not globally unique by construction (e.g., an incrementing nonce). The following table shows a non-normative example of a scope format; future execution profiles define scope semantics for their domain:

| Scope Format               | Replay Domain                                            | Example                  |
| :------------------------- | :------------------------------------------------------- | :----------------------- |
| CAIP-10 account identifier | EVM transaction nonces are unique per account per chain. | `eip155:1:0x1234...5678` |

Future profiles MAY define additional scope formats for other execution environments. When a globally unique identifier (UUID, ULID, etc.) is used as `actionId.value`, `actionId.scope` MAY be omitted.

**expiresAt**

Timestamp after which the Action Envelope MUST NOT be accepted. A Verifier MUST reject an Action Package whose Action Envelope is expired under the Verifier's timestamp validation policy.

#### 5.3.5 Generic Form

```json
{
  "version": "1",
  "type": "ActionEnvelope",
  "proposer": {
    "did": "did:web:agent.example.com"
  },
  "target": {
    "applicationDid": "did:web:github-mcp.example",
    "resource": "repo:oma3dao/app-registry"
  },
  "executionProfile": {
    "id": "did:web:profiles.oma3.org:mcp",
    "format": "mcp.toolsCall"
  },
  "executionPayloadHash": {
    "alg": "sha-256",
    "value": "base64url-encoded-digest"
  },
  "actionId": {
    "value": "urn:uuid:3f82f6e1-135e-44c5-90a9-58f760f6d9f1"
  },
  "createdAt": "2026-05-27T18:00:00.000Z",
  "expiresAt": "2026-05-27T19:00:00.000Z"
}
```

#### 5.3.6 Proposer Signature

The Proposer MAY sign the Action Envelope. If the Proposer signature is included, it SHOULD be represented as an Approval with decision set to `propose`. The Proposer signature does not by itself mean the Action is authorized unless the Verifier's policy treats the Proposer as sufficient authority for that Action.

#### 5.3.7 Timestamp Validation

The Verifier's trusted time source is authoritative for final timestamp validation.

A Verifier MUST define a timestamp validation policy, including any accepted clock-skew or timestamp-tolerance allowance.

A Verifier MUST reject an Action Package if the Action Envelope is expired under that policy.

Signature Approvals MUST include `createdAt`.

If an Approval has no `expiresAt`, it inherits `actionEnvelope.expiresAt`.

A Verifier MUST reject or ignore an Approval whose `createdAt` is after `actionEnvelope.expiresAt`, subject to the Verifier's timestamp validation policy.

A Verifier SHOULD reject or ignore an Approval whose `createdAt` is before `actionEnvelope.createdAt`, unless a profile or deployment policy explicitly permits otherwise.

If an implementation cannot obtain trustworthy time, it SHOULD fail closed or return `policyUnavailable`.

A Verifier MAY impose a maximum acceptable validity window shorter than `actionEnvelope.expiresAt`. A Verifier that imposes a shorter window MUST reject Action Packages whose remaining validity exceeds its maximum, or treat the Action Envelope as expired after its own imposed deadline.

#### 5.3.8 Replay Protection

Replay protection for `actionId` is governed by the Action Lifecycle defined in Section 6.9. The Verifier's lifecycle state for an `actionId` determines whether a submission is accepted, re-verified, deduplicated, or rejected.

A Verifier MUST retain replay state for a used `actionId` at least until `actionEnvelope.expiresAt` plus the deployment's timestamp tolerance.

Replay protection is scoped to the Verifier's own replay domain. Shared replay state across independent Verifiers is not defined in this specification.

### 5.4 Signer Review Set

#### 5.4.1 Purpose

The **Signer Review Set** is the information provided to a Signer to allow review of a proposed Action. It is not the object delivered to the Verifier for execution. It is not an authorization artifact. It is a review package that allows a Signer to inspect the Execution Payload and Action Envelope before producing an Approval.

#### 5.4.2 Requirements

A Signer Review Set MUST include the Execution Payload.
A Signer Review Set MUST include the Action Envelope.
A Signer Review Set MUST include a `version` field.
A Signer Review Set MAY include Authorization Requirements for signer context.

Signers SHOULD understand or obtain rendering support for the declared `actionEnvelope.executionProfile` before approving. If the Signer cannot interpret or display the profile-native Execution Payload in a meaningful way, it SHOULD reject or abstain, or require an external trusted renderer.

#### 5.4.3 Fields

| Field                     | Required | Description                                                                        |
| :------------------------ | :------: | :--------------------------------------------------------------------------------- |
| version                   | Yes      | MUST be `"1"`.                                                                     |
| type                      | Yes      | MUST be `SignerReviewSet`.                                                         |
| executionPayload          | Yes      | The profile-native Execution Payload the Signer is being asked to review.          |
| actionEnvelope            | Yes      | The Action Envelope the Signer is being asked to approve, reject, or abstain from. |
| authorizationRequirements | Optional | Verifier-provided requirements included for signer context only.                   |
| createdAt                 | Optional | Timestamp when the Signer Review Set was assembled.                                |
| expiresAt                 | Optional | Timestamp after which the review request is no longer valid.                       |

#### 5.4.4 Signer Review

Before producing an Approval, a Signer SHOULD:

* verify the Execution Payload hash equals `actionEnvelope.executionPayloadHash` using the profile-defined hashing rules;
* verify the Action Envelope is well formed and has not expired;
* review `actionEnvelope.target`, `actionEnvelope.executionProfile`, `actionEnvelope.actionId`, Proposer DID, and expiration;
* review the profile-native Execution Payload using the declared execution profile;
* verify that any displayed rendering is derived from the Execution Payload, Action Envelope, and trusted profile or Application metadata, not from untrusted free-form context.

A Signer MUST NOT approve an Action Envelope if the Execution Payload is missing, unavailable, or cannot be verified against the Action Envelope.

#### 5.4.5 Generic Form

```json
{
  "version": "1",
  "type": "SignerReviewSet",
  "executionPayload": {
    "name": "merge_pull_request",
    "arguments": {
      "owner": "oma3dao",
      "repo": "app-registry",
      "pullNumber": 42,
      "baseRef": "main",
      "expectedHeadSha": "abc123",
      "mergeMethod": "squash"
    }
  },
  "actionEnvelope": {
    "version": "1",
    "type": "ActionEnvelope",
    "proposer": {
      "did": "did:web:agent.example.com"
    },
    "target": {
      "applicationDid": "did:web:github-mcp.example",
      "resource": "repo:oma3dao/app-registry"
    },
    "executionProfile": {
      "id": "did:web:profiles.oma3.org:mcp",
      "format": "mcp.toolsCall"
    },
    "executionPayloadHash": {
      "alg": "sha-256",
      "value": "base64url-encoded-digest"
    },
    "actionId": {
      "value": "urn:uuid:3f82f6e1-135e-44c5-90a9-58f760f6d9f1"
    },
    "createdAt": "2026-05-27T18:00:00.000Z",
    "expiresAt": "2026-05-27T19:00:00.000Z"
  }
}
```

### 5.5 Approval

#### 5.5.1 Purpose

An **Approval** is a signed artifact showing that a Signer approved, rejected, or otherwise contributed to authorization of an Action Envelope. An Approval does not by itself mean the Action is authorized. The Verifier determines whether the Approval, together with any other Approvals in the Approval Bundle, satisfies the applicable policy.

#### 5.5.2 Requirements

An Approval MUST reference the Action Envelope it applies to.
An Approval MUST identify the Signer.
An Approval MUST identify the Signer's decision or authorization contribution.
An Approval MUST include a `version` field.
An Approval MUST include a `signature` object.
An Approval MUST be verifiable by the Verifier according to the applicable signature format and trust configuration.

#### 5.5.3 Fields

| Field              | Required    | Description                                                                                                      |
| :----------------- | :---------: | :--------------------------------------------------------------------------------------------------------------- |
| version            | Yes         | MUST be `"1"`.                                                                                                   |
| type               | Yes         | MUST be `Approval`.                                                                                              |
| actionEnvelopeHash | Yes         | Hash of the Action Envelope.                                                                                     |
| decision           | Yes         | Decision or authorization contribution.                                                                          |
| signature          | Yes         | Signature object. See Section 5.5.5.                                                                             |
| createdAt          | Conditional | Timestamp when the Approval was created. REQUIRED for Signature Approvals.                                       |
| expiresAt          | Optional    | Timestamp after which the Approval should no longer be accepted. If absent, inherits `actionEnvelope.expiresAt`. |

#### 5.5.4 Decision Values

| Decision | Meaning                                                                                                                                                                                                       |
| :------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| propose  | The Signer created or proposed the Action.                                                                                                                                                                    |
| approve  | The Signer approves the Action Envelope.                                                                                                                                                                      |
| reject   | The Signer rejects the Action Envelope. Reject decisions are workflow and audit evidence. They MUST NOT be used as blocking policy unless obtained from a trusted non-censorable source defined outside Core. |
| abstain  | The Signer participated in review but takes no affirmative or negative position.                                                                                                                              |

A Verifier MAY define additional decision values for application-specific policies.

#### 5.5.5 Signature Approvals

A Signature Approval contains a `signature` object that binds the Signer's decision to an Action Envelope using a cryptographic signature. All Signature Approvals MUST bind to a Canonical Approval Payload.

The Canonical Approval Payload defines the abstract data that the Signer approved, rejected, proposed, or abstained from. Future signature profiles MAY encode the Canonical Approval Payload differently, but all formats MUST preserve the same core semantics.

MPAS supports at least the following signature formats:

* `jws`

Additional signature formats MAY be defined by future profiles or specifications (see Section 10).

##### 5.5.5.1 Canonical Approval Payload

The Canonical Approval Payload is the signed payload for a Signature Approval. A Verifier MUST reject a Signature Approval if the signed Canonical Approval Payload does not bind to the same `actionEnvelopeHash` and `decision` as the top-level Approval fields.

| Field                | Required    | Description                                                                                                                                                  |
| :------------------- | :---------: | :----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`               | Yes         | MUST be `ApprovalPayload`.                                                                                                                                   |
| `actionEnvelopeHash` | Yes         | Hash of the Action Envelope.                                                                                                                                 |
| `decision`           | Yes         | Decision value.                                                                                                                                              |
| `signerDid`          | Conditional | DID of the Signer. REQUIRED when policy evaluates signer identity by DID. MAY be omitted when the signature format directly identifies the Signer authority. |
| `createdAt`          | Yes         | Timestamp when the Approval was created. MUST be an RFC 3339 / ISO 8601 UTC timestamp string.                                                                |
| `expiresAt`          | Optional    | Timestamp after which the Approval should no longer be accepted.                                                                                             |

##### 5.5.5.2 Signature Object Fields

| Field  | Required | Description                       |
| :----- | :------: | :-------------------------------- |
| format | Yes      | Signature format. MUST be `jws`.  |
| value  | Yes      | JWS Compact Serialization string. |

#### 5.5.6 JWS Signature Approval

For `signature.format` = `"jws"`:

* `signature.value` MUST contain a JWS Compact Serialization string.
* `signature.payload` MUST be omitted (the JWS already contains the payload).
* The JWS payload MUST be the JCS-canonicalized (RFC 8785) Canonical Approval Payload, encoded as the JWS payload per RFC 7515 Section 3 (base64url without padding).
* The JWS header MUST contain `alg`.
* The JWS header MUST contain `kid`.
* The `alg` value MUST NOT be `none`. A Verifier MUST reject any JWS with `alg: none`.
* A Verifier MUST reject any JWS whose `alg` value is not in the Verifier's permitted algorithm set.
* EdDSA MUST be supported by conforming JWS implementations (mandatory-to-implement). ES256 and ES256K are RECOMMENDED.
* The `kid` SHOULD be a DID URL identifying the signing key.
* The JWS header MAY contain `jwk` for offline or durable verification. However, an embedded `jwk` MUST NOT by itself establish signer authority. An embedded `jwk` MAY assist verification only if the key is independently authorized by DID resolution, trusted key binding, OMATrust, local configuration, or another verifier-trusted identity/key authorization mechanism.
* A Verifier MUST reject a Signature Approval if the signing key is not authorized for the signer DID or approval role under trusted policy/configuration.

The top-level `actionEnvelopeHash` and `decision` fields are convenience fields for indexing and bundle assembly. The signed JWS payload is authoritative. The Verifier MUST reject the Approval if the top-level fields differ from the signed payload.

Example:

```json
{
  "version": "1",
  "type": "Approval",
  "actionEnvelopeHash": {
    "alg": "sha-256",
    "value": "base64url-encoded-digest"
  },
  "decision": "approve",
  "signature": {
    "format": "jws",
    "value": "eyJhbGciOiJFZERTQSIsImtpZCI6ImRpZDp3ZWI6YWxpY2UuZXhhbXBsZSNrZXktMSJ9.eyJ0eXBlIjoiQXBwcm92YWxQYXlsb2FkIiwiYWN0aW9uRW52ZWxvcGVIYXNoIjp7ImFsZyI6InNoYS0yNTYiLCJ2YWx1ZSI6ImJhc2U2NHVybC1lbmNvZGVkLWRpZ2VzdCJ9LCJkZWNpc2lvbiI6ImFwcHJvdmUiLCJzaWduZXJEaWQiOiJkaWQ6d2ViOmFsaWNlLmV4YW1wbGUiLCJjcmVhdGVkQXQiOiIyMDI2LTA1LTI3VDE4OjEwOjAwWiJ9.signature"
  },
  "createdAt": "2026-05-27T18:10:00.000Z"
}
```

#### 5.5.7 Verification Notes

A Verifier MUST reject an Approval if:

* the top-level `actionEnvelopeHash` does not match the signed Action Envelope hash;
* the top-level `decision` does not match the signed decision;
* the signature cannot be verified;
* the signing key is not authorized for the Signer or approval role claimed;
* the Approval has expired;
* the Approval does not satisfy the Verifier's applicable policy.

### 5.6 Approval Bundle

#### 5.6.1 Purpose

The **Approval Bundle** is an object containing Approvals and related metadata for an Action Envelope. It may be assembled by the Proposer, a Coordination Service, an Application, a Credential Adapter, or another participant. The existence of an Approval Bundle does not mean the Action is authorized. The Verifier determines whether the Approval Bundle satisfies the applicable policy.

#### 5.6.2 Requirements

An Approval Bundle MUST reference the Action Envelope it relates to.
An Approval Bundle MUST contain an `approvals` array.
An Approval Bundle MUST contain at least the Proposer's Approval.
An Approval Bundle MUST include a `version` field.
Each Approval in the `approvals` array MUST bind to the same Action Envelope as the Approval Bundle.

#### 5.6.3 Fields

| Field              | Required    | Description                                                               |
| :----------------- | :---------: | :------------------------------------------------------------------------ |
| version            | Yes         | MUST be `"1"`.                                                            |
| type               | Yes         | MUST be `ApprovalBundle`.                                                 |
| actionEnvelopeHash | Yes         | Hash of the Action Envelope.                                              |
| approvals          | Yes         | Array of Approval objects. MUST contain at least the Proposer's Approval. |
| assembledBy        | Optional    | DID of the actor that assembled the Approval Bundle.                      |
| createdAt          | Recommended | Timestamp when the Approval Bundle was created.                           |

#### 5.6.4 Verification Notes

A Verifier MUST reject an Approval Bundle if:

* `actionEnvelopeHash` does not match the hash of the Action Envelope in the Action Package;
* any Approval in the bundle binds to a different Action Envelope;
* any Approval required by policy cannot be verified;
* the bundle omits Approvals required by policy;
* the bundle includes conflicting or disqualifying Approvals under the applicable policy.

### 5.7 Action Package

#### 5.7.1 Purpose

The **Action Package** is the portable package delivered to a Verifier. The Verifier uses the Action Package to determine whether the Action satisfies applicable policy and may be executed by the Application.

#### 5.7.2 Requirements

* An Action Package MUST include the Execution Payload.
* An Action Package MUST include the Action Envelope.
* An Action Package MUST include an Approval Bundle containing at least the Proposer's Approval.
* An Action Package MUST include a `version` field.
* An Action Package MUST preserve the Execution Payload, Action Envelope, and Approval Bundle without altering their verification semantics.

#### 5.7.3 Fields

| Field            | Required    | Description                                                      |
| :--------------- | :---------: | :--------------------------------------------------------------- |
| version          | Yes         | MUST be `"1"`.                                                   |
| type             | Yes         | MUST be `ActionPackage`.                                         |
| executionPayload | Yes         | The profile-native Execution Payload.                            |
| actionEnvelope   | Yes         | The Action Envelope that binds to the Execution Payload by hash. |
| approvalBundle   | Yes         | Approval Bundle containing at least the Proposer's Approval.     |
| createdAt        | Recommended | Timestamp when the Action Package was created.                   |

#### 5.7.4 Generic Form

```json
{
  "version": "1",
  "type": "ActionPackage",
  "executionPayload": {
    "name": "merge_pull_request",
    "arguments": {
      "owner": "oma3dao",
      "repo": "app-registry",
      "pullNumber": 42,
      "baseRef": "main",
      "expectedHeadSha": "abc123",
      "mergeMethod": "squash"
    }
  },
  "actionEnvelope": {
    "version": "1",
    "type": "ActionEnvelope",
    "proposer": {
      "did": "did:web:agent.example.com"
    },
    "target": {
      "applicationDid": "did:web:github-mcp.example",
      "resource": "repo:oma3dao/app-registry"
    },
    "executionProfile": {
      "id": "did:web:profiles.oma3.org:mcp",
      "format": "mcp.toolsCall"
    },
    "executionPayloadHash": {
      "alg": "sha-256",
      "value": "base64url-encoded-digest"
    },
    "actionId": {
      "value": "urn:uuid:3f82f6e1-135e-44c5-90a9-58f760f6d9f1"
    },
    "createdAt": "2026-05-27T18:00:00.000Z",
    "expiresAt": "2026-05-27T19:00:00.000Z"
  },
  "approvalBundle": {
    "version": "1",
    "type": "ApprovalBundle",
    "actionEnvelopeHash": {
      "alg": "sha-256",
      "value": "base64url-encoded-digest"
    },
    "approvals": [
      {
        "version": "1",
        "type": "Approval",
        "actionEnvelopeHash": {
          "alg": "sha-256",
          "value": "base64url-encoded-digest"
        },
        "decision": "approve",
        "signature": {
          "format": "jws",
          "value": "jws-compact-serialization"
        },
        "createdAt": "2026-05-27T18:10:00.000Z"
      }
    ],
    "createdAt": "2026-05-27T18:20:00.000Z"
  },
  "createdAt": "2026-05-27T18:25:00.000Z"
}
```

#### 5.7.5 Verification Notes

A Verifier MUST reject an Action Package if:

* the Execution Payload does not match the hash in the Action Envelope;
* the Approval Bundle does not reference the same Action Envelope;
* any Approval in the Approval Bundle binds to a different Action Envelope;
* the Action Envelope is expired under the Verifier's timestamp validation policy;
* the Action ID violates the replay rules defined in the Action Lifecycle (Section 6.9);
* the Execution Payload, Action Envelope, or Approval Bundle does not satisfy applicable policy.

### 5.8 Authorization Requirements

#### 5.8.1 Purpose

**Authorization Requirements** describe what additional approvals or authorization conditions are needed for a proposed Action to be accepted by the Verifier. They are typically returned by a Verifier after receiving an Action Package that is not yet authorized. They help the Proposer understand which Approvals to collect before resubmitting.

Authorization Requirements are not a guarantee of future execution. A Verifier MAY reject a later Action Package even if the Proposer collected the Approvals described in earlier Authorization Requirements. Reasons include:

* policy changed;
* Action Envelope expired;
* the `actionId` is already in the Verifier's dispatch ledger (Section 6.9);
* Execution Payload or Action Envelope changed;
* required Signer authority or eligible Signer set changed;
* Verifier no longer recognizes the Application or operation;
* credential or Application configuration changed.

#### 5.8.2 Requirements

An Authorization Requirements object MUST bind to the Action Envelope it applies to using `actionEnvelopeHash`.
An Authorization Requirements object MUST identify the Verifier that returned it.
An Authorization Requirements object MUST include a result status.
An Authorization Requirements object MUST include a `version` field.
An Authorization Requirements object SHOULD include approval requirements when additional approvals can satisfy policy.
An Authorization Requirements object MAY include a policy reference.
An Authorization Requirements object SHOULD include expiration.

If a Verifier cannot compute `actionEnvelopeHash` because the Action Envelope is missing, malformed, or not canonicalizable, the Verifier SHOULD return a response with result `malformed` rather than an Authorization Requirements object.

#### 5.8.3 Fields

| Field                | Required    | Description                                                                                            |
| :------------------- | :---------: | :----------------------------------------------------------------------------------------------------- |
| version              | Yes         | MUST be `"1"`.                                                                                         |
| type                 | Yes         | MUST be `AuthorizationRequirements`.                                                                   |
| actionEnvelopeHash   | Yes         | Hash of the Action Envelope to which the requirements apply. This is the sole normative binding field. |
| result               | Yes         | Verifier response status.                                                                              |
| verifier.did         | Yes         | DID of the Verifier returning the requirements.                                                        |
| approvalRequirements | Conditional | Required when `result` is `additionalApprovalsRequired`.                                               |
| policyRef            | Optional    | Non-authoritative reference to the Verifier's policy.                                                  |
| createdAt            | Recommended | Timestamp when the requirements were created.                                                          |
| expiresAt            | Recommended | Timestamp after which the requirements should no longer be relied on.                                  |

#### 5.8.4 Result Values

| Value                       | Meaning                                                                                   |
| :-------------------------- | :---------------------------------------------------------------------------------------- |
| additionalApprovalsRequired | The request may be authorized if the Proposer collects the required Approvals.            |
| rejected                    | The request is rejected and cannot be satisfied by collecting additional Approvals.       |
| notSupported                | The Verifier does not support the requested Application, operation, or verification mode. |
| malformed                   | The request is structurally invalid.                                                      |
| policyUnavailable           | The Verifier cannot determine applicable policy at this time.                             |

#### 5.8.5 Approval Requirements Object

The `approvalRequirements` object describes approval paths that may satisfy policy.

| Field           | Required    | Description                                                                                  |
| :-------------- | :---------: | :------------------------------------------------------------------------------------------- |
| anyOf           | Recommended | Array of alternative approval paths. If any path is satisfied, the Action may be authorized. |
| allOf           | Optional    | Array of approval paths that must all be satisfied.                                          |
| overrideSigners | Optional    | Signers with privileged authority to approve or reject outside ordinary threshold paths.     |

At least one of `anyOf`, `allOf`, or `overrideSigners` SHOULD be present when result is `additionalApprovalsRequired`.

#### 5.8.6 Threshold Requirement

| Field           | Required | Description                                                           |
| :-------------- | :------: | :-------------------------------------------------------------------- |
| type            | Yes      | MUST be `threshold`.                                                  |
| threshold       | Yes      | Number of eligible Signer Approvals required.                         |
| eligibleSigners | Yes      | Array of Signer DIDs eligible to satisfy this requirement.            |
| decision        | Optional | Decision value that satisfies the requirement. Defaults to `approve`. |
| description     | Optional | Human-readable explanation of the requirement.                        |

Example:

```json
{
  "type": "threshold",
  "threshold": 2,
  "eligibleSigners": [
    "did:web:alice.example.com",
    "did:web:bob.example.com",
    "did:web:carol.example.com"
  ],
  "decision": "approve",
  "description": "Requires approval from at least 2 maintainers."
}
```

#### 5.8.7 Override Signers

Override signers are Signers with privileged authority under the Verifier's policy to unilaterally satisfy authorization requirements.

| Field       | Required | Description                                           |
| :---------- | :------: | :---------------------------------------------------- |
| signer      | Yes      | DID of the override Signer.                           |
| permissions | Yes      | Array of override permissions (e.g., `approve`).      |
| description | Optional | Human-readable explanation of the override authority. |

### 5.9 Execution Receipt

#### 5.9.1 Purpose

An **Execution Receipt** is a signed statement by an MPAS-aware component that an Action was executed, rejected, failed, indeterminate, expired, cancelled, revoked, or otherwise resolved. It supports auditability, incident analysis, troubleshooting, coordination, and later verification that a particular Action reached a particular outcome.

#### 5.9.2 Requirements

An Execution Receipt MUST be signed by the MPAS-aware component issuing the receipt.
The receipt issuer MUST be identified by DID.
The receipt signature MUST identify the signing key.
The signing key MUST be authorized to issue receipts for the issuer DID (see Section 7.8).
The receipt payload MUST bind to the Action Envelope being resolved.
The receipt payload MUST bind to the Execution Payload being resolved.
The receipt payload MUST identify the result of the Action.
The receipt payload MUST include the time the receipt was issued.

#### 5.9.3 Execution Receipt Object Fields

| Field     | Required | Description                       |
| :-------- | :------: | :-------------------------------- |
| version   | Yes      | MUST be `"1"`.                    |
| type      | Yes      | MUST be `ExecutionReceipt`.       |
| format    | Yes      | Signature format. MUST be `jws`.  |
| signature | Yes      | JWS Compact Serialization string. |

#### 5.9.4 Receipt Payload Fields

| Field                | Required    | Description                                   |
| :------------------- | :---------: | :-------------------------------------------- |
| issuerDid            | Yes         | DID of the component issuing the receipt.     |
| actionEnvelopeHash   | Yes         | Hash of the Action Envelope being resolved.   |
| executionPayloadHash | Yes         | Hash of the Execution Payload being resolved. |
| actionId             | Recommended | Action ID from the Action Envelope.           |
| proposerDid          | Recommended | DID of the Proposer.                          |
| result               | Yes         | Resolution result.                            |
| issuedAt             | Yes         | Timestamp when the receipt was issued.        |
| executionRef         | Optional    | Application-specific execution reference.     |

#### 5.9.5 Result Values

| Result        | Meaning                                                                               |
| :------------ | :------------------------------------------------------------------------------------ |
| executed      | The Action was executed successfully.                                                 |
| rejected      | The Action was rejected.                                                              |
| failed        | Execution was attempted but failed definitively.                                      |
| indeterminate | Execution was dispatched but the outcome could not be confirmed.                      |
| expired       | The Action expired before execution.                                                  |
| cancelled     | The Action was cancelled before execution.                                            |
| revoked       | Authorization was revoked before execution.                                           |

`indeterminate` indicates that dispatch was attempted but the outcome could not be confirmed (timeout, crash, transport failure after send). Callers MUST NOT assume the action did not execute and MUST NOT automatically retry with the same `actionId`. Re-attempting requires a NEW Action Envelope with a new `actionId` and fresh approvals after out-of-band reconciliation.

A Verifier or Application MAY define additional result values.

#### 5.9.6 Signature Format

**JWS Receipts:**

* `signature` MUST contain a JWS Compact Serialization string.
* `payload` MUST be omitted.
* The JWS payload MUST be the JCS-canonicalized (RFC 8785) Receipt Payload, encoded as the JWS payload per RFC 7515 Section 3 (base64url without padding).
* The JWS header MUST contain `alg` and `kid`.
* The `kid` SHOULD be a DID URL identifying the receipt signing key.
* JWS Execution Receipts MUST follow the algorithm and key authorization requirements in Section 5.5.6.

#### 5.9.7 Verification Notes

A verifier of an Execution Receipt MUST reject the receipt if:

* the receipt signature cannot be verified;
* the receipt signing key is not authorized for `issuerDid`;
* the receipt payload is missing required fields;
* the receipt payload does not bind to the expected Action Envelope or Execution Payload;
* the receipt result is unsupported or invalid.

#### 5.9.8 Audit Logs

Components MAY emit audit log events for lifecycle activity. This version defines only Execution Receipts as a core data structure. Future versions will formalize additional audit log events.

## 6. Protocol and Processing Rules

This section defines how MPAS data structures are created, transmitted, processed, verified, and resolved during an MPAS workflow. MPAS is transport-neutral. The same data structures may be exchanged through direct API calls, peer-to-peer messages, shared communication channels, Coordination Services, enterprise workflow systems, local IPC, smart contracts, or manual transfer.

The core MPAS protocol proceeds through the following phases:

1. Initial Action Package Construction and Submission
2. Verifier Evaluation and Response
3. Signer Review Set Distribution
4. Signer Review and Approval Response
5. Approval Bundle Assembly and Completed Action Package Submission
6. Credential Adapter Processing (when applicable)
7. Resolution and Execution Receipt

### 6.1 Phase 1: Initial Action Package Construction and Submission

#### 6.1.1 Purpose

The Proposer constructs an initial Action Package and submits it to the Verifier. For low-value Actions, the Proposer's own Approval may be sufficient for authorization and the initial Action Package may proceed directly to execution. For higher-value Actions, the Verifier may determine that additional Approvals are required and return Authorization Requirements.

#### 6.1.2 Proposer Responsibilities

The Proposer MUST:

* Construct or obtain a profile-native Execution Payload.
* Construct an Action Envelope that identifies the target Application (`target.applicationDid`), execution profile (`executionProfile.id`), and optionally the target resource.
* Compute `executionPayloadHash` using the profile-defined hashing rules.
* Include a globally unique or scoped `actionId`.
* Include `createdAt` and `expiresAt` timestamps.
* Create an Approval for the Action Envelope with decision `propose` or `approve`.
* Construct an Approval Bundle containing at least the Proposer's Approval.
* Construct an Action Package containing the Execution Payload, Action Envelope, and Approval Bundle.

#### 6.1.3 Submission to Verifier

The Proposer MUST submit the initial Action Package to the Verifier selected for the target Application or deployment. The submission transport is deployment-specific (HTTP API, local IPC, smart contract call, etc.). Regardless of transport, the Verifier MUST receive the complete Action Package.

### 6.2 Phase 2: Verifier Evaluation and Response

#### 6.2.1 Purpose

The Verifier evaluates the Action Package and determines whether it satisfies applicable policy, requires additional Approvals, or should be rejected.

#### 6.2.2 Verifier Evaluation Procedure

The Verifier MUST evaluate the Action Package using a deterministic verification procedure. The Verifier MUST NOT rely on Proposer-supplied policy fields, unsigned metadata, channel identity, or Coordination Service routing metadata as authoritative policy.

**Step 1: Parse the Action Package**

Confirm it contains `executionPayload`, `actionEnvelope`, and `approvalBundle`. Reject as malformed if any required object is missing or not well formed.

**Step 2: Validate the Action Envelope**

Confirm the Action Envelope is well formed, canonicalizable, contains a valid Proposer DID, valid `actionId`, `target.applicationDid`, `executionProfile.id`, `createdAt`, and `expiresAt`. Reject the Action Package if the Action Envelope is expired under the Verifier's timestamp validation policy. Reject if `expiresAt` minus the current time exceeds the Verifier's maximum envelope validity window. Confirm the Verifier supports or can resolve the declared `target.applicationDid` and `executionProfile`. Confirm the Verifier is authorized under trusted local configuration to act for the declared `target.applicationDid` and `executionProfile`.

**Step 2a: Dispatch Ledger Check**

Compute the Action Envelope hash and consult the dispatch ledger (Section 6.9):

- If the `actionId` is **not in the ledger**: proceed with full stateless verification.
- If the `actionId` is in the ledger with a **different** envelope hash: MUST reject.
- If the `actionId` is in the ledger as **executing** with the same hash: MUST NOT transmit again; respond `pending`.
- If the `actionId` is in the ledger as **resolved**: MUST reject as replay (any hash).

The ledger entry itself is written later — only when the action is authorized for dispatch (Section 6.9.2), immediately before transmission.

**Step 3: Verify Execution Payload Binding**

Compute the hash of the Execution Payload using the hashing rules defined by the declared execution profile. Confirm it equals `actionEnvelope.executionPayloadHash`. This ensures Signers approved an Action Envelope bound to the same Execution Payload submitted for verification.

**Step 4: Validate the Execution Payload Under the Declared Profile**

Use trusted Application configuration, execution profile rules, or Application Profile data to validate the payload structure. Determine the profile-specific operation, command, or transaction being requested. For MCP, this means validating the tool name and arguments. For other profiles, this means validating the profile-native command format.

**Step 5: Compute the Action Envelope Hash**

Compute the hash of the Action Envelope using JCS canonicalization and the applicable hash algorithm. This hash is used to verify the Approval Bundle.

**Step 6: Validate Approval Bundle Structure**

Confirm that the Approval Bundle is well formed, `approvalBundle.actionEnvelopeHash` matches the computed Action Envelope hash, the bundle contains at least the Proposer's Approval, and every Approval references the computed Action Envelope hash.

**Step 7: Determine Applicable Policy**

Policy determination SHOULD consider: `actionEnvelope.target.applicationDid`, `target.resource`, `executionProfile`, profile-derived operation or command identity, profile-derived parameters, Proposer DID, Action ID, expiration, and deployment configuration.

**Step 8: Select Candidate Approvals**

Select the Approvals that could affect policy evaluation. Candidate selection using unsigned metadata MUST NOT be treated as proof that an Approval is valid.

**Step 9: Verify Candidate Approvals**

Verify each candidate Approval needed to satisfy, block, or override policy. Verify the signature, confirm the signed payload binds to the computed Action Envelope hash, confirm the signing key is authorized for the claimed Signer identity (see Section 7.8), and confirm the Approval's `createdAt` is within the acceptable temporal window relative to the Action Envelope.

**Step 10: Evaluate Policy and Produce Response**

Evaluate the Action Package against current policy using only verified Approvals. A deterministic policy rule that blocks the requested action type or matching action parameters MUST produce `rejected` immediately; collecting additional ordinary Approvals cannot satisfy such a rule. Produce one of the response types defined below.

#### 6.2.3 Verifier Response Types

| Response                    | Meaning                                                                                                     |
| :-------------------------- | :---------------------------------------------------------------------------------------------------------- |
| proceed to execution        | The Action Package satisfies current policy. The Verifier transitions to `executing` and dispatches.        |
| additionalApprovalsRequired | The Action Package does not yet satisfy policy but may be authorized if additional Approvals are collected. |
| rejected                    | The Action Package is rejected.                                                                             |
| notSupported                | The Verifier does not support the requested Application, operation, or verification mode.                   |
| malformed                   | The Action Package is structurally invalid.                                                                 |
| policyUnavailable           | The Verifier cannot determine applicable policy at this time.                                               |

When the response is `additionalApprovalsRequired`, the Verifier SHOULD return an Authorization Requirements object. A rejected action MUST NOT include Authorization Requirements and MUST NOT be dispatched. When policy is satisfied, the Verifier transitions the action to `executing` per Section 6.9 and begins dispatch. When the response resolves the Action, the Verifier or MPAS-aware component SHOULD issue an Execution Receipt.

### 6.3 Phase 3: Signer Review Set Distribution

When the Verifier returns Authorization Requirements indicating additional Approvals are needed, the Proposer or coordinating participant sends the Signer Review Set to eligible Signers.

The Proposer or coordinating participant SHOULD identify the Signers who may satisfy the Authorization Requirements and send the Signer Review Set to eligible Signers or make it available through a coordination method where eligible Signers monitor for review requests.

The Proposer SHOULD avoid distributing more sensitive information than necessary for Signer review. If Authorization Requirements or the Action Envelope expire before sufficient Approvals are collected, the Proposer SHOULD request updated requirements or restart the protocol.

### 6.4 Phase 4: Signer Review and Approval Response

#### 6.4.1 Purpose

A Signer receives a Signer Review Set, evaluates the proposed Action, and decides whether to produce an Approval.

#### 6.4.2 Signer Review Procedure

**Step 1:** Parse the Signer Review Set and confirm it contains `executionPayload` and `actionEnvelope`. If either is missing or malformed, the Signer SHOULD reject or abstain.

**Step 2:** Compute the hash of the Execution Payload using the profile-defined hashing rules and confirm it equals `actionEnvelope.executionPayloadHash`. If it does not match, the Signer MUST NOT approve.

**Step 3:** Inspect the Action Envelope and Execution Payload. The Signer SHOULD display:

* target Application DID;
* target resource and any profile-specific target fields;
* execution profile;
* profile-derived operation/tool/command identity;
* profile-derived parameters or command fields;
* Proposer DID;
* Action ID;
* expiration;
* relevant context.

The Signer SHOULD use trusted execution profile rendering information when available.

**Step 4:** Evaluate whether the proposed Action should be approved, considering context, supporting materials, operational state, and the Signer's authority.

**Step 5:** Decide response. The Signer SHOULD produce an Approval only if the Execution Payload and Action Envelope are valid, matching, understandable under the declared execution profile, and within the Signer's authority.

#### 6.4.3 Human Display Requirements

A human Signer SHOULD be shown the actual Execution Payload and Action Envelope, or a structured display of their fields, before approving. Human-readable rendering MUST NOT replace access to the underlying data. The Signer SHOULD NOT ask a human to approve based only on free-form text from the Proposer or an untrusted communication channel.

#### 6.4.4 Approval Creation

The Signer MUST create an Approval object as defined in Section 5.5. The Approval MUST bind to the computed Action Envelope hash. The Signer MUST sign using the applicable signature format.

#### 6.4.5 Approval Return

The Signer SHOULD return the Approval to the participant, channel, or system from which the Signer Review Set was received, unless coordination metadata specifies another return path.

### 6.5 Phase 5: Approval Bundle Assembly and Completed Action Package Submission

The Proposer assembles collected Approvals into an updated Approval Bundle and submits a completed Action Package to the Verifier. The completed Action Package uses the same structure as the initial Action Package. The Proposer MUST NOT modify Approval objects received from Signers.

The Proposer is always responsible for submitting the completed Action Package to the Verifier, even when a Coordination Service was used to collect Approvals. The Proposer MAY fetch collected Approvals from a Coordination Service, assemble the Approval Bundle, and re-submit directly to the Verifier.

### 6.6 Credential Adapter Processing

#### 6.6.1 Purpose

Credential Adapter processing applies when the Verifier is part of a Credential Adapter and the target Application does not natively understand MPAS artifacts.

#### 6.6.2 Processing Requirements

A Credential Adapter MUST NOT use credentials or submit commands to the target Application unless the Action Package has been authorized by the Verifier. If authorized, the Credential Adapter MUST:

* Look up trusted configuration using `actionEnvelope.target.applicationDid`.
* Validate that the declared `executionProfile` is allowed for the `target.applicationDid` under trusted configuration.
* Interpret the Execution Payload using `actionEnvelope.executionProfile` and trusted Application configuration.
* Validate the profile-native payload before execution.
* Construct the application-native command from the verified Execution Payload and trusted configuration.
* Generate transport-specific correlation IDs, request IDs, JSON-RPC IDs, or similar fields at execution time (unless those fields are part of the hash-bound profile-defined payload).
* Select credentials from trusted Credential Adapter configuration, not from Execution Payload fields, Action Envelope context, Proposer input, or coordination metadata.
* Return or publish an Execution Receipt.

If the Credential Adapter cannot safely interpret the Execution Payload under the declared execution profile and trusted Application configuration, it MUST NOT execute and SHOULD issue an Execution Receipt with result `failed` or `rejected`.

For MCP, this means converting the profile-native MCP tool-call parameter object into a native MCP `tools/call` JSON-RPC request at execution time.

### 6.7 Resolution and Retry Behavior

#### 6.7.1 Non-Final Responses

A non-final response (e.g., `additionalApprovalsRequired`, temporary `policyUnavailable`, Signer non-response) indicates the Action has not been resolved and may continue under the same Action Envelope if permitted by policy.

#### 6.7.2 Final Resolution

An Action is resolved when it is executed, rejected, failed, indeterminate, expired, cancelled, or revoked. Once resolved, an Execution Receipt SHOULD be issued. Exactly one Execution Receipt is ever issued per `actionId`. The same Action ID MUST NOT be reused for a different Action Envelope (see Section 6.9 Action Lifecycle for the complete rules governing `actionId` reuse and resubmission).

#### 6.7.3 Retry and Restart

If an Action Package is rejected as `malformed` or `notSupported`, the Proposer SHOULD correct the structural issue and submit a new Action Package with a new Action ID. If policy changes or expiration occurs, the Proposer SHOULD restart with a fresh Action Envelope.

### 6.8 Coordination Topologies

MPAS is transport-neutral. The same artifacts may be exchanged through different communication topologies. These topologies do not change the core protocol objects or verification rules.

#### 6.8.1 Direct Coordination

The Proposer communicates directly with the Verifier and Signers:

* Proposer → Verifier: initial Action Package
* Verifier → Proposer: Authorization Requirements or response
* Proposer → Signers: Signer Review Sets
* Signers → Proposer: Approvals
* Proposer → Verifier: completed Action Package
* Verifier / Credential Adapter → Proposer: response or Execution Receipt

Direct Coordination works well when the Proposer knows the required Signers and can reach them reliably.

#### 6.8.2 Shared Channel Coordination

Participants use a shared communication channel (chat group, issue tracker, pull request, etc.) to exchange artifacts and discuss the proposed Action.

The Proposer may post the Signer Review Set or a reference to it. Signers return Approvals in the channel or through a configured return path. Discussion in the channel is not an Approval unless it results in a valid MPAS Approval object. The Verifier evaluates Approval objects, not channel messages.

#### 6.8.3 Coordination Service Coordination

A Coordination Service manages MPAS workflow state and routes artifacts between participants. This is the most operationally complete topology because it can tailor communication to each participant type (web UI for humans, webhooks for agents, passkey flows for hardware signers, etc.).

#### 6.8.4 Common Requirements Across Topologies

Regardless of topology:

* the Verifier MUST receive the complete Action Package;
* Signers MUST receive enough information to evaluate the Signer Review Set;
* Approvals MUST remain unmodified from the form produced by Signers;
* transport metadata MUST NOT be treated as authorization;
* the entity routing artifacts MUST NOT be trusted for authorization unless policy explicitly grants that role.

### 6.9 Action Lifecycle

#### 6.9.1 Stateless Verification and the Dispatch Ledger (Normative)

**The Verifier is stateless with respect to verification.** Evaluation of an Action Package — structural validation, hash binding, Approval Bundle verification, and policy evaluation — is deterministic over the submitted package. A `rejected`, `expired`, `malformed`, or `additionalApprovalsRequired` outcome is a **response**, not recorded state. An identical resubmission yields the identical verdict; determinism, not memory, is the protection.

The Verifier's only protocol state is the **dispatch ledger**, which exists to enforce a single invariant:

> **An `actionId` is dispatched at most once.**

A ledger entry is `actionId → { envelopeHash, status }`, where `status ∈ { executing, resolved(executed | failed | indeterminate) }`. A ledger entry is written **only** at the moment an action is authorized for dispatch — immediately before transmission (write-ahead). There is no `open` state and no pinning at first submission.

The lifecycle has the following conditions:

**unknown** — The `actionId` is absent from the ledger. This is not stored state; it is the absence of a record.

**executing** — The action passed verification and policy, preparation succeeded, and the request has been (or is about to be) transmitted. The Verifier MUST durably record `executing` BEFORE transmission.

**resolved(result)** — The dispatch completed. The resolution IS the dispatch receipt result: `executed`, `failed`, or `indeterminate`. Exactly one **dispatch** Execution Receipt is ever issued per `actionId`. (`expired`, `rejected`, `cancelled`, and `revoked` are response/receipt results that are NOT ledger events — see 6.9.5.)

State transitions:

```
unknown   ──[authorized for dispatch; executing written]──▶ executing
executing ──[dispatch completes]──────────────────────────▶ resolved(executed | failed | indeterminate)
```

#### 6.9.2 Submission Handling Rules

For every submission the Verifier computes the Action Envelope hash and consults the ledger:

1. **`actionId` not in the ledger** — Perform full verification and policy evaluation of the submitted package.
   - Any deterministic rejection (invalid signature, expired envelope, envelope validity window exceeded, unknown application, disabled operation, resource restriction, definitive policy denial) → respond `rejected` or `expired` and **record NOTHING**. The verdict is repeatable.
   - Insufficient approvals → respond `additionalApprovalsRequired` and **record NOTHING**.
   - Authorized → perform fallible, side-effect-free preparation (credential resolution, target launch / connection establishment), then durably write `executing` BEFORE transmitting, then transmit.
2. **`actionId` in the ledger, DIFFERENT envelope hash** — MUST reject; the ledger is unchanged.
3. **`actionId` in the ledger, same hash, `executing`** — MUST NOT transmit again; respond `pending`.
4. **`actionId` in the ledger, `resolved`** — MUST reject as replay (any hash).

**A. Dispatch sequencing.** All fallible, side-effect-free preparation — credential resolution, target process launch or connection establishment — MUST occur BEFORE the ledger write. A failure during preparation is a **stateless error**: nothing is recorded, no receipt is issued, and an identical resubmission simply retries. "Dispatch" is defined as transmission of the request; the `executing` entry is written immediately before transmission. (Consequence: "credential handle not found" and "target unavailable" are stateless rejections with no receipt and no ledger entry — they occur pre-ledger.)

**B. Ledger immutability — no rollback, ever.** Entries are never deleted or rolled back. The only permitted transition is `executing → resolved(executed | failed | indeterminate)`. Any failure that lands after the write resolves the entry: `failed` if the target definitively reported failure, `indeterminate` if the outcome is unconfirmed. Re-attempting requires a NEW Action Envelope with a new `actionId` and fresh approvals. *Rationale:* rolling back after a `failed` response is itself a double-dispatch vector — the call may have had partial side effects — and, given rule A, the only failures landing after the write are rare mid-transmission ones; an invariant with no judgment calls is worth that price.

**C. Check-and-write property.** The ledger presence check and the `executing` write MUST behave as a single operation: two submissions of the same `actionId` can never both proceed to transmission. (In a single-process Verifier this is met by performing the check and write with no interleaving; in a multi-worker or shared-database Verifier, a uniqueness constraint on `actionId` is the cheap conforming implementation.)

**No cancellation at the Verifier:** The Verifier has no cancellation concept in this version. A Proposer abandons an action by letting the envelope expire. Cancellation exists only as a coordination-workflow courtesy (stop showing the action to signers) and has no effect on the Verifier lifecycle. (See 6.9.6 for future verifier-side cancellation.)

#### 6.9.3 Durability and Restart Recovery

- `executing` and `resolved` entries MUST be durable across process restarts. They MUST be retained at least until `actionEnvelope.expiresAt` plus the deployment's clock-skew tolerance.
- The `executing` entry MUST be durably flushed BEFORE transmission; otherwise it is not write-ahead.
- On restart, an action found `executing` with no matching resolution MUST NOT be re-dispatched. The Verifier MUST resolve it as `indeterminate`.
- An append-only journal of two event types (`executing`, then `resolved`) is the natural encoding of rule B; recovery appends an `indeterminate` resolution so it is idempotent across repeated restarts.

**Maximum envelope validity window.** The Verifier MUST enforce a configurable maximum envelope validity window (default: 24 hours). The Verifier MUST reject any Action Package whose Action Envelope `expiresAt` minus the current time exceeds this maximum. This is what makes TTL-bounded retention provably safe: the Verifier need only retain ledger records for the maximum envelope validity window plus clock-skew tolerance.

#### 6.9.4 Why Pinning Is Unnecessary

Approvals bind to the Action Envelope hash, so a second envelope claiming the same `actionId` needs its own valid approvals; the ledger ensures only the first submission to authorize ever dispatches. Determinism makes rejection memory worthless and eliminates the bundle-stripping denial-of-service: because rejections consume nothing, an observer of an in-flight package cannot resubmit a stripped bundle to brick a viable multi-party action. The `actionId` remains the nonce MPAS supplies; the dispatch ledger is what spends it.

#### 6.9.5 Component Views and Naming Consistency

Other components (Coordination Services, bridges, proposers) MAY maintain workflow states reflecting their local view. Such states are NON-AUTHORITATIVE and MUST NOT be represented as, or conflated with, the Verifier lifecycle. Where a component reuses a Core lifecycle or result term, its semantics MUST be consistent with the Core definition; where semantics differ, the name MUST differ.

The receipt-result vocabulary (`executed`, `failed`, `indeterminate`, `expired`, `rejected`, `cancelled`, `revoked`) is larger than the ledger's resolution set. `expired` and `rejected` are stateless deterministic responses (no ledger entry). `cancelled` and `revoked` are reserved (see 6.9.6); they are not producible by dispatch in this version.

**Non-normative interleaving diagram:**

The Coordination Service never observes Verifier state directly — it learns outcomes only when the Proposer relays them.

| Time  | Coordination Service (non-authoritative)            | Verifier (authoritative)                                                              |
| :---: | :-------------------------------------------------- | :------------------------------------------------------------------------------------ |
| t0    | —                                                   | Proposer submits initial Action Package                                               |
| t1    | —                                                   | Stateless: insufficient approvals → `additionalApprovalsRequired` (no ledger entry)   |
| t2    | Proposer submits to Coordination Service → `awaitingApprovals` | (no interaction with Verifier)                                                        |
| t3–t4 | Signers A, B submit Approvals to Coordination Service          | (no interaction with Verifier)                                                        |
| t5    | Threshold met → `readyForResubmission`              | (no interaction with Verifier)                                                        |
| t6    | —                                                   | Proposer resubmits completed package (same actionId, same hash)                       |
| t7    | —                                                   | Stateless re-verification → policy satisfied → prepare → write `executing` → transmit |
| t8    | —                                                   | Dispatch succeeds → `resolved(executed)` — receipt issued                             |
| t9    | Proposer relays receipt; Coordination Service may record `executed` | —                                                                                     |

If the Proposer never resubmits and the envelope expires, the Verifier never created a ledger entry; a late submission is the stateless deterministic rejection `expired`. If the Proposer cancels coordination, the Coordination Service records `cancelled` as a workflow convenience only; the Verifier, having no ledger entry, is unaffected.

#### 6.9.6 Future Work: Verifier-Side Cancellation

A future version MAY define verifier-side cancellation as a proposer-signed `CancellationRequest` bound to the Action Envelope hash and verified like an Approval. It would resolve an `actionId` by writing a ledger entry WITHOUT dispatching, attesting a `cancelled` (or `revoked`) receipt result. This is the reservation behind those result values.

#### 6.9.7 Replay-Domain Scope

The at-most-once-dispatch invariant holds per Verifier, within its replay domain. Deployments requiring at-most-once execution per CREDENTIAL MUST route all submissions for that credential through a single Verifier. Cross-verifier exclusion is out of scope for MPAS and belongs to the target application's own concurrency control, idempotency mechanisms, or a consensus layer (for example, on-chain multisig for blockchain targets).

## 7. Component Implementation and Configuration Guidance

### 7.1 Overview

This section describes implementation guidance for MPAS components, including security requirements, trust boundaries, and configuration responsibilities.

### 7.2 Signer

#### 7.2.1 Role

A **Signer** is a participant that can produce an Approval, including the software, hardware, wallet, custody system, agent process, or user interface used by the Signer to review a Signer Review Set and produce an Approval.

#### 7.2.2 Credential Custody

Signer credentials SHOULD be non-exportable where possible and protected using appropriate custody mechanisms (hardware wallets, passkeys, secure enclaves, TPMs, HSMs, KMS, custody providers, or mobile secure hardware).

#### 7.2.3 Signer Isolation

MPAS policy often assumes that different Signers are independently controlled. Signer credentials SHOULD be isolated from each other through different physical devices, hardware-backed credentials, different OS users, separate VMs, separate HSM/KMS keys, or separate custody-provider accounts.

Multiple Signers MAY operate from the same physical device only if their credentials and authorization boundaries remain isolated. If multiple Signers' credentials are accessible to the same process or compromised system, those Signers SHOULD NOT be treated as independent for policy purposes.

#### 7.2.4 Human and Agent Signers

Human Signers generally require a user interface for review and may integrate with passkeys, hardware wallets, wallet applications, enterprise SSO, or custody-provider workflows.

Agent Signers may consume Signer Review Sets through deterministic APIs, queues, or local IPC. Agent Signers SHOULD evaluate Signer Review Sets using deterministic policy or delegated authority, not nondeterministic interpretation of unstructured communication.

### 7.3 Proposer

#### 7.3.1 Role

A **Proposer** is a Signer that initiates an Action. The Proposer creates the Execution Payload, constructs the Action Envelope, produces the initial Approval, assembles the initial Approval Bundle, and submits the initial Action Package.

#### 7.3.2 Relationship to Signer

The Proposer is a special case of Signer. For many low-impact Actions, the Proposer's Approval may be sufficient. The Proposer is not trusted merely because it initiated the Action.

#### 7.3.3 Communication Responsibilities

The Proposer MUST be able to reach the Verifier through the deployment's coordination topology. The Proposer MUST NOT define authorization policy through Proposer-controlled payload fields or unsigned metadata.

### 7.4 Verifier and Policy Store

#### 7.4.1 Role

The **Verifier** determines whether an Action Package satisfies MPAS authorization policy using the procedure in Section 6.2.

#### 7.4.2 Deterministic Authorization

A Verifier MUST make authorization decisions using deterministic code, policy, configuration, smart contract logic, or trusted local systems. A nondeterministic LLM MUST NOT be the sole or final authorization authority unless its output is constrained by deterministic Verifier policy. A nondeterministic system may assist with summarization, risk scoring, or anomaly detection, but the final authorization decision MUST be deterministic and verifiable.

#### 7.4.3 Policy Store

MPAS does not prescribe a specific policy language or storage mechanism. The Verifier policy store SHOULD be able to determine: supported Application DIDs, supported execution profiles, supported profile-native operations or commands, eligible Signers, threshold requirements, override Signers, trusted external approval systems, key authorization requirements, replay and Action ID rules, expiration rules, and Credential Adapter mappings (if applicable).

#### 7.4.4 Verifier Configuration Scope

A Verifier embedded in a native MPAS Application generally needs policy only for that Application. A Verifier used by a Credential Adapter may need policy, credential mappings, execution profile support, and interface configuration for many non-MPAS-native Applications.

### 7.5 Application

#### 7.5.1 Native MPAS Application

A native MPAS Application understands MPAS Action Packages directly, includes or calls a Verifier, executes authorized Actions, and issues Execution Receipts.

#### 7.5.2 Non-MPAS-Native Application

A non-MPAS-native Application receives ordinary API calls, commands, or credentialed requests from a Credential Adapter. It does not need to know that MPAS exists.

#### 7.5.3 Application DID

The Application DID identifies the target Application. It is identified in `actionEnvelope.target.applicationDid` and is used by Verifiers and Credential Adapters to locate trusted configuration. Native MPAS Applications MAY publish configuration through the Application DID. For non-MPAS-native Applications, the Credential Adapter or deployment operator maintains trusted configuration for the Application DID.

Native MPAS Applications MAY bind their own Application DID to a supported execution profile.

### 7.6 Credential Adapter

#### 7.6.1 Role

A **Credential Adapter** is an MPAS-aware bridge for non-MPAS-native Applications. After the Action Package is authorized, it translates the approved Execution Payload into the command, request, transaction, or credentialed operation accepted by the target Application.

#### 7.6.2 Trusted Position and Security Requirements

A Credential Adapter is a high-trust component that may hold or use credentials allowing downstream Applications to execute Actions (API keys, OAuth tokens, SSH keys, wallet keys, cloud credentials, etc.).

If compromised, a Credential Adapter may misuse downstream credentials even when MPAS Approvals are invalid. Implementations MUST:

* Enforce deterministic Verifier policy before any credential use.
* Bind credential use to the approved Execution Payload.
* NOT expose reusable credentials to Proposers, Signers, agents, Coordination Services, or unauthorized participants.
* NOT allow the Execution Payload, Proposer, or unsigned metadata to authoritatively select credentials, weaken credential scope, choose the credential store, or bypass policy.

Implementations SHOULD:

* Minimize credential scope.
* Use short-lived or scoped credentials where possible.
* Use non-exportable keys where possible.
* Isolate credential access from agent runtimes.
* Use HSM/KMS integrations, secret managers, or custody providers where appropriate.
* Protect against replay.
* Log credential use according to deployment policy.
* Issue Execution Receipts when Actions are resolved.

#### 7.6.3 Application Configuration

For each supported Application DID, the Credential Adapter SHOULD maintain trusted configuration describing: supported execution profiles, supported profile-native payload formats, operation/tool/command mappings, payload interpretation and validation rules, credential requirements and bindings, endpoint/API/protocol format, receipt behavior, and failure handling.

#### 7.6.4 Credential Selection

Credential selection MUST come from trusted Credential Adapter configuration, not from Proposer-supplied fields. The Credential Adapter uses `actionEnvelope.target.applicationDid` and `actionEnvelope.executionProfile` to determine which credentials, accounts, keys, or providers are applicable.

#### 7.6.5 Translation and Execution

After authorization, the Credential Adapter constructs the application-native command from the verified Execution Payload, `actionEnvelope.target`, `actionEnvelope.executionProfile`, and trusted configuration. If it cannot safely translate the Execution Payload under the declared profile, it MUST NOT execute.

### 7.7 Coordination Service

#### 7.7.1 Role

A **Coordination Service** is an optional workflow component that stores, routes, synchronizes, and tracks MPAS artifacts.

#### 7.7.2 Trust Boundary

A Coordination Service is not the source of approval authority. It MUST NOT be treated as an approval authority unless the Verifier's policy explicitly trusts it for a specific external approval or workflow role. A Coordination Service MUST NOT alter the Execution Payload, Action Envelope, or Approval objects without causing verification failure.

A Coordination Service should be designed as a non-custodial coordination service. It should not hold private keys, signer credentials, application credentials, or reusable secrets.

Discussion that occurs in channels managed by a Coordination Service is not an Approval unless it results in a valid MPAS Approval object.

#### 7.7.3 Responsibilities

A Coordination Service MAY:

* store pending Actions and route Action Packages;
* route Signer Review Sets and notify Signers;
* collect Approvals and assemble Approval Bundles;
* make collected Approvals and assembled Approval Bundles available to the Proposer;
* distribute Execution Receipts;
* expose status to participants;
* provide dashboards, review screens, or audit views;
* maintain workflow records.

#### 7.7.4 Participant Reachability

A Coordination Service is useful because it can tailor communication to each participant type:

* a human Signer may receive a web or mobile review screen;
* an agent Signer may receive a webhook or API request;
* a wallet Signer may receive a signing request;
* a hardware signer may receive a passkey flow;
* a Credential Adapter may receive a deterministic HTTP callback;
* a shared team channel may receive a status notification;
* an audit system may receive an Execution Receipt.

#### 7.7.5 Push, Polling, and Delivery Models

A Coordination Service MAY notify participants when action is required, expose polling APIs, or support both. Polling frequency, notification method, retry behavior, and delivery guarantees are deployment-specific. A Coordination Service SHOULD provide deterministic APIs for software components.

Transport profiles MAY define a delivery envelope around an MPAS message or artifact. Such an envelope is routing metadata, not an Approval or execution authorization. It does not assign the recipient a Proposer, Signer, Verifier, or other MPAS role, and the enclosed object retains every verification and authorization requirement defined by this specification.

The MPAS HTTP Profile defines DID-addressed routed delivery, Coordination Service relay submission, polling retrieval, and an optional notification-only WebSocket. Those transport mechanisms do not change the Action Package, Action Envelope, Approval, Authorization Requirements, Action Response, or Execution Receipt schemas.

### 7.8 Key Authorization and Identity

#### 7.8.1 Purpose

MPAS uses identities, keys, signatures, and external authorization references. Implementations must distinguish between key control (proving a key produced a signature) and key authorization (proving the key is authorized for a DID, participant, role, or other policy identity).

#### 7.8.2 When Key Authorization Is Required

Additional key authorization is required when the signature or external reference does not itself establish the participant identity required by policy. Examples:

* policy requires `did:web:alice.example`, but the signature only recovers an Ethereum address;
* policy requires an organization DID, but the signature is produced by a service key;
* a JWS `kid` points to a DID URL that must be resolved;
* a receipt signing key must be authorized for `issuerDid`;
* an external approval references a custody-provider record that must be mapped to a trusted participant.

If policy directly recognizes the signing key, wallet address, or external system as the relevant authority, additional identity mapping may not be required.

#### 7.8.3 Key Authorization Mechanisms

MPAS does not require a single key authorization mechanism. Key authorization MAY be established through:

* OMATrust;
* DID document resolution;
* application-published key registries;
* enterprise IAM;
* onchain registries;
* custody-provider records;
* smart contract ownership or authorization logic;
* direct listing in Verifier policy;
* another trusted deployment-specific mechanism.

OMATrust is a natural fit for binding service, Verifier, Credential Adapter, receipt issuer, or Application identities to authorized keys and attestations. However, MPAS does not require OMATrust as the only mechanism.

#### 7.8.4 Identity and Key Authorization Scope

MPAS does not define identity proofing, delegation, organization membership, role assignment, or key-binding authority. Verifiers MAY use DID documents, local configuration, enterprise IAM, OMATrust attestations, Verifiable Credentials, or other trusted systems to determine whether a signing key is authorized for a Signer DID or approval role. The choice of identity and key authorization mechanism is deployment-specific and outside MPAS Core scope.

### 7.9 Logging, Receipts, and Audit

#### 7.9.1 Execution Receipts

Execution Receipts are defined in Section 5.9. Receipt behavior is determined by Verifier, Application, Credential Adapter, or deployment configuration.

#### 7.9.2 Audit Logs

Audit logging is deployment-specific. Deployments MAY log MPAS activity to local logs, Coordination Services, enterprise logging systems, SIEM systems, cloud logging platforms, append-only logs, smart contracts, or audit databases.

#### 7.9.3 Public Attestation

Most MPAS receipts and audit logs are operational artifacts. A receipt MAY be used as evidence in a later attestation when the deployment has a reason to make the result externally verifiable (paid service delivery, certification workflows, compliance events, dispute resolution, etc.).

## 8. Security and Deployment Considerations

### 8.1 Overview

MPAS provides interoperable data structures and protocol rules for multi-party authorization. It does not, by itself, make a deployment secure. Security depends on correct implementation, secure custody of signer credentials, deterministic verifier policy, isolation between participants, proper handling of credentials, replay protection, auditability, and operational security.

### 8.2 Canonical Binding and Verification

MPAS security depends on canonical binding between objects:

* the Action Envelope binds to the Execution Payload by hash;
* the Action Envelope also binds the execution profile and target metadata (because those fields are part of the Action Envelope hash);
* each Approval binds to the Action Envelope by hash;
* the Approval Bundle binds to the Action Envelope by hash;
* the Execution Receipt binds to both the Action Envelope and Execution Payload by hash.

Signers approve both:

* the hash-bound profile-native Execution Payload; and
* the Action Envelope metadata that defines how that payload is interpreted.

Implementations MUST use deterministic canonicalization and hashing. Participants MUST NOT rely on untrusted summaries, chat messages, UI text, or coordination metadata as substitutes for verification of the underlying MPAS artifacts.

### 8.3 Participant Isolation

MPAS policies often assume that Signers and other participants are independently controlled. That assumption is invalid if multiple participants' credentials can be accessed by the same process, user account, agent runtime, or compromised environment.

* **Signers:** Signer credentials SHOULD be isolated using separate physical devices, OS users, VMs, secure enclaves, hardware wallets, HSM/KMS keys, or custody-provider accounts.
* **Credential Adapters:** Credential Adapter processes and credentials SHOULD be isolated from Proposers, agents, Signers, and Coordination Services.

For local deployments, a **Local Signer Service** may protect key material from agents or applications running on the same machine.

### 8.4 Key Authorization and Identity

Signature verification proves control of a key. It does not always prove that the key is authorized for the participant identity required by policy. See Section 7.8 for mechanisms and requirements.

### 8.5 Replay, Expiration, and Reuse

Replay protection is required for MPAS safety. The Action Envelope `actionId` must be globally unique or unique within its scope. Replay protection is governed by the dispatch ledger (Section 6.9): an `actionId` already present in the ledger is never dispatched again — a ledgered-with-different-hash or already-`resolved` submission MUST be rejected, and an identical `executing` resubmission receives `pending`. Verification itself is stateless and deterministic, so repeating a rejected submission simply repeats the verdict. A Verifier MUST retain ledger state for an `actionId` at least until `actionEnvelope.expiresAt` plus the deployment's timestamp tolerance. Previously collected Approvals do not apply to a changed Action Envelope unless they bind to the new Action Envelope.

### 8.6 Multiple Verifiers and Duplicate Execution

MPAS Core proves approval over an Action Envelope and hash-bound Execution Payload. MPAS Core does not guarantee exclusive delivery to a single Verifier, shared replay state across independent Verifiers, or single execution of a downstream command by multiple authorized execution components.

A Verifier MUST reject an Action Package unless it is authorized under trusted local configuration to act for the declared `actionEnvelope.target.applicationDid` and `actionEnvelope.executionProfile`.

A Verifier MUST enforce replay protection for Action IDs within its own replay domain.

Applications and execution profiles are responsible for application-native idempotency, duplicate-execution prevention, nonces, resource-version checks, state checks, and similar controls.

Deployments that require an Action Package to be processable only by a specific Verifier SHOULD deliver it through an authenticated confidential channel. Future profiles may define verifier-bound encrypted Action Packages, shared replay registries, cross-verifier replay protection, and state-binding/precondition mechanisms.

### 8.7 Logging, Receipts, and Audit

Execution Receipts are signed summaries of Action resolution. Audit logging is deployment-specific. See Section 7.9. Future versions may define structured error events or higher-assurance receipt evidence profiles.

### 8.8 Agentic Workflow Considerations

MPAS is especially relevant for autonomous and semi-autonomous agents. MPAS allows agents to propose Actions without receiving permanent unilateral authority over credentials or protected Applications. Credential Adapters prevent agents from directly possessing long-lived ambient credentials.

A nondeterministic LLM MUST NOT be the sole or final authorization authority unless its output is constrained by deterministic Verifier policy. An "Agent Signer" in MPAS is typically a deterministic automated co-signer or policy bot, not an AI exercising unconstrained judgment. Agents may assist with risk scoring, anomaly detection, or recommendation, but the Verifier's final authorization decision MUST be deterministic.

Agent Signers and agent Proposers SHOULD interact with MPAS through deterministic APIs or structured interfaces, not unstructured chat or natural-language messages.

## 9. Relationship to Existing Standards

### 9.1 Overview

MPAS is intended to complement and reuse existing standards rather than replace them. Where existing standards already solve part of this problem, MPAS should use or profile those standards rather than define incompatible alternatives.

### 9.2 Identity, Authentication, and Authorization

MPAS may interact with existing identity and authentication systems, including DIDs, DID Documents, Verifiable Credentials, FIDO/WebAuthn, OAuth2/OIDC, Sign-In with Ethereum, and enterprise IAM systems. MPAS does not require one identity system for all deployments.

### 9.3 Signing and Signature Container Standards

MPAS Core v0.2 defines JWS as the normative signature format. Implementations MUST follow JWT Best Current Practices (RFC 8725 / BCP 225) for JWS algorithm safety. Additional signature formats may be defined by future profiles.

### 9.4 Human Review and Clear Signing

MPAS requires Signers to review the Execution Payload and Action Envelope before producing an Approval. This version does not define a normative human-readable summary format. Relevant adjacent work includes ERC-7730 and Ledger Clear Signing, wallet transaction review conventions, and application-specific operation descriptors. Future profiles may define clear-signing or rendering-descriptor formats.

### 9.5 Coordination, Multisig, and Smart Account Patterns

MPAS draws from existing coordination and multisig systems (Safe, ERC-4337, institutional custody, enterprise change-management) but standardizes portable structures across Web2, Web3, agentic, and enterprise environments. Future profiles may define Safe / ERC-4337 / EIP-1271 / EIP-712 integrations for blockchain execution and smart-contract signer verification.

### 9.6 Transparency, Audit, and Attestation

MPAS Execution Receipts provide signed summaries of Action resolution. Relevant adjacent systems include Certificate Transparency, Sigstore/Rekor, SCITT, OMATrust attestations, and enterprise SIEM.

### 9.7 Agent, Tooling, and Payment Ecosystems

MPAS is relevant to agentic execution environments. Relevant adjacent systems include MCP, x402, tool registries, API gateways, agent orchestration systems, and cloud automation.

Future or companion profiles may define profile-native Execution Payload formats for:

* MCP tool calls;
* OpenAPI operation calls;
* EVM transaction intents;
* x402 payment payloads;
* HTTP request objects;
* CLI command objects;
* browser or desktop automation recipes.

### 9.8 Agent Control Standard / Agent Control Specification (ACS)

ACS (Agent Control Standard, also known as Agent Control Specification) is an adjacent standard for agent runtime control, observability, and hook-based policy enforcement. ACS-style control points can include tool-call requests, tool responses, memory operations, code execution, sub-agent invocation, planning transitions, input, and output.

MPAS overlaps most directly with ACS at high-impact tool-call or command-execution boundaries, where an agent attempts to perform an action that may require multi-party approval. MPAS is not an ACS replacement. ACS can identify where an agent runtime should intercept or evaluate an event; MPAS defines the portable artifacts and verification process for approving, rejecting, executing, and receipting a specific action.

MPAS should be usable behind an ACS hook. For example, an ACS `toolCallRequest` hook may trigger an MPAS Verifier or Credential Adapter before the tool call is allowed to proceed. MPAS preserves profile-native Execution Payloads. MPAS should not require all actions to be normalized into a universal ACS-style `tool` / `parameters` shape. Instead, an ACS integration profile may map an ACS runtime event into an MPAS execution profile such as MCP tool calls, OpenAPI operations, EVM transaction intents, HTTP requests, CLI commands, browser recipes, desktop recipes, x402 payment payloads, or native application commands. ACS event metadata, traces, session data, summaries, or runtime context should not be treated as authoritative MPAS policy inputs unless included in the hash-bound Execution Payload or Action Envelope, or unless independently derived and trusted by the Verifier.

ACS is complementary to MPAS. ACS can provide standardized agent-runtime interception points, while MPAS provides the hash-bound action representation, multi-party approval artifacts, Verifier processing rules, and Execution Receipts needed to authorize high-impact actions. In an ACS-enabled runtime, an ACS hook may invoke an MPAS Verifier or Credential Adapter before a tool call, command execution, payment, deployment, or other high-impact event proceeds. The ACS hook identifies the control point; MPAS determines whether the specific Action Package satisfies applicable policy.

### 9.9 Compatibility Profiles

MPAS may define compatibility profiles for particular ecosystems or execution environments. A compatibility profile defines:

* the Execution Payload format;
* hashing/canonicalization rules;
* how to derive operation/command identity from the profile-native payload;
* payload validation rules;
* rendering/clear-review metadata;
* receipt mappings;
* Credential Adapter mappings when applicable.

Compatibility profiles must preserve the core MPAS security properties: canonical binding, verifiable Approvals, Verifier-controlled policy, replay protection, and clear separation between coordination and approval authority.

### 9.10 Standards Alignment Summary

The following table summarizes how MPAS Core v0.2 relates to adjacent standards:

| Standard                                  | Relationship to MPAS Core v0.2                                                                  |
| :---------------------------------------- | :---------------------------------------------------------------------------------------------- |
| MCP (Model Context Protocol)              | First intended execution-profile target. Detailed MCP profile is separate/future.               |
| OAuth RAR (RFC 9396) / GNAP (RFC 9635)    | Related authorization negotiation and structured authorization work. Not replaced by MPAS.      |
| UCAN / ZCAP-LD                            | Relevant to future standing grants/delegation. Not Core v0.2 scope.                             |
| Verifiable Credentials / OMATrust         | Relevant to identity, role, key-binding, and trust attestations. Not mandatory Core dependency. |
| Safe / ERC-4337 / EIP-1271 / EIP-712      | Future blockchain signature and execution profiles.                                             |
| SCITT / Sigstore / in-toto / did:artifact | Relevant to future application plugin artifact identity, provenance, and audit.                 |
| JWT Best Current Practices (RFC 8725)     | Adopted for JWS algorithm safety guidance.                                                      |
| DPoP (RFC 9449)                           | Relevant to audience and replay discussion; future profiles may align.                          |



## 10. Future Standardization Work

### 10.1 Overview

This section identifies areas for future MPAS standardization not required for the current version.

### 10.2 Execution Profiles

Future profiles will define profile-native Execution Payload formats, hashing rules, validation rules, rendering metadata, and Credential Adapter mappings for specific execution domains:

* **MCP Execution Profile:** MCP tool-call parameter objects, canonicalization, tool-identity derivation, and MCP server integration.
* **OpenAPI Execution Profile:** OpenAPI operation calls, parameter schemas, and endpoint mapping.
* **EVM / Blockchain Execution Profile:** EVM transaction intents, smart-account execution requests, contract call intents, state-root or nonce preconditions, and wallet/Credential Adapter behavior.

### 10.3 Blockchain and EIP-712 Signature Profiles

Future profiles may define:

* EIP-712 Approval signing with full smart-contract signer support.
* EIP-1271 smart-contract signer verification.
* ERC-6492 counterfactual account support.
* Safe / ERC-4337 integrations.
* EVM execution payload semantics.

### 10.4 Alternative Signing and Approval Formats

Future versions may define additional Approval formats beyond JWS. Potential formats include MPC/TSS key-share contributions, threshold-signing formats, passkey/WebAuthn approvals, and provider-mediated approvals.

### 10.5 Error and Lifecycle Events

Future versions may define structured error events, audit events, and lifecycle events using the same signed-artifact pattern as Execution Receipts.

### 10.6 Policy Standard Integration

Future versions may define mappings to policy standards (OPA/Rego, Cedar, OpenFGA, enterprise IAM, smart contract policy) specifying how MPAS objects are represented as policy inputs.

### 10.7 State Binding and Preconditions

Future profiles may define hash-bound preconditions or state assertions, such as PR head SHA, object revision, ETag, account nonce, resource version, chain state root, or other state commitments that must hold at execution time. MPAS Core v0.2 does not define a generic precondition or state-root model.

### 10.8 Verifier-Bound Encrypted Action Packages

Future profiles may define mechanisms for encrypting or binding Action Packages to a specific intended Verifier, preventing cross-verifier replay at the cryptographic layer.

### 10.9 Shared Replay Registries

Future profiles may define shared replay state across independent Verifiers, cross-verifier replay protection, and distributed Action ID deduplication.

### 10.10 External Approvals and External Proof Bindings

Future profiles may define external approval records, external proof bindings, trusted workflow approvals, provider approvals, smart-contract approval records, or OMATrust attestations. Such profiles must define cryptographic or verifier-trusted binding to `actionEnvelopeHash`.

### 10.11 Signed VerifierDecision Artifact

Future profiles may define a signed pre-execution Verifier Decision artifact that enables separation of the authorization decision from enforcement, supports multi-stage verification, and provides signed audit evidence of policy satisfaction.

### 10.12 Delegation and Standing Authorization

Future profiles may define:

* Delegation / `onBehalfOf` / delegation chains.
* Standing Authorization Grants (scoped, time-limited, revocable grants).
* UCAN or ZCAP-style capability profiles.
* A2A capability binding and Agent Card integration.

### 10.13 Discovery

Future profiles may define discovery beyond the optional HTTP well-known endpoint, including:

* Eligible-signer discovery via Application DID document service entries.
* Application capability discovery via DID resolution.
* Verifier capability and policy discovery.

### 10.14 Application Plugin Trust and Distribution

Future profiles may define:

* Application Plugin trust, distribution, and marketplace behavior.
* `did:artifact` content-addressed identifiers and lockfile formats.
* OMATrust attestations and trust scoring for plugins.
* Rich signer rendering / MCP Apps / trusted renderers.

### 10.15 Enterprise Architectures

Enterprise separated decision/enforcement architectures (PDP/PEP separation) are implementation-specific and not normative in MPAS Core. Future guidance may address enterprise deployment patterns.

### 10.16 Agent Runtime Control Points and ACS Integration

Future profiles may define how non-tool-call agent runtime events are represented, reviewed, approved, and receipted. Examples include memory writes, code execution, sub-agent delegation, planning-to-execution transitions, outbound communications, sensitive data release, browser automation, desktop automation, and tool-response-based controls.

Some of these events may become first-class MPAS execution profiles; others may be represented as ACS integration bindings that map runtime events into profile-native MPAS Execution Payloads.

Future work may define:

* ACS hook-to-MPAS execution profile mappings;
* deterministic event-to-Execution-Payload transformation rules;
* policy suggestion fields for ACS control points in the MPAS Application Plugin Profile;
* clear-review/rendering requirements for non-tool-call events;
* receipt mappings for events that are approved, rejected, modified, blocked, or executed;
* security rules for treating ACS event metadata as non-authoritative unless hash-bound or Verifier-derived.

Future profiles may define ACS integration bindings that identify agent-runtime control points and map those runtime events into MPAS profile-native Execution Payloads. This would allow MPAS approvals to protect not only MCP-style tool calls, but also other high-impact agent events such as memory writes, code execution, sub-agent delegation, planning-to-execution transitions, outbound communications, and sensitive data release. Such profiles must preserve the core MPAS security model: the approved action must be hash-bound, Signer-reviewable, Verifier-controlled, replay-protected, and receiptable.

## 11. Conclusion

MPAS defines a general-purpose framework for coordinating high-impact digital Actions across humans, agents, devices, organizations, Applications, and chains.

MPAS standardizes the core artifacts needed for this workflow:

* Execution Payloads;
* Action Envelopes;
* Signer Review Sets;
* Approvals;
* Approval Bundles;
* Action Packages;
* Authorization Requirements;
* Execution Receipts.

These artifacts allow participants to propose Actions, review what is being requested, approve or reject the request, verify whether policy has been satisfied, execute authorized Actions, and record the outcome.

MPAS separates several concerns that are often conflated:

* Action representation is separate from policy.
* Execution Payload format is separate from MPAS protocol metadata.
* Coordination is separate from approval authority.
* Credential use is separate from credential exposure.
* Signing backend implementation is separate from approval semantics.
* Human discussion is separate from verifiable Approval.
* Execution receipts are separate from full audit logs or public attestations.

This separation allows MPAS to support multiple deployment models and execution profiles. Existing non-MPAS-native Applications can adopt MPAS through Credential Adapters, while native MPAS Applications can verify Action Packages directly. Human Signers can use review and signing interfaces, while agent Signers can use deterministic APIs. Coordination can occur directly, through shared channels, or through Coordination Services. Execution Payloads remain in their native format — MCP tool calls, OpenAPI operations, EVM transaction intents, HTTP requests, or any future profile-native format — while the Action Envelope provides the universal MPAS interpretation layer.

By standardizing how Actions are proposed, approved, verified, executed, and recorded, MPAS can reduce ambiguous signing, agent overreach, credential exposure, frontend monoculture, backend lock-in, and weak auditability across Web2, Web3, AI, and metaverse systems.

# Appendix A. JSON Schema for MPAS Core Data Structures

## A.1 Schema Design Approach

### Design Principles

1. **Strict Core v0.2 validation schema.** These schemas validate the MPAS Core v0.2 protocol objects. Core protocol objects are closed with `additionalProperties: false` unless the specification explicitly allows profile extension. The `target` sub-object is kept extensible because the spec explicitly states "Profiles MAY define additional `target.*` fields." All other Core objects are closed.

2. **Shared definitions via `$defs`.** Common types (`Hash`, `DID`, `Timestamp`, `Decision`, `SignatureObject`, `Version`, `ActionId`) are defined once in the shared definitions schema and referenced throughout. This ensures consistency and simplifies maintenance.

3. **`$id` convention:** Schemas use `https://oma3.org/schemas/mpas/base/0.2.json` as the base identifier, following the OMA3 schema URL pattern established by other OMA3 specifications.

4. **Execution Payloads are intentionally unconstrained by Core.** The `executionPayload` field uses the JSON Schema boolean schema `true`, meaning any valid JSON value is accepted. Profile-specific validators MAY layer additional schemas based on `actionEnvelope.executionProfile.id` and `actionEnvelope.executionProfile.format`. The Core schema does not use `"type": "object"` for `executionPayload`.

5. **No future-work fields.** Schemas do not include delegation, standing authorization, external proof bindings, ACS fields, encrypted packages, verifier-bound fields, lifecycle events, EIP-712 signatures, alternative signature formats, state-binding, or any other feature designated as future work in Section 10.

6. **Conditional requirements.** Where the specification makes a structural requirement conditional on a field value (e.g., `approvalRequirements` required when `result` is `additionalApprovalsRequired`), JSON Schema `if/then` is used. Where the condition depends on runtime state (e.g., "MUST reject if expired"), the requirement is documented as an implementation check.

7. **DID validation is structural only.** The DID pattern `^did:[a-z0-9]+:[^\s]+$` provides a permissive structural check. Real DID method support, DID resolution, and identity verification remain runtime checks.

8. **JWS validation is structural only.** The JWS compact serialization pattern checks for three dot-separated base64url segments. JSON Schema cannot verify JWS header fields (`alg`, `kid`), cannot reject `alg: "none"`, cannot verify the cryptographic signature, and cannot verify that the signed payload binds to the outer Approval fields.

---

## A.2 Structural Constraints Inferred from the Specification

The following structural constraints are derived from the entire specification — not only the field tables in Section 5 — including processing rules (Section 6), security considerations (Section 8), signature rules (Section 5.5.6), replay/timestamp rules (Sections 5.3.7–5.3.8), and standards-alignment notes (Section 9).

### From Section 5.1 (Common Rules)
- All protocol objects (except Execution Payloads) MUST have a `version` field with value `"1"`.
- Timestamps MUST be RFC 3339 / ISO 8601 UTC strings ending in `Z`.
- Hash values MUST be objects with `alg` (string) and `value` (base64url without padding).
- `alg` for hashes MUST NOT be `md5`, `sha-1`, or otherwise deprecated per NIST SP 800-131A.
- Binary values MUST use base64url encoding without padding.
- Floating-point numbers SHOULD NOT appear in signed objects.
- Duplicate JSON object member names MUST be rejected (parser requirement, not schema-enforceable).

### From Section 5.3 (Action Envelope)
- `type` MUST be `"ActionEnvelope"`.
- `proposer.did` required (DID).
- `target.applicationDid` required (DID).
- `target` is extensible — profiles MAY add fields like `chainId`, `namespace`, `region`, `tenant`.
- `executionProfile.id` required (DID).
- `executionProfile.format` recommended but optional.
- `executionPayloadHash` required (Hash object).
- `actionId.value` required; `actionId.scope` required if value is not globally unique (runtime-determined; schema marks scope optional).
- `createdAt` and `expiresAt` required.

### From Section 5.4 (Signer Review Set)
- `type` MUST be `"SignerReviewSet"`.
- `executionPayload` required (any valid value — profile-native).
- `actionEnvelope` required (ActionEnvelope).
- `authorizationRequirements` optional.

### From Section 5.5 (Approval)
- `type` MUST be `"Approval"`.
- `actionEnvelopeHash` required (Hash).
- `decision` required — Core values: `propose`, `approve`, `reject`, `abstain`.
- `signature` required (SignatureObject).
- `createdAt` required — because v0.2 only defines Signature Approvals, and Signature Approvals MUST include `createdAt`.
- `expiresAt` optional (inherits `actionEnvelope.expiresAt` if absent).

### From Section 5.5.5 (Canonical Approval Payload)
- `type` MUST be `"ApprovalPayload"`.
- `actionEnvelopeHash` required.
- `decision` required.
- `signerDid` conditional — REQUIRED when policy evaluates signer identity by DID (not structurally enforceable; schema marks optional).
- `createdAt` required.
- `expiresAt` optional.

### From Section 5.5.5.2 (Signature Object)
- `format` MUST be `"jws"` (only format in v0.2).
- `value` required — JWS Compact Serialization.
- `payload` field MUST be omitted — enforced by `additionalProperties: false`.

### From Section 5.5.6 (JWS rules — inside JWS, not outer-schema-enforceable)
- `alg` MUST NOT be `"none"`.
- JWS header MUST contain `alg` and `kid`.
- EdDSA mandatory-to-implement; ES256, ES256K recommended.
- Embedded `jwk` MUST NOT alone establish signer authority.

### From Section 5.6 (Approval Bundle)
- `type` MUST be `"ApprovalBundle"`.
- `actionEnvelopeHash` required.
- `approvals` required — non-empty array (`minItems: 1`).
- `assembledBy` optional (DID).
- `createdAt` recommended.

### From Section 5.7 (Action Package)
- `type` MUST be `"ActionPackage"`.
- `executionPayload` required (profile-native, unconstrained).
- `actionEnvelope` required.
- `approvalBundle` required.
- `createdAt` recommended.

### From Section 5.8 (Authorization Requirements)
- `type` MUST be `"AuthorizationRequirements"`.
- `actionEnvelopeHash` required.
- `result` required — enum: `additionalApprovalsRequired`, `rejected`, `notSupported`, `malformed`, `policyUnavailable`.
- `verifier.did` required.
- `approvalRequirements` required when `result` is `additionalApprovalsRequired` (enforceable via `if/then`).
- `policyRef` optional.
- `createdAt` recommended.
- `expiresAt` recommended.

### From Section 5.8.5 (Approval Requirements)
- At least one of `anyOf`, `allOf`, or `overrideSigners` SHOULD be present — enforced as strict quality gate.
- `anyOf`/`allOf` contain ThresholdRequirement objects.

### From Section 5.8.6 (Threshold Requirement)
- `type` MUST be `"threshold"`.
- `threshold` required (positive integer).
- `eligibleSigners` required (non-empty array of DIDs).
- `decision` optional (defaults to `approve`).
- `description` optional.

### From Section 5.8.7 (Override Signers)
- `signer` required (DID).
- `permissions` required (non-empty array of strings — not restricted to Decision enum).
- `description` optional.

### From Section 5.9 (Execution Receipt)
- `type` MUST be `"ExecutionReceipt"`.
- `format` MUST be `"jws"`.
- `signature` required — JWS Compact Serialization string (not the nested Approval-style object).
- No `payload` field.

### From Section 5.9.4 (Receipt Payload)
- `issuerDid` required (DID).
- `actionEnvelopeHash` required (Hash).
- `executionPayloadHash` required (Hash).
- `actionId` recommended.
- `proposerDid` recommended.
- `result` required — enum: `executed`, `rejected`, `failed`, `indeterminate`, `expired`, `cancelled`, `revoked`. `cancelled` is reserved for verifier-side signed cancellation (Section 6.9.6); `revoked` is reserved for standing authorization grants. Neither is producible by dispatch in this version.
- `issuedAt` required (Timestamp).
- `executionRef` optional.

### From Section 5.3.7 (Timestamp Validation)
- Temporal ordering (`createdAt` < `expiresAt`) is a runtime check.
- Clock-skew tolerance is Verifier-specific.

### From Section 5.3.8 (Replay Protection)
- `actionId.value` must be present (schema-enforced).
- Uniqueness within replay domain is a runtime check.

---

## A.3 Schema Organization

```
schemas/
├── mpas-base-0.2.schema.json               # Combined schema with all $defs (self-contained)
├── definitions.schema.json                  # Shared $defs standalone
├── action-envelope.schema.json
├── signer-review-set.schema.json
├── approval.schema.json
├── canonical-approval-payload.schema.json
├── approval-bundle.schema.json
├── action-package.schema.json
├── authorization-requirements.schema.json
├── execution-receipt.schema.json
└── receipt-payload.schema.json
```

All standalone schemas use `$ref` to definitions. The combined `mpas-base-0.2.schema.json` inlines all `$defs` for environments that cannot resolve external `$ref`.

---

## A.4 JSON Schema Definitions

### A.4.1 Shared Definitions

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://oma3.org/schemas/mpas/base/0.2/definitions.json",
  "title": "MPAS Core v0.2 Shared Definitions",
  "description": "Shared type definitions for MPAS Core v0.2 data structures.",
  "$defs": {
    "DID": {
      "type": "string",
      "pattern": "^did:[a-z0-9]+:[^\\s]+$",
      "description": "A Decentralized Identifier (DID) string. Structural regex only — real DID method support and DID resolution are runtime checks."
    },
    "Timestamp": {
      "type": "string",
      "format": "date-time",
      "pattern": "Z$",
      "description": "RFC 3339 / ISO 8601 UTC timestamp string ending in Z."
    },
    "HashAlgorithm": {
      "type": "string",
      "enum": ["sha-256", "sha-384", "sha-512", "sha3-256", "sha3-384", "sha3-512"],
      "description": "Permitted hash algorithms. sha-256 is mandatory-to-implement. MD5, SHA-1, and algorithms deprecated per NIST SP 800-131A MUST NOT be used."
    },
    "Hash": {
      "type": "object",
      "properties": {
        "alg": { "$ref": "#/$defs/HashAlgorithm" },
        "value": {
          "type": "string",
          "pattern": "^[A-Za-z0-9_-]+$",
          "minLength": 1,
          "description": "Base64url-encoded digest without padding."
        }
      },
      "required": ["alg", "value"],
      "additionalProperties": false
    },
    "Decision": {
      "type": "string",
      "enum": ["propose", "approve", "reject", "abstain"],
      "description": "Core MPAS v0.2 decision values. Verifiers and Applications MAY define additional values under deployment-specific or profile-specific schemas."
    },
    "SignatureObject": {
      "type": "object",
      "description": "Approval signature object. Only JWS format is defined in v0.2.",
      "properties": {
        "format": {
          "type": "string",
          "const": "jws",
          "description": "Signature format. MUST be 'jws' in Core v0.2."
        },
        "value": {
          "type": "string",
          "pattern": "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$",
          "description": "JWS Compact Serialization string (header.payload.signature). Structural regex only — JSON Schema cannot verify JWS header alg/kid, reject alg:none, or verify the cryptographic signature."
        }
      },
      "required": ["format", "value"],
      "additionalProperties": false
    },
    "Version": {
      "type": "string",
      "const": "1",
      "description": "MPAS protocol object version. MUST be '1' for Core v0.2."
    },
    "ActionId": {
      "type": "object",
      "description": "Action identifier with optional replay scope.",
      "properties": {
        "value": {
          "type": "string",
          "minLength": 1,
          "description": "Identifier for the Action. MUST be globally unique unless scope is included."
        },
        "scope": {
          "type": "string",
          "minLength": 1,
          "description": "Replay domain in which actionId.value is unique. Required if value is not globally unique — this condition is runtime-determined."
        }
      },
      "required": ["value"],
      "additionalProperties": false
    }
  }
}
```

### A.4.2 Action Envelope

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://oma3.org/schemas/mpas/base/0.2/action-envelope.json",
  "title": "MPAS Action Envelope",
  "description": "The canonical object approved by Signers. Binds to an Execution Payload by hash, identifies the Proposer, target Application, execution profile, and carries replay/expiration data.",
  "type": "object",
  "properties": {
    "version": { "$ref": "definitions.json#/$defs/Version" },
    "type": {
      "type": "string",
      "const": "ActionEnvelope"
    },
    "proposer": {
      "type": "object",
      "properties": {
        "did": { "$ref": "definitions.json#/$defs/DID" }
      },
      "required": ["did"],
      "additionalProperties": false
    },
    "target": {
      "type": "object",
      "description": "Identifies the Application and resource. Profiles MAY define additional target.* fields (e.g., chainId, namespace, region, tenant).",
      "properties": {
        "applicationDid": { "$ref": "definitions.json#/$defs/DID" },
        "resource": {
          "type": "string",
          "description": "Application-specific resource affected by the Action."
        }
      },
      "required": ["applicationDid"]
    },
    "executionProfile": {
      "type": "object",
      "properties": {
        "id": {
          "$ref": "definitions.json#/$defs/DID",
          "description": "DID identifying the MPAS execution profile."
        },
        "format": {
          "type": "string",
          "description": "Specific payload format under the execution profile (e.g., mcp.toolsCall, evm.transactionRequest)."
        }
      },
      "required": ["id"],
      "additionalProperties": false
    },
    "executionPayloadHash": { "$ref": "definitions.json#/$defs/Hash" },
    "actionId": { "$ref": "definitions.json#/$defs/ActionId" },
    "createdAt": { "$ref": "definitions.json#/$defs/Timestamp" },
    "expiresAt": { "$ref": "definitions.json#/$defs/Timestamp" }
  },
  "required": [
    "version",
    "type",
    "proposer",
    "target",
    "executionProfile",
    "executionPayloadHash",
    "actionId",
    "createdAt",
    "expiresAt"
  ],
  "additionalProperties": false
}
```

### A.4.3 Signer Review Set

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://oma3.org/schemas/mpas/base/0.2/signer-review-set.json",
  "title": "MPAS Signer Review Set",
  "description": "The review package sent to a Signer. Contains the Execution Payload and Action Envelope for review before producing an Approval. Not an authorization artifact.",
  "type": "object",
  "properties": {
    "version": { "$ref": "definitions.json#/$defs/Version" },
    "type": {
      "type": "string",
      "const": "SignerReviewSet"
    },
    "executionPayload": true,
    "actionEnvelope": { "$ref": "action-envelope.json" },
    "authorizationRequirements": {
      "$ref": "authorization-requirements.json",
      "description": "Optional. Verifier-provided requirements included for signer context only."
    }
  },
  "required": ["version", "type", "executionPayload", "actionEnvelope"],
  "additionalProperties": false
}
```

### A.4.4 Approval

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://oma3.org/schemas/mpas/base/0.2/approval.json",
  "title": "MPAS Approval",
  "description": "A signed artifact showing that a Signer approved, rejected, proposed, or abstained regarding an Action Envelope.",
  "type": "object",
  "properties": {
    "version": { "$ref": "definitions.json#/$defs/Version" },
    "type": {
      "type": "string",
      "const": "Approval"
    },
    "actionEnvelopeHash": { "$ref": "definitions.json#/$defs/Hash" },
    "decision": { "$ref": "definitions.json#/$defs/Decision" },
    "signature": { "$ref": "definitions.json#/$defs/SignatureObject" },
    "createdAt": { "$ref": "definitions.json#/$defs/Timestamp" },
    "expiresAt": {
      "$ref": "definitions.json#/$defs/Timestamp",
      "description": "Optional. If absent, inherits actionEnvelope.expiresAt."
    }
  },
  "required": ["version", "type", "actionEnvelopeHash", "decision", "signature", "createdAt"],
  "additionalProperties": false
}
```

### A.4.5 Canonical Approval Payload

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://oma3.org/schemas/mpas/base/0.2/canonical-approval-payload.json",
  "title": "MPAS Canonical Approval Payload",
  "description": "The payload signed inside a JWS Signature Approval. Defines the data binding the Signer's decision to an Action Envelope. This object is JCS-canonicalized (RFC 8785) before encoding as the JWS payload.",
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "ApprovalPayload"
    },
    "actionEnvelopeHash": { "$ref": "definitions.json#/$defs/Hash" },
    "decision": { "$ref": "definitions.json#/$defs/Decision" },
    "signerDid": {
      "$ref": "definitions.json#/$defs/DID",
      "description": "DID of the Signer. REQUIRED when policy evaluates signer identity by DID. MAY be omitted when the signature format directly identifies the Signer authority."
    },
    "createdAt": { "$ref": "definitions.json#/$defs/Timestamp" },
    "expiresAt": {
      "$ref": "definitions.json#/$defs/Timestamp",
      "description": "Optional. Timestamp after which the Approval should no longer be accepted."
    }
  },
  "required": ["type", "actionEnvelopeHash", "decision", "createdAt"],
  "additionalProperties": false
}
```

### A.4.6 Approval Bundle

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://oma3.org/schemas/mpas/base/0.2/approval-bundle.json",
  "title": "MPAS Approval Bundle",
  "description": "Contains Approvals and metadata for an Action Envelope. The existence of an Approval Bundle does not mean the Action is authorized.",
  "type": "object",
  "properties": {
    "version": { "$ref": "definitions.json#/$defs/Version" },
    "type": {
      "type": "string",
      "const": "ApprovalBundle"
    },
    "actionEnvelopeHash": { "$ref": "definitions.json#/$defs/Hash" },
    "approvals": {
      "type": "array",
      "items": { "$ref": "approval.json" },
      "minItems": 1,
      "description": "MUST contain at least the Proposer's Approval."
    },
    "assembledBy": {
      "$ref": "definitions.json#/$defs/DID",
      "description": "Optional. DID of the actor that assembled the Approval Bundle."
    },
    "createdAt": {
      "$ref": "definitions.json#/$defs/Timestamp",
      "description": "Recommended. Timestamp when the Approval Bundle was created."
    }
  },
  "required": ["version", "type", "actionEnvelopeHash", "approvals"],
  "additionalProperties": false
}
```

### A.4.7 Action Package

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://oma3.org/schemas/mpas/base/0.2/action-package.json",
  "title": "MPAS Action Package",
  "description": "The portable package delivered to a Verifier. Contains the Execution Payload, Action Envelope, and Approval Bundle.",
  "type": "object",
  "properties": {
    "version": { "$ref": "definitions.json#/$defs/Version" },
    "type": {
      "type": "string",
      "const": "ActionPackage"
    },
    "executionPayload": true,
    "actionEnvelope": { "$ref": "action-envelope.json" },
    "approvalBundle": { "$ref": "approval-bundle.json" },
    "createdAt": {
      "$ref": "definitions.json#/$defs/Timestamp",
      "description": "Recommended. Timestamp when the Action Package was created."
    }
  },
  "required": ["version", "type", "executionPayload", "actionEnvelope", "approvalBundle"],
  "additionalProperties": false
}
```

### A.4.8 Authorization Requirements

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://oma3.org/schemas/mpas/base/0.2/authorization-requirements.json",
  "title": "MPAS Authorization Requirements",
  "description": "Describes what approvals or conditions are needed for a proposed Action to be accepted by the Verifier. Not a guarantee of future execution.",
  "type": "object",
  "properties": {
    "version": { "$ref": "definitions.json#/$defs/Version" },
    "type": {
      "type": "string",
      "const": "AuthorizationRequirements"
    },
    "actionEnvelopeHash": { "$ref": "definitions.json#/$defs/Hash" },
    "result": {
      "type": "string",
      "enum": [
        "additionalApprovalsRequired",
        "rejected",
        "notSupported",
        "malformed",
        "policyUnavailable"
      ]
    },
    "verifier": {
      "type": "object",
      "properties": {
        "did": { "$ref": "definitions.json#/$defs/DID" }
      },
      "required": ["did"],
      "additionalProperties": false
    },
    "approvalRequirements": {
      "$ref": "#/$defs/ApprovalRequirements",
      "description": "Required when result is 'additionalApprovalsRequired'."
    },
    "policyRef": {
      "type": "string",
      "description": "Optional. Non-authoritative reference to the Verifier's policy."
    },
    "createdAt": {
      "$ref": "definitions.json#/$defs/Timestamp",
      "description": "Recommended."
    },
    "expiresAt": {
      "$ref": "definitions.json#/$defs/Timestamp",
      "description": "Recommended. After this time, the requirements should no longer be relied on."
    }
  },
  "required": ["version", "type", "actionEnvelopeHash", "result", "verifier"],
  "if": {
    "properties": { "result": { "const": "additionalApprovalsRequired" } }
  },
  "then": {
    "required": ["approvalRequirements"]
  },
  "additionalProperties": false,
  "$defs": {
    "ThresholdRequirement": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "const": "threshold"
        },
        "threshold": {
          "type": "integer",
          "minimum": 1
        },
        "eligibleSigners": {
          "type": "array",
          "items": { "$ref": "definitions.json#/$defs/DID" },
          "minItems": 1
        },
        "decision": {
          "$ref": "definitions.json#/$defs/Decision",
          "description": "Decision value that satisfies this requirement. Defaults to 'approve' if omitted."
        },
        "description": {
          "type": "string"
        }
      },
      "required": ["type", "threshold", "eligibleSigners"],
      "additionalProperties": false
    },
    "OverrideSigner": {
      "type": "object",
      "properties": {
        "signer": { "$ref": "definitions.json#/$defs/DID" },
        "permissions": {
          "type": "array",
          "items": { "type": "string", "minLength": 1 },
          "minItems": 1,
          "description": "Override permissions (e.g., 'approve'). Not restricted to the Decision enum."
        },
        "description": { "type": "string" }
      },
      "required": ["signer", "permissions"],
      "additionalProperties": false
    },
    "ApprovalRequirements": {
      "type": "object",
      "description": "Describes approval paths that may satisfy policy. At least one of anyOf, allOf, or overrideSigners MUST be present (strict quality gate).",
      "properties": {
        "anyOf": {
          "type": "array",
          "items": { "$ref": "#/$defs/ThresholdRequirement" },
          "minItems": 1,
          "description": "Alternative approval paths. If any path is satisfied, the Action may be authorized."
        },
        "allOf": {
          "type": "array",
          "items": { "$ref": "#/$defs/ThresholdRequirement" },
          "minItems": 1,
          "description": "Approval paths that must all be satisfied."
        },
        "overrideSigners": {
          "type": "array",
          "items": { "$ref": "#/$defs/OverrideSigner" },
          "minItems": 1,
          "description": "Signers with privileged authority to approve outside ordinary threshold paths."
        }
      },
      "anyOf": [
        { "required": ["anyOf"] },
        { "required": ["allOf"] },
        { "required": ["overrideSigners"] }
      ],
      "additionalProperties": false
    }
  }
}
```

### A.4.9 Execution Receipt

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://oma3.org/schemas/mpas/base/0.2/execution-receipt.json",
  "title": "MPAS Execution Receipt",
  "description": "A signed statement that an Action was executed, rejected, failed, indeterminate, expired, cancelled, revoked, or otherwise resolved.",
  "type": "object",
  "properties": {
    "version": { "$ref": "definitions.json#/$defs/Version" },
    "type": {
      "type": "string",
      "const": "ExecutionReceipt"
    },
    "format": {
      "type": "string",
      "const": "jws",
      "description": "Signature format. MUST be 'jws' in Core v0.2."
    },
    "signature": {
      "type": "string",
      "pattern": "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$",
      "description": "JWS Compact Serialization string containing the signed Receipt Payload."
    }
  },
  "required": ["version", "type", "format", "signature"],
  "additionalProperties": false
}
```

### A.4.10 Receipt Payload

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://oma3.org/schemas/mpas/base/0.2/receipt-payload.json",
  "title": "MPAS Receipt Payload",
  "description": "The payload signed inside a JWS Execution Receipt. Binds the resolution result to the Action Envelope and Execution Payload. This object is JCS-canonicalized (RFC 8785) before encoding as the JWS payload.",
  "type": "object",
  "properties": {
    "issuerDid": { "$ref": "definitions.json#/$defs/DID" },
    "actionEnvelopeHash": { "$ref": "definitions.json#/$defs/Hash" },
    "executionPayloadHash": { "$ref": "definitions.json#/$defs/Hash" },
    "actionId": {
      "$ref": "definitions.json#/$defs/ActionId",
      "description": "Recommended. Action ID from the Action Envelope."
    },
    "proposerDid": {
      "$ref": "definitions.json#/$defs/DID",
      "description": "Recommended. DID of the Proposer."
    },
    "result": {
      "type": "string",
      "enum": ["executed", "rejected", "failed", "indeterminate", "expired", "cancelled", "revoked"],
      "description": "Core v0.2 result values. `cancelled` is reserved for verifier-side signed cancellation (Section 6.9.6); `revoked` is reserved for standing authorization grants; neither is producible by dispatch in this version. Verifiers and Applications MAY define additional values under deployment-specific schemas."
    },
    "issuedAt": { "$ref": "definitions.json#/$defs/Timestamp" },
    "executionRef": {
      "type": "string",
      "description": "Optional. Application-specific execution reference (transaction hash, request ID, etc.)."
    }
  },
  "required": ["issuerDid", "actionEnvelopeHash", "executionPayloadHash", "result", "issuedAt"],
  "additionalProperties": false
}
```

---

## A.5 Requirements JSON Schema CAN Enforce

| #   | Requirement                                                                                                                             | Schema Mechanism                                                      |
| :-- | :-------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------- |
| 1   | All protocol objects MUST include `version` with value `"1"`                                                                            | `const: "1"` on version field                                         |
| 2   | Each object MUST include its `type` discriminator                                                                                       | `const` on type field                                                 |
| 3   | `executionPayloadHash` MUST be a Hash object with `alg` and `value`                                                                     | `$ref` to Hash with required fields and `additionalProperties: false` |
| 4   | Hash `alg` MUST NOT be MD5, SHA-1, or deprecated                                                                                        | `enum` restricted to safe algorithms                                  |
| 5   | Hash `value` MUST be base64url-encoded without padding                                                                                  | `pattern` restricting to base64url charset                            |
| 6   | Action Envelope MUST include `proposer.did`, `target.applicationDid`, `executionProfile.id`, `actionId.value`, `createdAt`, `expiresAt` | `required` array                                                      |
| 7   | DID fields MUST be structurally valid DIDs                                                                                              | `pattern: "^did:[a-z0-9]+:[^\\s]+$"`                                  |
| 8   | Timestamps MUST be RFC 3339 UTC ending in Z                                                                                             | `format: "date-time"` + `pattern: "Z$"`                               |
| 9   | Approval MUST include `actionEnvelopeHash`, `decision`, `signature`, `createdAt`                                                        | `required` array                                                      |
| 10  | Approval `decision` MUST be a Core v0.2 value                                                                                           | `enum: ["propose", "approve", "reject", "abstain"]`                   |
| 11  | Signature `format` MUST be `"jws"` in v0.2                                                                                              | `const: "jws"`                                                        |
| 12  | JWS `value` MUST be JWS Compact Serialization                                                                                           | `pattern` for three dot-separated base64url segments                  |
| 13  | Signature object MUST NOT have extra fields (no `payload`)                                                                              | `additionalProperties: false`                                         |
| 14  | Approval Bundle `approvals` MUST be non-empty                                                                                           | `minItems: 1`                                                         |
| 15  | Action Package MUST include `executionPayload`, `actionEnvelope`, `approvalBundle`                                                      | `required` array                                                      |
| 16  | Authorization Requirements `result` MUST be a defined enum value                                                                        | `enum`                                                                |
| 17  | `approvalRequirements` MUST be present when result is `additionalApprovalsRequired`                                                     | `if/then` conditional                                                 |
| 18  | Threshold Requirement `threshold` MUST be a positive integer                                                                            | `type: integer`, `minimum: 1`                                         |
| 19  | Threshold Requirement `eligibleSigners` MUST be non-empty array of DIDs                                                                 | `minItems: 1` + DID items                                             |
| 20  | ApprovalRequirements MUST have at least one of `anyOf`, `allOf`, `overrideSigners`                                                      | `anyOf` with required checks                                          |
| 21  | Override Signer `permissions` MUST be non-empty                                                                                         | `minItems: 1`                                                         |
| 22  | Execution Receipt `format` MUST be `"jws"`                                                                                              | `const: "jws"`                                                        |
| 23  | Execution Receipt `signature` MUST be JWS Compact Serialization                                                                         | `pattern`                                                             |
| 24  | Receipt Payload MUST include `issuerDid`, `actionEnvelopeHash`, `executionPayloadHash`, `result`, `issuedAt`                            | `required`                                                            |
| 25  | Receipt Payload `result` MUST be a Core v0.2 value                                                                                      | `enum`                                                                |
| 26  | Canonical Approval Payload `type` MUST be `"ApprovalPayload"`                                                                           | `const`                                                               |
| 27  | `executionProfile.id` MUST be a DID                                                                                                     | `$ref` to DID definition                                              |
| 28  | Core protocol objects MUST NOT contain undeclared fields                                                                                | `additionalProperties: false` (except `target`)                       |

---

## A.6 Requirements JSON Schema CANNOT Fully Enforce

| #   | Requirement                                                                                     | Reason                                                                                      |
| :-- | :---------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------ |
| 1   | Execution Payload hash MUST match `actionEnvelope.executionPayloadHash`                         | Requires computing a profile-defined hash over the payload at runtime.                      |
| 2   | All Approvals in a bundle MUST bind to the same Action Envelope hash                            | Cross-element equality across array items is not expressible in JSON Schema.                |
| 3   | `approvalBundle.actionEnvelopeHash` MUST match the computed hash of `actionEnvelope`            | Requires computing a hash of a sibling field.                                               |
| 4   | Approval `createdAt` MUST NOT be after `actionEnvelope.expiresAt`                               | Temporal comparison across different objects.                                               |
| 5   | Approval `createdAt` SHOULD NOT be before `actionEnvelope.createdAt`                            | Same — cross-object temporal comparison.                                                    |
| 6   | Action Envelope MUST NOT be expired at verification time                                        | Requires comparing `expiresAt` to the system clock.                                         |
| 7   | `expiresAt` MUST be after `createdAt`                                                           | Temporal ordering within the same object — not reliably enforceable in JSON Schema 2020-12. |
| 8   | `actionId` in the dispatch ledger is dispatched at most once (ledgered different-hash or resolved → reject)             | Stateful lookup requirement (Section 6.9).                                                  |
| 9   | Replay state MUST be retained until `expiresAt` + tolerance                                     | Operational/storage requirement.                                                            |
| 10  | JWS `alg` header MUST NOT be `"none"`                                                           | Inside base64url-encoded JWS header; outer schema cannot inspect.                           |
| 11  | JWS header MUST contain `alg` and `kid`                                                         | Same — inside JWS compact string.                                                           |
| 12  | Signing key MUST be authorized for the Signer DID                                               | Requires DID resolution, key registry, or OMATrust lookup.                                  |
| 13  | Top-level Approval `actionEnvelopeHash`/`decision` MUST match signed Canonical Approval Payload | Requires JWS decode + field comparison.                                                     |
| 14  | A nondeterministic LLM MUST NOT be the sole authorization authority                             | Architectural constraint.                                                                   |
| 15  | Verifier MUST reject Approvals from unauthorized signers                                        | Policy + identity verification at runtime.                                                  |
| 16  | `actionId.scope` is REQUIRED if `actionId.value` is not globally unique                         | Global uniqueness is semantic, not structurally determinable.                               |
| 17  | Verifier MUST be authorized for declared `target.applicationDid`                                | Runtime configuration check.                                                                |
| 18  | MPAS objects MUST be JCS-canonicalized (RFC 8785) before hashing/signing                        | Processing requirement, not structural.                                                     |
| 19  | Duplicate JSON keys MUST be rejected                                                            | Requires conformance-mode parser; most parsers silently accept duplicates.                  |
| 20  | Credential Adapter MUST NOT allow Execution Payload to select credentials                       | Implementation architecture constraint.                                                     |
| 21  | EdDSA MUST be supported by conforming JWS implementations                                       | Implementation capability.                                                                  |
| 22  | Receipt signing key MUST be authorized for `issuerDid`                                          | Runtime key-authorization check.                                                            |
| 23  | Verifier MUST reject unsupported or unrecognized hash algorithms                                | Runtime algorithm-support check (schema only covers the known-safe enum).                   |

---

## A.7 Test Vectors

### A.7.1 Valid Examples

#### Valid 1: Minimal Action Envelope

```json
{
  "version": "1",
  "type": "ActionEnvelope",
  "proposer": {
    "did": "did:web:agent.example.com"
  },
  "target": {
    "applicationDid": "did:web:github-mcp.example"
  },
  "executionProfile": {
    "id": "did:web:profiles.oma3.org:mcp"
  },
  "executionPayloadHash": {
    "alg": "sha-256",
    "value": "dGVzdC1oYXNoLXZhbHVl"
  },
  "actionId": {
    "value": "urn:uuid:3f82f6e1-135e-44c5-90a9-58f760f6d9f1"
  },
  "createdAt": "2026-05-27T18:00:00.000Z",
  "expiresAt": "2026-05-27T19:00:00.000Z"
}
```

**Why it passes:** All required fields present. Correct `type` and `version` constants. Valid DID syntax. Valid Hash object with permitted algorithm. Valid RFC 3339 UTC timestamps. Valid actionId. No undeclared fields.

---

#### Valid 2: Action Envelope with optional fields and profile-specific target

```json
{
  "version": "1",
  "type": "ActionEnvelope",
  "proposer": {
    "did": "did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Ims2TzdjaVFrbXBodUVFdDFpM3lBaW1KSldlR0ttT3EzdF9mc05renphNm8ifQ"
  },
  "target": {
    "applicationDid": "did:web:vault.acme.corp",
    "resource": "account:treasury:main",
    "chainId": "eip155:1"
  },
  "executionProfile": {
    "id": "did:web:profiles.oma3.org:evm",
    "format": "evm.transactionRequest"
  },
  "executionPayloadHash": {
    "alg": "sha-256",
    "value": "LCa0a2j_xo_5m0U8HTBBNBNCLXBkg7-g-YpeiGJm564"
  },
  "actionId": {
    "scope": "eip155:1:0x1234567890abcdef1234567890abcdef12345678",
    "value": "42"
  },
  "createdAt": "2026-06-01T12:00:00.000Z",
  "expiresAt": "2026-06-01T12:30:00.000Z"
}
```

**Why it passes:** All required fields present. `target` includes profile-specific `chainId` — allowed because `target` does not have `additionalProperties: false`. Uses `did:jwk` (matches DID pattern). Includes optional `format` and scoped `actionId`.

---

#### Valid 3: Approval with JWS signature and optional expiresAt

```json
{
  "version": "1",
  "type": "Approval",
  "actionEnvelopeHash": {
    "alg": "sha-256",
    "value": "dGVzdC1lbnZlbG9wZS1oYXNo"
  },
  "decision": "approve",
  "signature": {
    "format": "jws",
    "value": "eyJhbGciOiJFZERTQSIsImtpZCI6ImRpZDp3ZWI6YWxpY2UuZXhhbXBsZSNrZXktMSJ9.eyJ0eXBlIjoiQXBwcm92YWxQYXlsb2FkIn0.c2lnbmF0dXJl"
  },
  "createdAt": "2026-05-27T18:10:00.000Z",
  "expiresAt": "2026-05-27T19:00:00.000Z"
}
```

**Why it passes:** All required fields present. `signature.format` is `"jws"`. `signature.value` matches JWS compact pattern (three base64url segments). `decision` is valid enum value. Timestamps are UTC. Optional `expiresAt` included. No undeclared fields.

---

#### Valid 4: Authorization Requirements with threshold and override signers

```json
{
  "version": "1",
  "type": "AuthorizationRequirements",
  "actionEnvelopeHash": {
    "alg": "sha-256",
    "value": "dGVzdC1lbnZlbG9wZS1oYXNo"
  },
  "result": "additionalApprovalsRequired",
  "verifier": {
    "did": "did:web:verifier.acme.corp"
  },
  "approvalRequirements": {
    "anyOf": [
      {
        "type": "threshold",
        "threshold": 2,
        "eligibleSigners": [
          "did:web:alice.example.com",
          "did:web:bob.example.com",
          "did:web:carol.example.com"
        ],
        "decision": "approve",
        "description": "Requires approval from at least 2 maintainers."
      }
    ],
    "overrideSigners": [
      {
        "signer": "did:web:cto.acme.corp",
        "permissions": ["approve"],
        "description": "CTO can unilaterally approve any action."
      }
    ]
  },
  "createdAt": "2026-05-27T18:05:00.000Z",
  "expiresAt": "2026-05-27T19:00:00.000Z"
}
```

**Why it passes:** `result` is `"additionalApprovalsRequired"` and `approvalRequirements` is present (satisfying `if/then`). ApprovalRequirements has `anyOf` (satisfying the at-least-one-of check). ThresholdRequirement has all required fields. OverrideSigner has non-empty `permissions`. All DIDs match pattern.

---

#### Valid 5: Complete Action Package with opaque execution payload

```json
{
  "version": "1",
  "type": "ActionPackage",
  "executionPayload": {
    "name": "merge_pull_request",
    "arguments": {
      "owner": "oma3dao",
      "repo": "app-registry",
      "pullNumber": 42,
      "baseRef": "main",
      "expectedHeadSha": "abc123",
      "mergeMethod": "squash"
    }
  },
  "actionEnvelope": {
    "version": "1",
    "type": "ActionEnvelope",
    "proposer": {
      "did": "did:web:agent.example.com"
    },
    "target": {
      "applicationDid": "did:web:github-mcp.example",
      "resource": "repo:oma3dao/app-registry"
    },
    "executionProfile": {
      "id": "did:web:profiles.oma3.org:mcp",
      "format": "mcp.toolsCall"
    },
    "executionPayloadHash": {
      "alg": "sha-256",
      "value": "LCa0a2j_xo_5m0U8HTBBNBNCLXBkg7-g-YpeiGJm564"
    },
    "actionId": {
      "value": "urn:uuid:3f82f6e1-135e-44c5-90a9-58f760f6d9f1"
    },
    "createdAt": "2026-05-27T18:00:00.000Z",
    "expiresAt": "2026-05-27T19:00:00.000Z"
  },
  "approvalBundle": {
    "version": "1",
    "type": "ApprovalBundle",
    "actionEnvelopeHash": {
      "alg": "sha-256",
      "value": "dGVzdC1lbnZlbG9wZS1oYXNo"
    },
    "approvals": [
      {
        "version": "1",
        "type": "Approval",
        "actionEnvelopeHash": {
          "alg": "sha-256",
          "value": "dGVzdC1lbnZlbG9wZS1oYXNo"
        },
        "decision": "propose",
        "signature": {
          "format": "jws",
          "value": "eyJhbGciOiJFZERTQSIsImtpZCI6ImRpZDp3ZWI6YWdlbnQuZXhhbXBsZS5jb20ja2V5LTEifQ.cGF5bG9hZA.c2lnbmF0dXJl"
        },
        "createdAt": "2026-05-27T18:00:00.000Z"
      }
    ],
    "createdAt": "2026-05-27T18:01:00.000Z"
  },
  "createdAt": "2026-05-27T18:01:00.000Z"
}
```

**Why it passes:** Complete Action Package. `executionPayload` is an arbitrary JSON object (unconstrained by Core — `true` schema accepts anything). Nested `actionEnvelope` and `approvalBundle` each pass their respective schemas. Approvals array has one entry (Proposer's `"propose"` decision), satisfying `minItems: 1`.

---

### A.7.2 Invalid Examples

#### Invalid 1: Action Envelope missing required `expiresAt`

```json
{
  "version": "1",
  "type": "ActionEnvelope",
  "proposer": { "did": "did:web:agent.example.com" },
  "target": { "applicationDid": "did:web:github-mcp.example" },
  "executionProfile": { "id": "did:web:profiles.oma3.org:mcp" },
  "executionPayloadHash": { "alg": "sha-256", "value": "dGVzdC1oYXNoLXZhbHVl" },
  "actionId": { "value": "urn:uuid:3f82f6e1-135e-44c5-90a9-58f760f6d9f1" },
  "createdAt": "2026-05-27T18:00:00.000Z"
}
```

**Why it fails:** Missing required `expiresAt`. The spec states "An Action Envelope MUST include `expiresAt`."

---

#### Invalid 2: Approval with prohibited hash algorithm `sha-1`

```json
{
  "version": "1",
  "type": "Approval",
  "actionEnvelopeHash": { "alg": "sha-1", "value": "dGVzdC1oYXNoLXZhbHVl" },
  "decision": "approve",
  "signature": { "format": "jws", "value": "eyJhbGciOiJFZERTQSJ9.cGF5bG9hZA.c2ln" },
  "createdAt": "2026-05-27T18:10:00.000Z"
}
```

**Why it fails:** `actionEnvelopeHash.alg` is `"sha-1"` — not in the permitted `HashAlgorithm` enum. Section 5.1.4: "Implementations MUST NOT use MD5, SHA-1, or other algorithms known to be vulnerable."

---

#### Invalid 3: Approval Bundle with empty `approvals` array

```json
{
  "version": "1",
  "type": "ApprovalBundle",
  "actionEnvelopeHash": { "alg": "sha-256", "value": "dGVzdC1lbnZlbG9wZS1oYXNo" },
  "approvals": []
}
```

**Why it fails:** `approvals` is empty. Section 5.6.2: "An Approval Bundle MUST contain at least the Proposer's Approval." Schema enforces `minItems: 1`.

---

#### Invalid 4: Authorization Requirements — `additionalApprovalsRequired` without `approvalRequirements`

```json
{
  "version": "1",
  "type": "AuthorizationRequirements",
  "actionEnvelopeHash": { "alg": "sha-256", "value": "dGVzdC1lbnZlbG9wZS1oYXNo" },
  "result": "additionalApprovalsRequired",
  "verifier": { "did": "did:web:verifier.acme.corp" },
  "createdAt": "2026-05-27T18:05:00.000Z"
}
```

**Why it fails:** `result` is `"additionalApprovalsRequired"` but `approvalRequirements` is absent. Section 5.8.3: "Required when `result` is `additionalApprovalsRequired`." Schema `if/then` enforces this.

---

#### Invalid 5: Approval with wrong `version` and non-JWS signature format

```json
{
  "version": "2",
  "type": "Approval",
  "actionEnvelopeHash": { "alg": "sha-256", "value": "dGVzdC1lbnZlbG9wZS1oYXNo" },
  "decision": "approve",
  "signature": { "format": "eip712", "value": "0x1234abcdef" },
  "createdAt": "2026-05-27T18:10:00.000Z"
}
```

**Why it fails:** Three violations: (1) `version` is `"2"` but MUST be `"1"`; (2) `signature.format` is `"eip712"` but MUST be `"jws"`; (3) `signature.value` does not match JWS compact pattern.

---

#### Invalid 6: Action Envelope with non-DID `proposer.did`

```json
{
  "version": "1",
  "type": "ActionEnvelope",
  "proposer": { "did": "https://agent.example.com" },
  "target": { "applicationDid": "did:web:github-mcp.example" },
  "executionProfile": { "id": "did:web:profiles.oma3.org:mcp" },
  "executionPayloadHash": { "alg": "sha-256", "value": "dGVzdC1oYXNoLXZhbHVl" },
  "actionId": { "value": "urn:uuid:3f82f6e1-135e-44c5-90a9-58f760f6d9f1" },
  "createdAt": "2026-05-27T18:00:00.000Z",
  "expiresAt": "2026-05-27T19:00:00.000Z"
}
```

**Why it fails:** `proposer.did` is `"https://agent.example.com"` — does not match `^did:[a-z0-9]+:[^\s]+$`.

---

#### Invalid 7: Execution Receipt with undeclared `payload` field

```json
{
  "version": "1",
  "type": "ExecutionReceipt",
  "format": "jws",
  "signature": "eyJhbGciOiJFZERTQSJ9.cGF5bG9hZA.c2ln",
  "payload": "should-not-be-here"
}
```

**Why it fails:** `additionalProperties: false` rejects the undeclared `payload` field. Section 5.9.6: "`payload` MUST be omitted."

---

## A.8 Profile-Native Execution Payload Schemas

MPAS Core schemas intentionally do **not** define or constrain the `executionPayload` field beyond requiring its presence. This preserves the Core design principle that:

- Execution Payloads are profile-native (Section 5.2).
- Each execution profile defines the payload shape, hashing rules, and interpretation semantics (Section 5.2.2).
- The base MPAS specification does not define universal Execution Payload fields (Section 5.2.3).

Profile-specific JSON Schemas (e.g., an MCP execution profile schema, an EVM execution profile schema) SHOULD be defined by their respective profile specifications. A validation implementation MAY compose the Core Action Package schema with a profile-specific payload schema at runtime using `actionEnvelope.executionProfile.id` and `actionEnvelope.executionProfile.format` to select the appropriate payload schema.

Example composition approach:

```javascript
// Runtime payload schema selection (pseudocode)
const profileSchemaMap = {
  "did:web:profiles.oma3.org:mcp": mcpPayloadSchema,
  "did:web:profiles.oma3.org:evm": evmPayloadSchema,
};
const profileId = actionPackage.actionEnvelope.executionProfile.id;
const payloadSchema = profileSchemaMap[profileId];
if (payloadSchema) {
  validate(actionPackage.executionPayload, payloadSchema);
}
```

This two-layer validation approach (Core structure + profile payload) preserves the separation of concerns defined in the specification. The Core schema guarantees structural integrity of the MPAS protocol objects. The profile schema guarantees correctness of the domain-specific execution instruction.
