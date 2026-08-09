# MCP OAuth SDK requirement ownership

**Status:** Phase 0A spike result
**SDK:** `@modelcontextprotocol/sdk` 1.30.0

This matrix records the boundary observed by the first deterministic conformance
test. “SDK” means the official MCP TypeScript SDK provides the mechanism;
it does not waive the corresponding requirement in [spec.md](./spec.md).

| Concern | Primary owner | Spike evidence / remaining work |
| :--- | :--- | :--- |
| Protected-resource challenge and RFC 9728 discovery | SDK | The transport consumes `WWW-Authenticate resource_metadata` and discovers the fixture resource metadata. Add malicious URL, redirect, size, and timeout cases. |
| RFC 8414/OIDC authorization-server discovery | SDK + CA fetch policy | SDK discovers the path-bearing fixture issuer. The CA must enforce bounded fetches and record exact-order/issuer-negative cases. |
| PKCE S256 and authorization URL construction | SDK | The test verifies the saved verifier, derived S256 challenge, redirect URI, state, scope, and exact resource indicator. The CA owns authorization-session entropy, expiry, and single use. |
| Static client information, CIMD, and deprecated DCR | SDK + CA policy | SDK supplies the protocol mechanisms. CA configuration owns mode selection, static precedence, fail-closed behavior, and CIMD publication. Dedicated CIMD/DCR cases remain. |
| Authorization-code exchange and resource indicator | SDK | The fixture rejects an exchange without the exact resource or verifier; the test observes both. The CA validates callback state/issuer/session before calling `finishAuth`. |
| Token refresh and rotation | SDK + CA store | SDK supplies refresh requests. The CA owns encrypted persistence, single-flight refresh, atomic rotation, binding, invalidation, and crash recovery. |
| Bearer authentication on Streamable HTTP | SDK | The test reconnects with stored tokens and verifies the MCP initialize/tool lifecycle reaches the exact resource with the Bearer token. Redirect and post-dispatch 401 cases remain CA/transport-policy work. |
| Browser and operator interaction | CA operator plane | The SDK invokes `redirectToAuthorization`; the CA provider must return an operator command on agent paths and may open a browser only from the operator-executed login command. |
| HTTPS, redirect, response-size, timeout, and header-forwarding limits | CA fetch/transport policy | Not delegated to SDK defaults. Implement and test a bounded custom `fetch` wrapper before production use. |
| Application DID/resource/issuer/client/scope binding | CA session service | Persist and validate the complete tuple; tokens remain opaque. |
| MPAS verification, approval, ledger boundary, and replay rules | Credential Adapter | OAuth never satisfies MPAS authorization. Preparation occurs only after policy satisfaction, and no tool call is automatically replayed after possible transmission. |
| Secret storage, redaction, audit, logout, and revocation | Credential Adapter | Outside the SDK provider contract and deferred to the secure-store/operator slices. |

## Decision

Use the official MCP SDK as the sole general-purpose OAuth implementation for
the reference TypeScript CA. No demonstrated gap currently justifies adding
`oauth4webapi`. Add narrow CA validation or transport-policy wrappers as the
remaining negative conformance cases identify them.
