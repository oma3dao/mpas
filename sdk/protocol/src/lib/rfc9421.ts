import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { httpbis } from "http-message-signatures";
import {
  parseDictionary,
  serializeDictionary,
  serializeItem,
  serializeList,
  type Dictionary,
  type InnerList,
  type Item,
} from "structured-headers";
import type { Did } from "../types/mpas.js";
import { didJwkToJwk } from "./did-jwk.js";
import { KeyManager } from "./key-manager.js";

export const MPAS_SIGNATURE_TAG = "mpas-v1";
export const MPAS_SIGNATURE_LABEL = "mpas";
export const MPAS_COVERED_COMPONENTS = ["@method", "@path", "content-digest"] as const;
export const MPAS_MAX_SIGNATURE_LIFETIME_SECONDS = 60;

export type MpasHeaderValue = string | string[] | number | undefined;
export type MpasHeaders = Record<string, MpasHeaderValue>;

export interface MpasRfc9421Signer {
  readonly did: Did;
  signBytes(payload: Uint8Array): Promise<Uint8Array>;
}

export interface SignMpasRfc9421Options {
  method: string;
  path: string;
  body: Uint8Array;
  signer: MpasRfc9421Signer;
  created?: Date;
  expires?: Date;
  lifetimeSeconds?: number;
  nonce?: string;
  label?: string;
}

export interface VerifyMpasRfc9421Options {
  method: string;
  path: string;
  headers: MpasHeaders;
  body: Uint8Array;
  audiences: readonly string[] | ReadonlySet<string>;
  now?: Date;
  clockSkewSeconds?: number;
  maxLifetimeSeconds?: number;
}

export interface MpasAuthSuccess {
  ok: true;
  did: Did;
  nonce: string;
  createdAt: Date;
  expiresAt: Date;
  label: string;
}

export type MpasAuthFailureReason =
  | "headers_absent"
  | "headers_incomplete"
  | "structured_field_malformed"
  | "candidate_selection_failed"
  | "signature_member_missing"
  | "covered_components_invalid"
  | "parameters_invalid"
  | "key_invalid"
  | "freshness_invalid"
  | "signature_unverifiable"
  | "content_digest_invalid"
  | "content_digest_mismatch"
  | "audience_invalid";

export interface MpasAuthFailure {
  ok: false;
  status: 400 | 401;
  code: "authentication_required" | "signature_invalid" | "artifact_hash_mismatch";
  reason: MpasAuthFailureReason;
}

export type MpasAuthResult = MpasAuthSuccess | MpasAuthFailure;

export interface NonceStore {
  claim(keyid: string, nonce: string, expiresAt: Date): Promise<boolean>;
}

export class InMemoryNonceStore implements NonceStore {
  private readonly claims = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  async claim(keyid: string, nonce: string, expiresAt: Date): Promise<boolean> {
    const now = this.now();
    // Reference implementation: opportunistic O(n) pruning is appropriate
    // for the local/demo store. Hosted deployments provide a durable store.
    for (const [storedKey, storedExpiry] of this.claims) {
      if (storedExpiry < now) this.claims.delete(storedKey);
    }
    const claimKey = `${keyid.length}:${keyid}${nonce}`;
    const existingExpiry = this.claims.get(claimKey);

    if (existingExpiry !== undefined && existingExpiry >= now) {
      return false;
    }

    if (existingExpiry !== undefined) {
      this.claims.delete(claimKey);
    }
    this.claims.set(claimKey, expiresAt.getTime());
    return true;
  }
}

export async function signMpasRfc9421(options: SignMpasRfc9421Options): Promise<Record<string, string>> {
  const created = options.created ?? new Date();
  const lifetimeSeconds = options.lifetimeSeconds ?? MPAS_MAX_SIGNATURE_LIFETIME_SECONDS;
  validateLifetime(lifetimeSeconds);
  const expires = options.expires ?? new Date(created.getTime() + lifetimeSeconds * 1000);
  const createdSeconds = Math.floor(created.getTime() / 1000);
  const expiresSeconds = Math.floor(expires.getTime() / 1000);
  if (expiresSeconds <= createdSeconds || expiresSeconds - createdSeconds > lifetimeSeconds) {
    throw new Error(`RFC 9421 expires must be after created with a declared lifetime of at most ${lifetimeSeconds} seconds.`);
  }
  const nonce = options.nonce ?? randomBytes(16).toString("hex");
  const label = options.label ?? MPAS_SIGNATURE_LABEL;
  const contentDigest = createContentDigest(options.body);
  const request = signatureRequest(options.method, options.path, { "content-digest": contentDigest });

  const signed = await httpbis.signMessage(
    {
      name: label,
      fields: [...MPAS_COVERED_COMPONENTS],
      params: ["created", "expires", "keyid", "nonce", "tag"],
      paramValues: {
        created,
        expires,
        keyid: options.signer.did,
        nonce,
        tag: MPAS_SIGNATURE_TAG,
      },
      key: {
        id: options.signer.did,
        async sign(data) {
          return Buffer.from(await options.signer.signBytes(data));
        },
      },
    },
    request,
  );

  return {
    "Content-Digest": contentDigest,
    "Signature-Input": requiredStringHeader(signed.headers, "signature-input"),
    Signature: requiredStringHeader(signed.headers, "signature"),
  };
}

