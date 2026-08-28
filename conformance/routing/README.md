# Routing and Notification Conformance

The routing conformance cases are executable tests in the SDK and demo packages:

- `sdk/protocol/tests/lib/routing.test.ts` covers envelope structure, multi-recipient behavior, Action payload discrimination, layered idempotency equivalence, regenerated routing metadata, and fail-closed unknown scopes.
- `sdk/protocol/tests/lib/approval-requirements.test.ts` covers satisfied, pending, and unreachable approval expressions, immutable-decision conflicts, and override authority.
- `sdk/protocol/tests/lib/routing-clients.test.ts` covers common Action submission, Verifier polling and response delivery, and notification client context.
- `examples/demo/tests/coordination/routing.test.ts` covers the complete relayed Action round trip, designated-Verifier membership, recipient isolation, response correlation, expired-envelope rejection, bounded relay retry, hash-binding validation, requirements validation, idempotent envelope rebuilding, and capped delivery polling.
- `examples/demo/tests/coordination/store.test.ts` covers first-decision-final coordination, unreachable-workflow rejection, and pre-creation Action/requirements validation.
- `examples/demo/tests/coordination/websocket.test.ts` covers one-use tickets, notification-on-connect for outstanding work, and explicit `404` rejection of wrong-path upgrades.
- `examples/demo/tests/adapter/adapter-api-server.test.ts` covers the required direct-Verifier enveloped and bare request forms implemented by the demo Credential Adapter.

These cases supplement the existing HTTP Message Signature vectors under `conformance/http-message-signatures/`. RFC 9421 authentication, DID equality, nonce ordering, and generic error behavior remain covered by `examples/demo/tests/coordination/coordination-auth.test.ts`.
