/**
 * Type declarations for optional trust dependencies.
 *
 * These packages are dynamically imported at runtime only when OMATrust
 * is configured. They are not required at compile time for the core adapter.
 */

declare module "@oma3/omatrust/identity" {
  export type Hex = `0x${string}`;
  export type Did = string;
  export function didToAddress(did: Did): Hex;
  export function normalizeDid(did: Did): Did;
  export function extractAddressFromDid(identifier: string): string;
}

declare module "@oma3/omatrust/reputation" {
  export type Hex = `0x${string}`;

  export interface AttestationQueryResult {
    uid: Hex;
    schema: Hex;
    attester: Hex;
    recipient: Hex;
    txHash?: Hex;
    revocable: boolean;
    revocationTime: bigint;
    expirationTime: bigint;
    time: bigint;
    refUID: Hex;
    data: Record<string, unknown>;
    raw?: string;
  }

  export interface ListAttestationsParams {
    subjectDid: string;
    provider: unknown;
    easContractAddress: Hex;
    schemas: Hex[];
    limit?: number;
    fromBlock?: number;
    toBlock?: number;
  }

  export function getAttestationsForDid(
    params: ListAttestationsParams,
  ): Promise<AttestationQueryResult[]>;

  export interface LinkedIdentifierData {
    subject: string;
    linkedId: string;
    proofs: unknown[];
    attester?: string;
  }

  export interface SchemaProofVerificationResult {
    valid: boolean;
    checks: unknown[];
    reasons: string[];
  }

  export function verifyLinkedIdentifierProofs(
    data: LinkedIdentifierData,
  ): SchemaProofVerificationResult;

  export function decodeAttestationData(
    schema: string,
    data: Hex,
  ): Record<string, unknown>;
}

declare module "ethers" {
  export class JsonRpcProvider {
    constructor(url: string);
    getBlockNumber(): Promise<number>;
  }
}
