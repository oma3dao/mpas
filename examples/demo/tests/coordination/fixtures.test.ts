import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function readFixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(process.cwd(), "tests", "fixtures", "coordination", name), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("coordination fixtures", () => {
  it("defines a pending action request fixture", async () => {
    const fixture = await readFixture("pending-action-request.json");

    expect(fixture.version).toBe("1");
    expect(fixture.type).toBe("CoordinationActionRequest");
    expect(fixture.authorizationRequirements).toMatchObject({
      result: "additionalApprovalsRequired",
      approvalRequirements: {
        anyOf: [
          {
            type: "threshold",
            threshold: 2,
            decision: "approve",
          },
        ],
      },
    });
  });

  it("defines polling and cancellation fixtures", async () => {
    await expect(readFixture("poll-request-maintainer-a.json")).resolves.toMatchObject({
      version: "1",
      type: "CoordinationPollRequest",
    });
    await expect(readFixture("poll-response-awaiting.json")).resolves.toMatchObject({
      version: "1",
      type: "CoordinationPollResponse",
      approvalRequests: [expect.objectContaining({ type: "ApprovalRequest" })],
    });
    await expect(readFixture("cancel-request.json")).resolves.toMatchObject({
      version: "1",
      type: "CoordinationCancelRequest",
    });
  });
});
