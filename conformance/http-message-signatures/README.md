# MPAS HTTP Message Signature Fixtures

`mpas-v1-ed25519.json` fixes the MPAS v1 covered-component set, signature-parameter order, Content-Digest serialization, and Ed25519 output for a deterministic Coordination Poll request.

The MPAS fixture is checked only after the independent RFC 9421 Appendix B.2.6 known-answer gate in `sdk/protocol/tests/fixtures/rfc9421-b2.6.json`. The RFC fixture detects shared signature-base defects; this fixture detects drift in the MPAS application profile.

The private key used to reproduce the MPAS fixture is the committed SDK `proposer.json` test key. Only its public JWK is repeated here.
