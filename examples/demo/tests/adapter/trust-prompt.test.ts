import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  NO_PRIMARY_TRUST_EVIDENCE_WARNING,
  NO_TRUST_CHECKS_WARNING,
  promptPluginUse,
  RESPONSIBILITY_CLAIM_TRUST_NOTICE,
  UNQUALIFIED_CLAIMS_NOTICE,
  writeUnqualifiedClaims,
} from "../../src/adapter/trust-prompt.js";
import type { PluginTrustReport } from "../../src/adapter/trust.js";
import type { AttestationSummary } from "../../src/adapter/trust-attestation.js";
import type { LinkedIdentifierSummary } from "../../src/adapter/trust-linkage.js";
import type { DeploymentConfig } from "../../src/adapter/config-loader.js";

const publisherDid = "did:web:publisher.example";

function makeSummary(responsibleParty: unknown, extras: Partial<AttestationSummary> = {}): AttestationSummary {
  return {
    uid: `uid-${String(responsibleParty)}`,
    attester: "0xattester",
    isApprovedIssuer: false,
    schemaUid: "0xschema",
    schemaLabel: "responsibility-claim",
    time: "2026-08-01T00:00:00.000Z",
    expirationTime: "0",
    verificationBasis: ["proof", "controller-authorization"],
    data: { subject: "did:artifact:bafk", responsibleParty },
    ...extras,
  };
}

function makeReport(options: {
  unqualified?: AttestationSummary[];
  claims?: AttestationSummary[];
  attestations?: AttestationSummary[];
  linked?: LinkedIdentifierSummary[];
  cybersecurityAssessment?: boolean;
  warningRequired?: boolean;
} = {}): PluginTrustReport {
  const claims = options.claims ?? [];
  const unqualified = options.unqualified ?? [];
  return {
    artifactDid: "did:artifact:bafk",
    publisherDid,
    pluginDid: "did:web:publisher.example:plugins:demo",
    pluginVersion: "1.0.0",
    targetApplicationDid: "did:web:publisher.example:applications:demo",
    verdict: {
      primaryEvidenceFound: !(options.warningRequired ?? true),
      warningRequired: options.warningRequired ?? true,
      reasons: [],
    },
    attestation: {
      primaryEvidenceFound: claims.length > 0,
      message: "",
      responsibilityClaim: claims.length > 0,
      cybersecurityAssessment: options.cybersecurityAssessment ?? false,
      responsibilityClaims: claims,
      unqualifiedResponsibilityClaims: unqualified,
      attestations: options.attestations ?? [],
    },
    linkedIdentifiers: options.linked ?? [],
  };
}

const config = {
  name: "demo-plugin",
  plugin: { artifactDid: "did:artifact:bafk" },
} as DeploymentConfig;

describe("writeUnqualifiedClaims", () => {
  it("writes nothing when every claim qualified", () => {
    expect(writeUnqualifiedClaims(makeReport())).toBeUndefined();
  });

  it("writes the non-qualifying claims out with the publisher that was required", () => {
    const claims = [
      makeSummary("did:web:squatter.example"),
      makeSummary("did:web:other.example"),
    ];
    const path = writeUnqualifiedClaims(makeReport({ unqualified: claims }));
    expect(path).toBeDefined();

    const written = JSON.parse(readFileSync(path as string, "utf-8"));
    expect(written.declaredPublisherDid).toBe(publisherDid);
    expect(written.artifactDid).toBe("did:artifact:bafk");
    expect(written.note).toBe(UNQUALIFIED_CLAIMS_NOTICE);
    expect(written.claims).toHaveLength(2);
    expect(written.claims[0].data.responsibleParty).toBe("did:web:squatter.example");
  });
});

