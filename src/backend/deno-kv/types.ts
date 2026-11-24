/**
 * Database, entry, collect and option types for the Deno KV driver.
 *
 * `DenoKvType` names the part of `Deno.Kv` the driver uses, so tests and other
 * runtimes can pass a compatible store.
 *
 * @module
 */
import { type GenerationOptionsType, type KvUsageType } from "./generation.ts";
import { type RecordDriverType } from "../../driver/record.ts";
import { type PartitionModeType } from "../../schema/mod.ts";

/**
 * Native Deno KV key tuple. The package exposes this structural contract so
 * importing its types does not require an unstable ambient Deno namespace.
 */
export type DenoKvKeyType = readonly (Uint8Array | string | number | bigint | boolean | symbol)[];

/** Native prefix or ordered-range selector accepted by the borrowed database. */
export type DenoKvListSelectorType =
  | { readonly prefix: DenoKvKeyType }
  | { readonly prefix: DenoKvKeyType; readonly start: DenoKvKeyType }
  | { readonly prefix: DenoKvKeyType; readonly end: DenoKvKeyType }
  | { readonly start: DenoKvKeyType; readonly end: DenoKvKeyType };

/** Native list options. Consistency applies to each provider batch separately. */
export interface DenoKvListOptionsType {
  /** Maximum number of matching entries returned. */
  readonly limit?: number;
  /** Provider cursor used to resume iteration. */
  readonly cursor?: string;
  /** Iterates keys in descending order when enabled. */
  readonly reverse?: boolean;
  /** Selects strong or eventual consistency for each returned batch. */
  readonly consistency?: "strong" | "eventual";
  /** Requested batch size, bounded by the provider's native limit. */
  readonly batchSize?: number;
}

/** Structural Deno KV entry used by the driver. */
export interface DenoKvEntryType<T> {
  /** Stored tuple returned by exact reads and prefix iteration. */
  readonly key: DenoKvKeyType;
  /** Stored value, or null for a missing exact get. */
  readonly value: T | null;
  /** Provider version used for optimistic visibility commits. Missing entries use null. */
  readonly versionstamp: string | null;
}

/** Version check accepted by the Deno KV atomic operation. */
export interface DenoKvCheckType {
  /** Exact logical entry key observed before the operation started. */
  readonly key: DenoKvKeyType;
  /** Version observed by `get()`, or null when the logical entry did not exist. */
  readonly versionstamp: string | null;
}

/** Result subset returned by a Deno KV atomic commit. */
export interface DenoKvCommitType {
  /** False means an optimistic version check failed and no mutation was applied. */
  readonly ok: boolean;
}

/** Structural Deno KV atomic operation required for one logical visibility commit. */
export interface DenoKvAtomicType {
  /** Requires the logical entry to retain the version observed before physical preparation. */
  check(...checks: DenoKvCheckType[]): DenoKvAtomicType;
  /** Adds one small metadata or logical-entry replacement to the transaction. */
  set(key: DenoKvKeyType, value: unknown): DenoKvAtomicType;
  /** Adds one logical-entry deletion to the transaction. */
  delete(key: DenoKvKeyType): DenoKvAtomicType;
  /** Commits checks and metadata mutations atomically. */
  commit(): Promise<DenoKvCommitType>;
}

/** Structural Deno KV subset required by this driver. */
export interface DenoKvType {
  /** Reads one exact key. */
  get<T = unknown>(key: DenoKvKeyType): Promise<DenoKvEntryType<T>>;
  /** Replaces one key. */
  set(key: DenoKvKeyType, value: unknown): Promise<unknown>;
  /** Removes one key. */
  delete(key: DenoKvKeyType): Promise<void>;
  /** Starts one optimistic transaction for the logical visibility mutation. */
  atomic(): DenoKvAtomicType;
  /**
   * Streams keys through Deno KV's native selector contract.
   *
   * The driver currently uses prefix-based listing, but the wider selector type
   * keeps the structural contract compatible with the real Deno KV API.
   */
  list<T = unknown>(
    selector: DenoKvListSelectorType,
    options?: DenoKvListOptionsType,
  ): AsyncIterable<DenoKvEntryType<T>>;
  /** Closes the database when the caller transfers ownership. */
  close?(): void;
}

