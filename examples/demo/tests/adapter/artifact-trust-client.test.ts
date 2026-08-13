import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchArtifactTrust,
  parseArtifactTrustResponse,
} from "../../src/adapter/artifact-trust-client.js";
import {
  artifactDid,
  makeArtifactTrustResponse,
  makeEvidence,
} from "./artifact-trust-fixture.js";

describe("artifact trust API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses a complete verified-only response", () => {
    const response = makeArtifactTrustResponse({
      securityAssessments: [makeEvidence()],
      summary: {
        totalQueried: 1,
        totalVerified: 1,
        totalExcluded: 0,
        complete: true,
      },
    });

    expect(parseArtifactTrustResponse(response)).toEqual(response);
  });

  it("rejects unverified evidence and inconsistent summaries", () => {
    const unverified = makeArtifactTrustResponse({
      securityAssessments: [
        {
          ...makeEvidence(),
          verification: { valid: false, basis: [] },
        } as never,
      ],
      summary: {
        totalQueried: 1,
        totalVerified: 1,
        totalExcluded: 0,
        complete: true,
      },
    });
    expect(() => parseArtifactTrustResponse(unverified)).toThrow("unverified");

    expect(() =>
      parseArtifactTrustResponse({
        ...makeArtifactTrustResponse(),
        summary: {
          totalQueried: 1,
          totalVerified: 1,
          totalExcluded: 0,
          complete: true,
        },
      }),
    ).toThrow("inconsistent summary");
  });

  it("makes one encoded public API request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(makeArtifactTrustResponse()), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchArtifactTrust(artifactDid);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      `https://api.omatrust.org/v1/artifact-trust?artifactDid=${encodeURIComponent(artifactDid)}`,
    );
    expect(init.headers).toEqual({ Accept: "application/json" });
  });

  it("rejects evidence from an unexpected chain or EAS deployment", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(
      makeArtifactTrustResponse({
        chain: {
          chainId: 66238,
          caip2: "eip155:66238",
          easContract: "0x8835AF90f1537777F52E482C8630cE4e947eCa32",
        },
      }),
    ), { status: 200 }));
    await expect(fetchArtifactTrust(artifactDid)).rejects.toThrow("unexpected chain");

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(
      makeArtifactTrustResponse({
        chain: {
          chainId: 6623,
          caip2: "eip155:6623",
          easContract: "0x1111111111111111111111111111111111111111",
        },
      }),
    ), { status: 200 }));
    await expect(fetchArtifactTrust(artifactDid)).rejects.toThrow(
      "unexpected EAS contract",
    );
  });

  it("treats non-2xx and malformed JSON shapes as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 503 })),
    );
    await expect(
      fetchArtifactTrust(artifactDid),
    ).rejects.toThrow("503");

    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ artifactDid }), { status: 200 }),
    );
    await expect(
      fetchArtifactTrust(artifactDid),
    ).rejects.toThrow("malformed");
  });

  it("rejects evidence for a different artifactDid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(makeArtifactTrustResponse({ artifactDid: "did:artifact:other" })), {
          status: 200,
        }),
      ),
    );
    await expect(fetchArtifactTrust(artifactDid)).rejects.toThrow(/different artifact/);
  });

  it("round-trips optional attesterLabel and rejects invalid field shapes", () => {
    const withLabel = makeArtifactTrustResponse({
      securityAssessments: [makeEvidence("security-assessment", { attesterLabel: "Lab A" })],
      summary: { totalQueried: 1, totalVerified: 1, totalExcluded: 0, complete: true },
    });
    expect(parseArtifactTrustResponse(withLabel).securityAssessments[0].attestation.attesterLabel).toBe("Lab A");

    expect(() =>
      parseArtifactTrustResponse(
        makeArtifactTrustResponse({
          securityAssessments: [makeEvidence("security-assessment", { time: "not-digits" })],
          summary: { totalQueried: 1, totalVerified: 1, totalExcluded: 0, complete: true },
        }),
      ),
    ).toThrow(/invalid securityAssessments\.time/);

    expect(() =>
      parseArtifactTrustResponse({
        ...makeArtifactTrustResponse(),
        chain: { ...makeArtifactTrustResponse().chain, chainId: -1 },
      }),
    ).toThrow(/invalid chain\.chainId/);

    expect(() =>
      parseArtifactTrustResponse({
        ...makeArtifactTrustResponse(),
        summary: { totalQueried: 0, totalVerified: 0, totalExcluded: 0, complete: false },
      }),
    ).toThrow(/inconsistent summary/);

    expect(() =>
      parseArtifactTrustResponse({
        ...makeArtifactTrustResponse(),
        responsibilityClaims: "nope",
      }),
    ).toThrow(/missing responsibilityClaims/);
  });

  it("rejects non-record evidence items and invalid attestation data", () => {
    expect(() =>
      parseArtifactTrustResponse(
        makeArtifactTrustResponse({
          securityAssessments: ["not-an-object" as never],
          summary: { totalQueried: 1, totalVerified: 1, totalExcluded: 0, complete: true },
        }),
      ),
    ).toThrow(/invalid securityAssessments item/);

    expect(() =>
      parseArtifactTrustResponse(
        makeArtifactTrustResponse({
          securityAssessments: [
            {
              ...makeEvidence(),
              attestation: { ...makeEvidence().attestation, data: "nope" as never },
            },
          ],
          summary: { totalQueried: 1, totalVerified: 1, totalExcluded: 0, complete: true },
        }),
      ),
    ).toThrow(/invalid securityAssessments data/);
  });

  it("omits attesterLabel when the field is undefined", () => {
    const parsed = parseArtifactTrustResponse(
      makeArtifactTrustResponse({
        securityAssessments: [makeEvidence("security-assessment", { attesterLabel: undefined })],
        summary: { totalQueried: 1, totalVerified: 1, totalExcluded: 0, complete: true },
      }),
    );
    expect(parsed.securityAssessments[0].attestation).not.toHaveProperty("attesterLabel");
  });
});
