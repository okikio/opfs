import type { AdapterType } from "./definition.ts";
import { createRecordAdapter } from "./record.ts";
import {
  createDenoKvDriver,
  DENO_KV_DEFAULT_COLLECT_AGE_MS,
  DENO_KV_DEFAULT_COLLECT_DELETES,
  DENO_KV_DEFAULT_CONCURRENCY,
  DENO_KV_DEFAULT_INLINE_BYTES,
  DENO_KV_DEFAULT_MAX_PARTS,
  DENO_KV_DEFAULT_PART_BYTES,
  DENO_KV_MAX_ATOMIC_BYTES,
  DENO_KV_MAX_KEY_BYTES,
  DENO_KV_MAX_VALUE_BYTES,
  DENO_KV_SAFE_INLINE_BYTES,
  DENO_KV_SAFE_PART_BYTES,
  type DenoKvAtomicType,
  type DenoKvCheckType,
  type DenoKvCollectOptionsType,
  type DenoKvCommitType,
  type DenoKvCollectResultType,
  type DenoKvDriverOptionsType,
  type DenoKvDriverType,
  type DenoKvEntryType,
  type DenoKvType,
} from "../driver/deno-kv.ts";
import { PartitionModeSchema } from "../schema.ts";

/** Documented provider ceilings and conservative project defaults used by the Deno KV driver. */
export {
  DENO_KV_DEFAULT_COLLECT_AGE_MS,
  DENO_KV_DEFAULT_COLLECT_DELETES,
  DENO_KV_DEFAULT_CONCURRENCY,
  DENO_KV_DEFAULT_INLINE_BYTES,
  DENO_KV_DEFAULT_MAX_PARTS,
  DENO_KV_DEFAULT_PART_BYTES,
  DENO_KV_MAX_ATOMIC_BYTES,
  DENO_KV_MAX_KEY_BYTES,
  DENO_KV_MAX_VALUE_BYTES,
  DENO_KV_SAFE_INLINE_BYTES,
  DENO_KV_SAFE_PART_BYTES,
};

/** Options forwarded to the Deno KV record driver. */
export type DenoKvAdapterOptionsType = DenoKvDriverOptionsType;

/** Minimal Deno KV entry and database contracts consumed by the driver. */
export type {
  DenoKvAtomicType,
  DenoKvCheckType,
  DenoKvCollectOptionsType,
  DenoKvCollectResultType,
  DenoKvCommitType,
  DenoKvDriverType,
  DenoKvEntryType,
  DenoKvType,
};

/** Resolves a positive integer adapter setting before projecting driver policy. */
function positive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

/**
 * Creates the OPFS primitive translation over an injected Deno KV database.
 *
 * Deno KV partitioning is driver-owned. The duplicated adapter `limits` and
 * `partition` fields describe how that driver route appears at the filesystem
 * translation seam; provider and safety-policy provenance remain available in
 * `adapter.driver.inspect()` and `FileSystemType.inspect().driver`.
 */
export function createDenoKvAdapter(
  database: DenoKvType,
  options: DenoKvAdapterOptionsType = {},
): AdapterType {
  const partition = PartitionModeSchema.parse(options.partition ?? "auto");
  const partBytes = positive(options.partBytes, DENO_KV_DEFAULT_PART_BYTES, "partBytes");
  const maxParts = positive(options.maxParts, DENO_KV_DEFAULT_MAX_PARTS, "maxParts");
  const concurrency = positive(options.concurrency, DENO_KV_DEFAULT_CONCURRENCY, "concurrency");
  const inlineBytes = positive(options.inlineBytes, DENO_KV_DEFAULT_INLINE_BYTES, "inlineBytes");
  const driver = createDenoKvDriver(database, options);

  return createRecordAdapter(driver, {
    name: "deno-kv",
    readOnly: options.readOnly ?? false,
    disposeDriver: true,
    limits: {
      maxFileBytes: partBytes * maxParts,
      maxValueBytes: DENO_KV_MAX_VALUE_BYTES,
      maxKeyBytes: DENO_KV_MAX_KEY_BYTES,
      maxParts,
      maxBatchBytes: DENO_KV_MAX_ATOMIC_BYTES,
      maxConcurrency: concurrency,
    },
    partition: {
      mode: partition,
      partBytes,
      thresholdBytes: inlineBytes,
      stream: partition !== "never",
      maxParts,
      layout: "deno-kv-parts-v2",
    },
  });
}
