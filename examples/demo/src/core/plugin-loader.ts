/**
 * Re-exports all plugin loader primitives from @oma3/mpas.
 * This file exists so that existing imports from "../core/plugin-loader.js" continue to work.
 */
export {
  loadPlugin,
  validatePayloadAgainstPlugin,
} from "@oma3/mpas/plugin-loader";

export type {
  MpasApplicationPlugin,
  MpasOperationDescriptor,
  LoadError,
  LoadPluginResult,
  OperationMatch,
  PayloadValidationError,
  PayloadValidationResult,
} from "@oma3/mpas/plugin-loader";