export async function verifyMpasRfc9421(options: VerifyMpasRfc9421Options): Promise<MpasAuthResult> {
  const signatureInputHeader = headerValue(options.headers, "signature-input");
  const signatureHeader = headerValue(options.headers, "signature");

  if (signatureInputHeader === undefined && signatureHeader === undefined) {
    return authFailure("headers_absent", "authentication_required");
  }
  if (signatureInputHeader === undefined || signatureHeader === undefined) {
    return authFailure("headers_incomplete");
  }

  let signatureInputs: Dictionary;
  let signatures: Dictionary;
  try {
    signatureInputs = parseDictionary(signatureInputHeader);
    signatures = parseDictionary(signatureHeader);
  } catch {
    return authFailure("structured_field_malformed");
  }

  const candidates = [...signatureInputs.entries()].filter(([, value]) =>
    isInnerList(value) && value[1].get("tag") === MPAS_SIGNATURE_TAG,
  );
  if (candidates.length !== 1) {
    return authFailure("candidate_selection_failed");
  }

  const [label, input] = candidates[0];
  if (!isInnerList(input)) {
    return authFailure("structured_field_malformed");
  }

  const signatureItem = signatures.get(label);
  if (!signatureItem || isInnerList(signatureItem) || !(signatureItem[0] instanceof ArrayBuffer) || signatureItem[1].size !== 0) {
    return authFailure("signature_member_missing");
  }

  const fields = coveredFields(input);
  if (!fields || !sameOrderedValues(fields.names, MPAS_COVERED_COMPONENTS)) {
    return authFailure("covered_components_invalid");
  }

  const parameters = input[1];
  const created = parameters.get("created");
  const expires = parameters.get("expires");
  const keyid = parameters.get("keyid");
  const nonce = parameters.get("nonce");
  const tag = parameters.get("tag");
  const alg = parameters.get("alg");
  if (
    !isInteger(created) ||
    !isInteger(expires) ||
    typeof keyid !== "string" ||
    typeof nonce !== "string" ||
    tag !== MPAS_SIGNATURE_TAG ||
    (alg !== undefined && alg !== "ed25519")
  ) {
    return authFailure("parameters_invalid");
  }

  const maxLifetimeSeconds = options.maxLifetimeSeconds ?? MPAS_MAX_SIGNATURE_LIFETIME_SECONDS;
  const clockSkewSeconds = options.clockSkewSeconds ?? 30;
  if (!validVerificationPolicy(maxLifetimeSeconds, clockSkewSeconds)) {
    throw new Error("Invalid RFC 9421 verification policy.");
  }
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (
    expires <= created ||
    expires - created > maxLifetimeSeconds ||
    created > nowSeconds + clockSkewSeconds ||
    expires < nowSeconds
  ) {
    return authFailure("freshness_invalid");
  }

  let keyManager: KeyManager;
  try {
    keyManager = KeyManager.fromJwk(didJwkToJwk(keyid));
  } catch {
    return authFailure("key_invalid");
  }

  let signatureBase: string;
  try {
    const request = signatureRequest(options.method, options.path, normalizedSignatureHeaders(options.headers));
    const base = httpbis.createSignatureBase({ fields: fields.serialized }, request);
    // RFC 9421 §§2.3 and 3.2 step 7 require strict serialization of the
    // parsed Signature-Input member. The raw field bytes are intentionally
    // not reused, so permitted optional whitespace normalizes before verify.
    base.push(["\"@signature-params\"", [serializeList([input])]]);
    signatureBase = httpbis.formatSignatureBase(base);
  } catch {
    return authFailure("signature_unverifiable");
  }

  const signatureBytes = new Uint8Array(signatureItem[0]);
  if (!(await keyManager.verifyBytes(Buffer.from(signatureBase, "utf8"), signatureBytes))) {
    return authFailure("signature_unverifiable");
  }

  const digestResult = verifyContentDigest(options.headers, options.body);
  if (digestResult === "invalid") {
    return authFailure("content_digest_invalid");
  }
  if (digestResult === "mismatch") {
    return {
      ok: false,
      status: 400,
      code: "artifact_hash_mismatch",
      reason: "content_digest_mismatch",
    };
  }

  if (!validAudience(options.body, options.audiences)) {
    return authFailure("audience_invalid");
  }

  return {
    ok: true,
    did: keyid as Did,
    nonce,
    createdAt: new Date(created * 1000),
    expiresAt: new Date(expires * 1000),
    label,
  };
}

