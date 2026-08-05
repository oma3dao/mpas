import { describe, expect, it } from "vitest";
import { listLinkedIdentifiers } from "../../src/adapter/trust-linkage.js";
import type { TrustContext } from "../../src/adapter/trust.js";
import {
  artifactDid,
  makeArtifactTrustResponse,
  makeEvidence,
} from "./artifact-trust-fixture.js";

const context: TrustContext = {
  artifactTrustApiUrl: "https://backend.omatrust.example/artifact-trust",
  expectedChain: {
    chainId: 6623,
    easContract: "0x00Bd6f0Ee99bD76273B57e6dDEc5B00850c6b76C",
  },
};
describe("listLinkedIdentifiers", () => {
  it("returns an empty list when no verified linked identifier exists", async () => {
    const result = await listLinkedIdentifiers(
      artifactDid,
      context,
      makeArtifactTrustResponse(),
    );

    expect(result).toEqual([]);
  });

  it("lists a verified linked identifier without applying target policy", async () => {
    const targetDid = "did:web:github.example";
    const linked = makeEvidence(
      "linked-identifier",
      {
        data: {
          subject: artifactDid,
          linkedId: targetDid,
        },
      },
      ["proof", "controller-authorization", "authorization-window"],
    );
    const result = await listLinkedIdentifiers(
      artifactDid,
      context,
      makeArtifactTrustResponse({
        otherAttestations: [linked],
        summary: {
          totalQueried: 1,
          totalVerified: 1,
          totalExcluded: 0,
          complete: true,
        },
      }),
    );

    expect(result).toEqual([
      expect.objectContaining({
        linkedId: targetDid,
        verificationBasis: [
          "proof",
          "controller-authorization",
          "authorization-window",
        ],
      }),
    ]);
  });

  it("lists every verified identifier even when it differs from the configured application", async () => {
    const linked = makeEvidence("linked-identifier", {
      data: {
        subject: artifactDid,
        linkedId: "did:web:different.example",
      },
    });
    const result = await listLinkedIdentifiers(
      artifactDid,
      context,
      makeArtifactTrustResponse({
        otherAttestations: [linked],
        summary: {
          totalQueried: 1,
          totalVerified: 1,
          totalExcluded: 0,
          complete: true,
        },
      }),
    );

    expect(result.map((item) => item.linkedId)).toEqual([
      "did:web:different.example",
    ]);
  });

  it("does not expose non-linked-identifier evidence", async () => {
    const result = await listLinkedIdentifiers(
      artifactDid,
      context,
      makeArtifactTrustResponse({
        otherAttestations: [makeEvidence("future-schema")],
        summary: {
          totalQueried: 1,
          totalVerified: 1,
          totalExcluded: 0,
          complete: true,
        },
      }),
    );

    expect(result).toEqual([]);
  });
});
