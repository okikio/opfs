/**
 * Defaults and option parsing for the filesystem facade.
 *
 * Each helper validates one caller option once, at construction or at the start of
 * an operation, so the facade methods work with checked values only.
 *
 * @module
 */
import type { FileSystemOptionsType } from "../adapter/definition.ts";
import type { FileDriverSignalOptionsType } from "../driver/file.ts";
import { OptimizationSchema } from "../schema/mod.ts";
import type { OptimizationType, WriteModeType } from "../schema/types.ts";

/** Default lock namespace used when the caller does not provide one. */
export const DEFAULT_LOCK_PREFIX = "@okikio/opfs";

/** Default maximum materialization for a stream sent to a value-oriented adapter. */
const DEFAULT_BUFFER_LIMIT = 64 * 1024 * 1024;

/** Default concurrent file-copy count for recursive copy. */
const DEFAULT_COPY_CONCURRENCY = 4;

/** Native performance routes enabled unless the caller deliberately disables one. */
const DEFAULT_OPTIMIZATIONS: OptimizationType = {
  streamRead: true,
  streamWrite: true,
  rangeRead: true,
  nativeCopy: true,
  nativeMove: true,
  writeAdmission: false,
};

/** Resolves and validates bounded copy/removal concurrency. */
export function getConcurrency(value: number | undefined): number {
  const concurrency = value ?? DEFAULT_COPY_CONCURRENCY;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive safe integer.");
  }
  return concurrency;
}

/** Resolves the maximum safe materialization for value-oriented storage adapters. */
export function getBufferLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_BUFFER_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("maxBufferedWriteBytes must be a positive safe integer.");
  }
  return limit;
}

/** Parses one facade option and reports invalid caller configuration as `TypeError`. */
export function parseOption<T>(schema: { parse(value: unknown): T }, value: unknown, name: string): T {
  try {
    return schema.parse(value);
  } catch (cause) {
    throw new TypeError(`Invalid filesystem ${name}.`, { cause });
  }
}

/** Resolves a partial optimization policy to the strict public shape. */
export function getOptimizations(value: FileSystemOptionsType["optimizations"]): OptimizationType {
  return parseOption(OptimizationSchema, { ...DEFAULT_OPTIMIZATIONS, ...value }, "optimizations");
}

/** Computes the logical file size produced by one materialized write. */
export function getWriteSize(
  current: number,
  input: number,
  mode: WriteModeType,
  at: number | undefined,
  truncate: boolean,
): number {
  if (mode === "replace") return input;
  const position = mode === "append" ? current : at ?? 0;
  const end = position + input;
  return truncate ? end : Math.max(current, end);
}

/** Projects a facade cancellation signal into the adapter operation contract. */
export function getAdapterSignalOptions(signal: AbortSignal | undefined): FileDriverSignalOptionsType {
  return signal === undefined ? {} : { signal };
}
