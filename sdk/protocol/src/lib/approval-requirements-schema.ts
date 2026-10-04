import { z } from "zod";
import type { ApprovalRequirements, Did } from "../types/mpas.js";

// MPAS Core Appendix A.4.8: validate structure, never evaluate authorization.
const did = z.string().regex(/^did:[a-z0-9]+:[^\s]+$/).transform(value => value as Did);
const threshold = z.strictObject({
  type: z.literal("threshold"),
  threshold: z.number().int().min(1),
  eligibleSigners: z.array(did).min(1),
  decision: z.enum(["propose", "approve", "reject", "abstain"]).optional(),
  description: z.string().optional(),
});
const schema = z.strictObject({
  anyOf: z.array(threshold).min(1).optional(),
  allOf: z.array(threshold).min(1).optional(),
  overrideSigners: z.array(z.strictObject({
    signer: did,
    permissions: z.array(z.string().min(1)).min(1),
    description: z.string().optional(),
  })).min(1).optional(),
}).refine(value => value.anyOf !== undefined || value.allOf !== undefined || value.overrideSigners !== undefined,
  "At least one approval path is required");

export function parseApprovalRequirements(value: unknown): ApprovalRequirements {
  return schema.parse(value);
}
