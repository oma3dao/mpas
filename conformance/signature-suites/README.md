# Signature-suite conformance

MPAS defines Ed25519/EdDSA and P-256/ES256. Every verifier implements both;
signing implementations may choose either. These fixtures cover Core §5.5.6.1
and HTTP profile §4.6.2 without changing artifact schemas.

`p256.json` contains the minimal public JWK, JCS bytes, exact `did:jwk`, public
test private key, Action Envelope and Execution Payload, canonical Approval and
receipt payloads, and signed artifacts. The P-256 private scalar is the public
test value **1**; it is unsuitable for any real identity. It gives a stable key
and DID. The committed ECDSA signatures are fixed verification inputs, not a
requirement for future signers to reproduce those same bytes.

The generation script uses Node crypto directly, without MPAS signer helpers:

```sh
node sdk/protocol/tests/scripts/generate-suite-vectors.mjs
```

Run from the repository root after installing SDK dependencies. Generation is an
explicit maintenance action, never a CI step. It rewrites the P-256 fixture and
the two new HTTP fixtures. It does not rewrite original Ed25519 fixtures.
`generatedWith` records Node/OpenSSL versions. JSON payload canonicalization uses
the repository's pinned `json-canonicalize` implementation.

## Independent verification

```sh
node conformance/signature-suites/verify-openssl.mjs
```

This script invokes the OpenSSL CLI to verify the committed Approval, receipt,
and HTTP signatures, and asserts that altered signing inputs fail. It imports
neither MPAS code nor `jose`. For JWS it verifies the ASCII `header.payload`
signing input; for HTTP it verifies the fixture's exact UTF-8 signature base.
SHA-256 is applied by `openssl dgst -sha256`. The script translates raw `R || S`
to DER solely because the OpenSSL CLI expects DER, and exports the public JWK to
SPKI PEM. MPAS wire verifiers continue to reject DER.

Initial independent check: OpenSSL 3.6.3 (9 Jun 2026). The command reports its
actual version on each run and executes in required CI. It needs no credentials,
network service, hardware, or production key material.

## Automated coverage

- `sdk/protocol/tests/lib/signature-suites.test.ts`: closed suites, key validation,
  optional DID metadata, local private/public consistency, explicit generation,
  non-exporting Web Crypto signing, JWS binding, raw encoding, fixed vectors,
  and HTTP algorithm/default checks.
- `sdk/protocol/tests/lib/rfc9421.test.ts` and `rfc9421-vectors.test.ts`: existing
  Ed25519 fixture and RFC 9421 B.2.6, selection, digests, audiences, freshness,
  nonce storage, and negative authentication cases.
- `cli/tests/e2e/signature-suites.test.ts`: authenticated mixed-suite
  Approval workflow, configured-key comparison including `y`, verifier-side
  allow-list rejection, execution, receipt verification, replay rejection, and CLI.
- `bridge-generator/tests/signature-suites.test.ts`: build generated TypeScript
  against the candidate SDK, verify P-256 direct and relay submission signatures,
  and exercise authenticated relay polling.

The original Ed25519 artifact fixtures remain in `sdk/protocol/tests/fixtures/`.
Both suites use identical payload canonicalization; only identity and signature
fields change when participants deliberately register a different key.
