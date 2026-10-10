import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  UNQUALIFIED_CLAIMS_NOTICE,
  writeUnqualifiedClaims,
} from "../../src/adapter/trust-prompt.js";
import type { PluginTrustReport } from "../../src/adapter/trust.js";
import type { AttestationSummary } from "../../src/adapter/trust-attestation.js";

const publisherDid = "did:web:publisher.example";

function makeSummary(responsibleParty: string): AttestationSummary {
  return {
    uid: `uid-${responsibleParty}`,
    attester: "0xattester",
    isApprovedIssuer: false,
    schemaUid: "0xschema",
    schemaLabel: "responsibility-claim",
    time: "2026-08-01T00:00:00.000Z",
    expirationTime: "0",
    verificationBasis: ["proof", "controller-authorization"],
    data: { subject: "did:artifact:bafk", responsibleParty },
  };
}

function makeReport(
  unqualified: AttestationSummary[],
): PluginTrustReport {
  return {
    artifactDid: "did:artifact:bafk",
    publisherDid,
    pluginDid: "did:web:publisher.example:plugins:demo",
    pluginVersion: "1.0.0",
    targetApplicationDid: "did:web:publisher.example:applications:demo",
    verdict: { primaryEvidenceFound: false, warningRequired: true, reasons: [] },
    attestation: {
      primaryEvidenceFound: false,
      message: "",
      responsibilityClaim: false,
      cybersecurityAssessment: false,
      responsibilityClaims: [],
      unqualifiedResponsibilityClaims: unqualified,
      attestations: [],
    },
    linkedIdentifiers: [],
  };
}

describe("writeUnqualifiedClaims", () => {
  it("writes nothing when every claim qualified", () => {
    expect(writeUnqualifiedClaims(makeReport([]))).toBeUndefined();
  });

  it("writes the non-qualifying claims out with the publisher that was required", () => {
    const claims = [
      makeSummary("did:web:squatter.example"),
      makeSummary("did:web:other.example"),
    ];
    const path = writeUnqualifiedClaims(makeReport(claims));
    expect(path).toBeDefined();

    const written = JSON.parse(readFileSync(path as string, "utf-8"));
    expect(written.declaredPublisherDid).toBe(publisherDid);
    expect(written.artifactDid).toBe("did:artifact:bafk");
    expect(written.note).toBe(UNQUALIFIED_CLAIMS_NOTICE);
    expect(written.claims).toHaveLength(2);
    expect(written.claims[0].data.responsibleParty).toBe(
      "did:web:squatter.example",
    );
  });
});
