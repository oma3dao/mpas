import { createPrivateKey, sign as signEd25519 } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { httpbis, type Request as SignatureRequest } from "http-message-signatures";
import type { JWK } from "jose";

interface Rfc9421B26Fixture {
  privateJwk: JWK;
  request: SignatureRequest & { body: string };
  fields: string[];
  created: number;
  keyid: string;
  signatureBase: string;
  signatureInput: string;
  signature: string;
}

const fixturePath = fileURLToPath(new URL("../fixtures/rfc9421-b2.6.json", import.meta.url));

describe("RFC 9421 known-answer vectors", () => {
  it("reproduces Appendix B.2.6 byte-exactly", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Rfc9421B26Fixture;
    const privateKey = createPrivateKey({ key: fixture.privateJwk, format: "jwk" });
    let observedBase: string | undefined;

    const signed = await httpbis.signMessage(
      {
        name: "sig-b26",
        fields: fixture.fields,
        params: ["created", "keyid"],
        paramValues: {
          created: new Date(fixture.created * 1000),
          keyid: fixture.keyid,
        },
        key: {
          id: fixture.keyid,
          async sign(data) {
            observedBase = data.toString("ascii");
            return signEd25519(null, data, privateKey);
          },
        },
      },
      fixture.request,
    );

    expect(observedBase).toBe(fixture.signatureBase);
    expect(signed.headers["Signature-Input"]).toBe(fixture.signatureInput);
    expect(signed.headers.Signature).toBe(fixture.signature);
  });
});