export function deriveMpasAudience(serviceUrl: string): string {
  const url = new URL(serviceUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Coordination Service URL must use http or https.");
  }
  return url.origin;
}

export function isValidMpasAudienceOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

export function createContentDigest(body: Uint8Array): string {
  const digest = createHash("sha256").update(body).digest();
  return serializeDictionary(new Map([["sha-256", [toArrayBuffer(digest), new Map()]]]));
}

function verifyContentDigest(headers: MpasHeaders, body: Uint8Array): "valid" | "invalid" | "mismatch" {
  const value = headerValue(headers, "content-digest");
  if (value === undefined) return "invalid";

  try {
    const dictionary = parseDictionary(value);
    const member = dictionary.get("sha-256");
    if (dictionary.size !== 1 || !member || isInnerList(member) || !(member[0] instanceof ArrayBuffer) || member[1].size !== 0) {
      return "invalid";
    }

    const expected = createHash("sha256").update(body).digest();
    const actual = Buffer.from(member[0]);
    return actual.length === expected.length && timingSafeEqual(actual, expected) ? "valid" : "mismatch";
  } catch {
    return "invalid";
  }
}

function validAudience(body: Uint8Array, audiences: readonly string[] | ReadonlySet<string>): boolean {
  try {
    const parsed = JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const audience = (parsed as Record<string, unknown>).audience;
    if (typeof audience !== "string") return false;
    return Array.from(audiences).includes(audience);
  } catch {
    return false;
  }
}

function signatureRequest(method: string, path: string, headers: Record<string, string | string[]>) {
  const url = new URL(path, "https://mpas.invalid");
  return { method, url, headers };
}

function normalizedSignatureHeaders(headers: MpasHeaders): Record<string, string | string[]> {
  const normalized: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    normalized[name] = typeof value === "number" ? String(value) : value;
  }
  return normalized;
}

function coveredFields(input: InnerList): { names: string[]; serialized: string[] } | undefined {
  const names: string[] = [];
  const serialized: string[] = [];
  for (const item of input[0]) {
    if (typeof item[0] !== "string" || item[1].size !== 0) return undefined;
    names.push(item[0]);
    serialized.push(serializeItem(item as Item));
  }
  return { names, serialized };
}

function isInnerList(value: Item | InnerList): value is InnerList {
  return Array.isArray(value[0]);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function sameOrderedValues(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function headerValue(headers: MpasHeaders, expectedName: string): string | undefined {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === expectedName);
  if (!entry || entry[1] === undefined) return undefined;
  const value = entry[1];
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function requiredStringHeader(headers: Record<string, string | string[]>, name: string): string {
  const value = Object.entries(headers).find(([header]) => header.toLowerCase() === name)?.[1];
  if (value === undefined) throw new Error(`RFC 9421 library did not produce ${name}.`);
  return Array.isArray(value) ? value.join(", ") : value;
}

function authFailure(
  reason: MpasAuthFailureReason,
  code: MpasAuthFailure["code"] = "signature_invalid",
): MpasAuthFailure {
  return { ok: false, status: 401, code, reason };
}

function validateLifetime(lifetimeSeconds: number): void {
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds <= 0 || lifetimeSeconds > MPAS_MAX_SIGNATURE_LIFETIME_SECONDS) {
    throw new Error(`RFC 9421 signature lifetime must be an integer from 1 to ${MPAS_MAX_SIGNATURE_LIFETIME_SECONDS} seconds.`);
  }
}

function validVerificationPolicy(maxLifetimeSeconds: number, clockSkewSeconds: number): boolean {
  return (
    Number.isInteger(maxLifetimeSeconds) &&
    maxLifetimeSeconds > 0 &&
    maxLifetimeSeconds <= MPAS_MAX_SIGNATURE_LIFETIME_SECONDS &&
    Number.isInteger(clockSkewSeconds) &&
    clockSkewSeconds >= 0
  );
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}
