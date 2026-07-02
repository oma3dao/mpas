import type { JWK } from "jose";
import type { Did, MpasApplicationPlugin } from "./mpas.js";

export type KeySource = string | JWK;
export type PluginSource = string | MpasApplicationPlugin;

export interface ExecutionProfileConfig {
  id: Did;
  format: string;
}

export type ApprovalCollectionStrategy = "return" | "coordinate" | "wait";

export interface ProposerConfig {
  plugin: PluginSource;
  applicationDid: Did;
  adapterUrl: string;
  agentKey: KeySource;
  executionProfile?: ExecutionProfileConfig;
  defaultExpirationMinutes?: number;
  approvalStrategy?: ApprovalCollectionStrategy;
  coordinationUrl?: string;
  approvalTimeoutMs?: number;
}
