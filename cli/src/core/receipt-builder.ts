/**
 * Re-exports receipt builder from @oma3/mpas.
 * This file exists so that existing imports from "../core/receipt-builder.js" continue to work.
 */
export {
  buildAndSignExecutionReceipt,
  buildAndSignReceipt,
} from "@oma3/mpas/receipt-builder";
export type {
  BuildAndSignExecutionReceiptInput,
  ReceiptBuildResult,
} from "@oma3/mpas/receipt-builder";