describe("promptPluginUse", () => {
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const writes: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    writes.length = 0;
    if (originalIsTTY) {
      Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
    } else {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });

  function captureStdout() {
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(chunk.toString());
      return true;
    });
  }

  it("declines non-interactively when trust checks were unavailable", async () => {
    captureStdout();
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });

    const accepted = await promptPluginUse(
      { status: "notChecked", reason: "unavailable", detail: "registry down" },
      config,
    );

    expect(accepted).toBe(false);
    const text = writes.join("");
    expect(text).toContain("Plugin: demo-plugin");
    expect(text).toContain("registry down");
    expect(text).toContain(NO_TRUST_CHECKS_WARNING);
    expect(text).toContain("Non-interactive input: declining plugin use by default.");
  });

  it("prints checked trust details and declines without a TTY", async () => {
    captureStdout();
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });

    const linked: LinkedIdentifierSummary = {
      uid: "link-1",
      linkedId: "https://github.com/example/demo",
      attester: "0xlink",
      attesterLabel: "Link Issuer",
      verificationBasis: ["proof"],
    };

    const accepted = await promptPluginUse(
      {
        status: "checked",
        report: makeReport({
          claims: [
            makeSummary("did:web:publisher.example", {
              data: {
                subject: "did:artifact:bafk",
                responsibleParty: "did:web:publisher.example",
                responsibilityType: ["publisher", "maintainer"],
              },
            }),
            makeSummary(123, { attesterLabel: "Labeled Attester" }),
          ],
          unqualified: [makeSummary("did:web:other.example")],
          cybersecurityAssessment: true,
          attestations: [
            {
              uid: "att-1",
              attester: "0xsec",
              isApprovedIssuer: true,
              schemaUid: "0xcyberschema",
              schemaLabel: "cybersecurity-assessment",
              time: "2026-08-01T00:00:00.000Z",
              expirationTime: "0",
              verificationBasis: [],
              data: {},
            },
            {
              uid: "att-2",
              attester: "0xproof",
              isApprovedIssuer: true,
              schemaUid: "0xotherschema",
              schemaLabel: "other-attestation",
              time: "2026-08-01T00:00:00.000Z",
              expirationTime: "0",
              verificationBasis: ["proof"],
              data: {},
            },
          ],
          linked: [linked],
          warningRequired: true,
        }),
      },
      config,
    );

    expect(accepted).toBe(false);
    const text = writes.join("");
    expect(text).toContain(NO_PRIMARY_TRUST_EVIDENCE_WARNING);
    expect(text).toContain("Responsibility claim from that publisher: FOUND");
    expect(text).toContain("responsibility publisher, maintainer");
    expect(text).toContain(RESPONSIBILITY_CLAIM_TRUST_NOTICE);
    expect(text).toContain("Labeled Attester");
    expect(text).toContain("Claims naming a different responsible party: 1");
    expect(text).toContain("Details written to");
    expect(text).toContain("Cybersecurity assessment: FOUND");
    expect(text).toContain("cybersecurity-assessment; issuer 0xsec");
    expect(text).toContain("verified via endpoint verification");
    expect(text).toContain("verified via proof");
    expect(text).toContain("https://github.com/example/demo");
  });

  it("prints empty linked-identifier section when none exist", async () => {
    captureStdout();
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });

    await promptPluginUse(
      {
        status: "checked",
        report: makeReport({ warningRequired: false, linked: [] }),
      },
      config,
    );

    expect(writes.join("")).toContain("Linked identifiers (0):");
    expect(writes.join("")).toContain("- None found.");
  });

  it("accepts an interactive yes answer on a TTY", async () => {
    captureStdout();
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    const close = vi.fn();
    vi.resetModules();
    vi.doMock("node:readline/promises", () => ({
      createInterface: () => ({
        question: async () => "Y",
        close,
      }),
    }));

    const { promptPluginUse: prompt } = await import("../../src/adapter/trust-prompt.js");
    const accepted = await prompt(
      { status: "checked", report: makeReport({ warningRequired: false }) },
      config,
    );
    expect(accepted).toBe(true);
    expect(close).toHaveBeenCalled();
    vi.doUnmock("node:readline/promises");
    vi.resetModules();
  });

  it("returns undefined and prints a disk warning when unqualified claims cannot be written", async () => {
    captureStdout();
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        mkdtempSync: () => {
          throw new Error("disk full");
        },
      };
    });

    const { writeUnqualifiedClaims: writeClaims, promptPluginUse: prompt } = await import(
      "../../src/adapter/trust-prompt.js"
    );
    expect(writeClaims(makeReport({ unqualified: [makeSummary("did:web:other.example")] }))).toBeUndefined();

    await prompt(
      {
        status: "checked",
        report: makeReport({ unqualified: [makeSummary("did:web:other.example")], warningRequired: true }),
      },
      config,
    );
    expect(writes.join("")).toContain("Details could not be written to disk.");
    vi.doUnmock("node:fs");
    vi.resetModules();
  });
});
