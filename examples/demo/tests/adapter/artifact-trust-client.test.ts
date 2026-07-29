import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ARTIFACT_TRUST_API_URL,
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
      `${DEFAULT_ARTIFACT_TRUST_API_URL}?artifactDid=${encodeURIComponent(artifactDid)}`,
    );
    expect(init.headers).toEqual({ Accept: "application/json" });
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
});