/** Options for explicit reclamation of superseded or unpublished Deno KV body parts. */
export interface DenoKvCollectOptionsType {
  /** Opaque continuation returned by a bounded previous pass. */
  readonly cursor?: string;
  /**
   * Minimum retirement age before physical parts can be removed.
   *
   * Defaults to one hour. Published generations measure this delay from the
   * moment they are retired, so a long-lived generation is not reclaimed
   * immediately after an overwrite. Unpublished work becomes eligible only after
   * its writer lease expires. Every deletion also requires a versioned claim.
   */
  readonly minAgeMs?: number;
  /** Maximum part deletions in one call. Defaults to 10,000. */
  readonly maxDeletes?: number;
  /** Maximum state/part records scanned. Defaults to 20,000. */
  readonly maxScans?: number;
  /** Maximum pin records examined. Defaults to 1,000. */
  readonly maxPinScans?: number;
  /** Reclaimed state retention before removing its fence record. Defaults to one hour. */
  readonly tombstoneAgeMs?: number;
  /** Cancels scanning and deletion between provider operations. */
  readonly signal?: AbortSignal;
}

/** Result of one bounded Deno KV physical-generation collection pass. */
export interface DenoKvCollectResultType {
  /** Distinct physical generations inspected. */
  readonly generations: number;
  /** Physical part keys inspected. */
  readonly parts: number;
  /** Unreachable physical part keys removed. */
  readonly deleted: number;
  /** Reachable or grace-period physical part keys retained. */
  readonly retained: number;
  /** True when `maxDeletes`, `maxScans` or `maxPinScans` stopped the pass early; continue with `cursor`. */
  readonly truncated: boolean;
  /** Generations kept because they are published, still being written, or retired less than `minAgeMs` ago. */
  readonly active: number;
  /** Generations kept because a reader still holds an unexpired pin. */
  readonly pinned: number;
  /** Generations skipped because a pin or state change raced the pass; a later pass retries them. */
  readonly conflicts: number;
  /** State, part and pin records read, counted against `maxScans`. */
  readonly scanned: number;
  /** Expired reader pins released by this pass. */
  readonly prunedPins: number;
  /** Continue this pass with collect({ cursor }); absent means the scan completed. */
  readonly cursor?: string;
}

/** Live partition retention and operation-owned unknown-reader cleanup count. */
export type DenoKvUsageType = KvUsageType & { readonly pendingReaders: number };

/** Deno KV record driver with explicit physical maintenance. */
export interface DenoKvDriverType extends RecordDriverType {
  /** Reclaims old part generations that are not referenced by a published manifest. */
  collect(options?: DenoKvCollectOptionsType): Promise<DenoKvCollectResultType>;
  /** Explicit live retention probe; inspect remains I/O-free. */
  probe(): Promise<DenoKvUsageType>;
  /** Configured maintenance policy, excluding live state. */
  readonly maintenance: {
    readonly layout: "deno-kv-parts-v3";
    readonly writerLeaseMs: number;
    readonly readerLeaseMs: number;
    readonly maxReaders: number;
    readonly maxRetainedBytes?: number;
    readonly maxGenerations?: number;
  };
}

/** Configuration for the Deno KV record driver and its physical partition layout. */
export interface DenoKvDriverOptionsType extends GenerationOptionsType {
  /** Key namespace. Defaults to `okikio-opfs`. */
  readonly prefix?: string;
  /** Closes the injected KV database with the driver. */
  readonly disposeDatabase?: boolean;
  /** Prevents mutations. */
  readonly readOnly?: boolean;
  /** Physical large-file layout. Defaults to `auto`. */
  readonly partition?: PartitionModeType;
  /** Maximum decoded bytes in one partition. Defaults to 48 KiB. */
  readonly partBytes?: number;
  /** Maximum decoded bytes stored as one normal record in `auto` mode. Defaults to 32 KiB. */
  readonly inlineBytes?: number;
  /** Maximum physical part count for one logical file. Defaults to 10,000. */
  readonly maxParts?: number;
  /** Maximum concurrent exact part reads/deletes. Defaults to 8. */
  readonly concurrency?: number;
}
