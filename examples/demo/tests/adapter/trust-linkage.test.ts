import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });
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

  it("skips wrong subject and non-string linkedId values", async () => {
    const result = await listLinkedIdentifiers(
      artifactDid,
      context,
      makeArtifactTrustResponse({
        otherAttestations: [
          makeEvidence("linked-identifier", {
            data: { subject: "did:artifact:other", linkedId: "did:web:ok.example" },
          }),
          makeEvidence("linked-identifier", {
            data: { subject: artifactDid, linkedId: 123 as unknown as string },
          }),
        ],
      }),
    );

    expect(result).toEqual([]);
  });

  it("includes attesterLabel when present and omits it otherwise", async () => {
    const withLabel = makeEvidence("linked-identifier", {
      data: { subject: artifactDid, linkedId: "did:web:labeled.example" },
      attesterLabel: "Trusted Lab",
    });
    const withoutLabel = makeEvidence("linked-identifier", {
      data: { subject: artifactDid, linkedId: "did:web:plain.example" },
      attesterLabel: undefined,
    });
    const result = await listLinkedIdentifiers(
      artifactDid,
      context,
      makeArtifactTrustResponse({ otherAttestations: [withLabel, withoutLabel] }),
    );

    expect(result).toEqual([
      expect.objectContaining({
        linkedId: "did:web:labeled.example",
        attesterLabel: "Trusted Lab",
      }),
      expect.objectContaining({
        linkedId: "did:web:plain.example",
      }),
    ]);
    expect(result[1]).not.toHaveProperty("attesterLabel");
  });

  it("fetches artifact trust when the response is omitted", async () => {
    const linked = makeEvidence("linked-identifier", {
      data: { subject: artifactDid, linkedId: "did:web:fetched.example" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify(
            makeArtifactTrustResponse({
              otherAttestations: [linked],
              summary: { totalQueried: 1, totalVerified: 1, totalExcluded: 0, complete: true },
            }),
          ),
          { status: 200 },
        ),
      ),
    );

    const result = await listLinkedIdentifiers(artifactDid, context);
    expect(result).toEqual([expect.objectContaining({ linkedId: "did:web:fetched.example" })]);
  });
});
