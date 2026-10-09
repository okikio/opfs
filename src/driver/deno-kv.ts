import { type GenerationOptionsType, KvGeneration, type KvPinType, type KvUsageType } from "./generation.ts";
import { map as pooledMap } from "../pool.ts";
import { concat } from "@std/bytes";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { z } from "zod";

import { FileSystemError, throwIfAborted } from "../error.ts";
import { defineRecordDriver, type RecordBackendType, type RecordDriverType, type RecordListType } from "./record.ts";
import {
  type ActionType,
  DriverPlanInputSchema,
  type DriverPlanInputType,
  DriverPlanSchema,
  type DriverPlanType,
  type ProblemType,
} from "./definition.ts";
import type { FileDriverReadOptionsType, FileDriverWriteOptionsType } from "./file.ts";
import { basename, dirname } from "../path.ts";
import { open } from "../chunk.ts";
import { aggregate, close } from "../close.ts";
import { isBytes } from "../bytes.ts";
import { retire as retireBytes } from "../stream.ts";
import {
  PartitionModeSchema,
  type PartitionModeType,
  PathSchema,
  RecordSchema,
  type RecordType,
  type WriteModeType,
} from "../schema.ts";

/** Maximum serialized Deno KV key size documented by the runtime. */
export const DENO_KV_MAX_KEY_BYTES = 2 * 1024;
/** Maximum serialized Deno KV value size documented by the runtime. */
export const DENO_KV_MAX_VALUE_BYTES = 64 * 1024;
/** Maximum total serialized size of one Deno KV atomic operation. */
export const DENO_KV_MAX_ATOMIC_BYTES = 800 * 1024;
/** Conservative raw Uint8Array payload budget below the serialized 64 KiB provider ceiling. */
export const DENO_KV_SAFE_PART_BYTES = 60 * 1024;
/** Conservative decoded inline body budget after base64 expansion and record metadata. */
export const DENO_KV_SAFE_INLINE_BYTES = 40 * 1024;
/** Conservative decoded payload kept in one raw binary part. */
export const DENO_KV_DEFAULT_PART_BYTES = 48 * 1024;
/** Conservative decoded payload kept inline with filesystem metadata. */
export const DENO_KV_DEFAULT_INLINE_BYTES = 32 * 1024;
/** Explicit safety ceiling that prevents one logical file from creating unbounded keys. */
export const DENO_KV_DEFAULT_MAX_PARTS = 10_000;
/** Default concurrent exact reads/deletes for partitioned file bodies. */
export const DENO_KV_DEFAULT_CONCURRENCY = 8;
/** Default grace period before superseded or unpublished physical generations are eligible for collection. */
export const DENO_KV_DEFAULT_COLLECT_AGE_MS = 60 * 60 * 1000;
/** Default deletion budget for one explicit collection pass. */
export const DENO_KV_DEFAULT_COLLECT_DELETES = 10_000;

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
  /** True when `maxDeletes` stopped the pass before the prefix scan ended. */
  readonly truncated: boolean;
  readonly active: number;
  readonly pinned: number;
  readonly conflicts: number;
  readonly scanned: number;
  readonly prunedPins: number;
  /** Continue this pass with collect({ cursor }); absent means the scan completed. */
  readonly cursor?: string;
}

/** Live partition retention and operation-owned unknown-reader cleanup count. */
export type DenoKvUsageType = KvUsageType & { readonly pendingReaders: number };

/** A dispatched visibility commit whose outcome could not be reconciled from its own generation state. */
export class DenoKvCommitError extends FileSystemError {
  /** A lost response can follow an applied commit; retry requires application reconciliation. */
  readonly effect = "unknown" as const;
  constructor(operation: string, path: string, cause: unknown) {
    super(
      "unknown",
      operation,
      path,
      "Deno KV visibility commit outcome is unknown; inspect logical state before replaying publication.",
      cause,
    );
  }
}

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

/** File metadata retained in the small manifest committed after all body parts. */
const DenoKvFileSchema = z.object({
  version: z.literal(1),
  path: PathSchema,
  parent: PathSchema,
  name: z.string(),
  kind: z.literal("file"),
  size: z.number().int().nonnegative(),
  lastModified: z.number().int().nonnegative(),
  mediaType: z.string(),
}).strict();

/** Durable pointer to one generation of raw Deno KV body parts. */
const DenoKvManifestSchema = z.object({
  storage: z.literal("deno-kv-parts-v3"),
  generation: z.string().min(1),
  parts: z.number().int().positive(),
  partBytes: z.number().int().positive(),
  file: DenoKvFileSchema,
}).strict().refine(
  (manifest) => manifest.parts === Math.max(1, Math.ceil(manifest.file.size / manifest.partBytes)),
  { message: "Partition count must match the logical file size and physical part size." },
);

/** Validated private manifest that publishes one complete partition generation. */
type DenoKvManifestType = z.output<typeof DenoKvManifestSchema>;

/** Physical value stored at one logical entry key: inline record or partition manifest. */
type DenoKvStoredType = RecordType | DenoKvManifestType;

/** Parsed logical entry plus the Deno KV version that protects its visibility mutation. */
type DenoKvStoredEntryType = DenoKvEntryType<DenoKvStoredType>;

/** Maps one exact virtual path to a Deno KV entry key derived from its parent and name. */
function key(prefix: string, path: string): DenoKvKeyType {
  return [prefix, "entry", dirname(path), basename(path)];
}

/** Prefix whose entries are exactly the direct children of one canonical parent path. */
function listKey(prefix: string, parent: string): DenoKvKeyType {
  return [prefix, "entry", parent];
}

/** Maps one logical file generation and part number to a separate raw binary key. */
function partKey(prefix: string, path: string, generation: string, index: number): DenoKvKeyType {
  return [prefix, "part", path, generation, index];
}

/** Validates a positive safe integer configuration value. */
function positive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new RangeError(`${name} must be a positive safe integer.`);
  return resolved;
}

/** Validates physical part policy before any derived logical-size arithmetic is used. */
function validateSizePolicy(partBytes: number, inlineBytes: number, maxParts: number): void {
  if (partBytes > DENO_KV_SAFE_PART_BYTES) {
    throw new RangeError(
      `partBytes must be <= ${DENO_KV_SAFE_PART_BYTES} bytes so serialization overhead stays below ` +
        `Deno KV's ${DENO_KV_MAX_VALUE_BYTES}-byte value ceiling.`,
    );
  }
  if (inlineBytes > DENO_KV_SAFE_INLINE_BYTES) {
    throw new RangeError(
      `inlineBytes must be <= ${DENO_KV_SAFE_INLINE_BYTES} decoded bytes so base64 data plus record metadata ` +
        "stays below Deno KV's serialized value ceiling.",
    );
  }
  if (maxParts > Math.floor(Number.MAX_SAFE_INTEGER / partBytes)) {
    throw new RangeError("maxParts and partBytes must produce an exactly representable logical file-size limit.");
  }
}

/** Returns true when a stored value is the private partition manifest rather than a public record. */
function isManifest(value: unknown): value is DenoKvManifestType {
  return typeof value === "object" && value !== null && (value as { storage?: unknown }).storage === "deno-kv-parts-v3";
}

/** Projects a manifest to listing metadata without reading any body part. */
function manifestList(manifest: DenoKvManifestType): RecordListType {
  return manifest.file;
}

/** Creates one new generation identifier without depending on Deno globals. */
function generation(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

/** UTF-8 encoder used for conservative Deno KV tuple-size planning. */
const keyEncoder = new TextEncoder();

/** Conservatively estimates serialized tuple bytes for the key component types used here. */
function estimateKeyBytes(value: DenoKvKeyType): number {
  let bytes = 0;
  for (const component of value) {
    bytes += 16;
    if (typeof component === "string") bytes += keyEncoder.encode(component).byteLength;
    else if (typeof component === "number") bytes += 8;
    else bytes += 32;
  }
  return bytes;
}

/** Creates a path-aware Deno KV plan before any provider request is sent. */
function createDenoKvPlan(options: DenoKvDriverOptionsType, input: DriverPlanInputType): DriverPlanType {
  const request = DriverPlanInputSchema.parse(input);
  const partition = PartitionModeSchema.parse(options.partition ?? "auto");
  const prefix = `${options.prefix ?? "okikio-opfs"}:v3`;
  const partBytes = positive(options.partBytes, DENO_KV_DEFAULT_PART_BYTES, "partBytes");
  const inlineBytes = positive(options.inlineBytes, DENO_KV_DEFAULT_INLINE_BYTES, "inlineBytes");
  const maxParts = positive(options.maxParts, DENO_KV_DEFAULT_MAX_PARTS, "maxParts");
  validateSizePolicy(partBytes, inlineBytes, maxParts);
  const problems: ProblemType[] = [];
  const actions: ActionType[] = [];
  if (request.path !== undefined) {
    const entryBytes = estimateKeyBytes(key(prefix, request.path));
    const partBytesEstimate = estimateKeyBytes(
      [
        prefix,
        "pin",
        request.path,
        "00000000000-00000000-0000-4000-8000-000000000000",
        "00000000-0000-4000-8000-000000000000",
      ],
    );
    const estimated = Math.max(entryBytes, partBytesEstimate);
    if (estimated > DENO_KV_MAX_KEY_BYTES) {
      problems.push({
        code: "key-too-large",
        layer: "driver",
        severity: "error",
        message: `Deno KV physical key estimate ${estimated} bytes exceeds the ${DENO_KV_MAX_KEY_BYTES}-byte ` +
          `serialized provider limit for '${request.path}'.`,
        limit: {
          code: "serialized-key-bytes",
          kind: "hard",
          source: "provider",
          unit: "bytes",
          value: DENO_KV_MAX_KEY_BYTES,
        },
      });
      actions.push({ kind: "reduce-input" }, { kind: "select-driver" });
    }
  }
  let support: "native" | "partitioned" | "unsupported" = "native";
  let count: number | undefined;
  if (request.operation === "write" && request.size !== undefined) {
    const usesParts = partition === "always" || (partition === "auto" && request.size > inlineBytes);
    if (partition === "never" && request.size > inlineBytes) {
      support = "unsupported";
      problems.push({
        code: "partition-disabled",
        layer: "driver",
        severity: "error",
        message:
          `The ${request.size}-byte write exceeds inlineBytes=${inlineBytes}, but Deno KV partitioning is disabled.`,
      });
      actions.push({ kind: "change-policy" }, { kind: "select-driver" });
    } else if (usesParts) {
      support = "partitioned";
      count = Math.max(1, Math.ceil(request.size / partBytes));
      if (count > maxParts) {
        support = "unsupported";
        problems.push({
          code: "too-many-parts",
          layer: "driver",
          severity: "error",
          message: `The write needs ${count} Deno KV parts, above configured maxParts=${maxParts}.`,
          limit: {
            code: "parts",
            kind: "policy",
            source: "user",
            unit: "count",
            value: maxParts,
          },
        });
        actions.push({ kind: "change-policy" }, { kind: "select-driver" });
      }
    }
  }
  const supported = support !== "unsupported" && problems.every((problem) => problem.severity !== "error");
  return DriverPlanSchema.parse({
    operation: request.operation,
    supported,
    support: supported ? support : "unsupported",
    ...(count === undefined ? {} : { parts: count, partBytes }),
    problems,
    actions,
  });
}

/**
 * Record-store projection over one caller-owned Deno KV database.
 *
 * Logical entries are keyed as `(namespace, "entry", parentPath, name)`. This
 * keeps exact lookup deterministic while a parent-prefix list contains only
 * direct children, not the complete descendant subtree.
 *
 * Deno KV limits one serialized value to 64 KiB. A normal filesystem file can
 * be much larger, so the default `auto` policy stores small records inline and
 * large file bodies as raw `Uint8Array` parts. All parts of a new generation
 * are written first and the small manifest is written last:
 *
 * ```text
 * old manifest -> old parts
 *
 * write new part 0..N
 *         |
 *         v
 * check old versionstamp
 *         |
 *         v
 * atomic state publication/retirement + manifest commit
 *                  <- visibility point
 *         |
 *         v
 * explicit claimed collect() after grace and pin release
 * ```
 *
 * Readers that pin the previous manifest can continue reading its
 * immutable parts during the configured retirement grace. Superseded parts are therefore
 * not deleted inline. `collect()` reclaims them only after their retirement
 * grace period. A process crash before manifest publication can still leave an
 * unpublished generation; collection uses its creation time when no retirement
 * marker exists.
 */
class DenoKvBackend implements RecordBackendType {
  /** Optional byte lanes that keep large logical files out of generic base64 record materialization. */
  readonly capabilities;
  /** Deno KV-compatible database borrowed from the caller. */
  readonly #database: DenoKvType;
  /** First key tuple component reserved for this filesystem. */
  readonly #prefix: string;
  readonly #legacyPrefix: string;
  readonly #generation: KvGeneration;
  #ready: Promise<void> | undefined;
  /** Whether store disposal also closes the injected database. */
  readonly #disposeDatabase: boolean;
  /** Prevents logical mutations and collection. Read leases still mutate private accounting. */
  readonly #readOnly: boolean;
  /** Large logical-file policy. */
  readonly #partition: PartitionModeType;
  /** Decoded bytes stored in one physical part. */
  readonly #partBytes: number;
  /** Largest decoded body stored inline under the conservative provider ceiling. */
  readonly #inlineBytes: number;
  /** Maximum physical parts for one logical file. */
  readonly #maxParts: number;
  /** Concurrent exact part I/O ceiling. */
  readonly #concurrency: number;

  /** Resolves namespace, ownership, and physical layout once. */
  constructor(database: DenoKvType, options: DenoKvDriverOptionsType) {
    this.#database = database;
    this.#legacyPrefix = options.prefix ?? "okikio-opfs";
    this.#prefix = `${this.#legacyPrefix}:v3`;
    this.#generation = new KvGeneration(database, this.#prefix, options);
    this.#disposeDatabase = options.disposeDatabase ?? false;
    this.#readOnly = options.readOnly ?? false;
    this.#partition = PartitionModeSchema.parse(options.partition ?? "auto");
    this.#partBytes = positive(options.partBytes, DENO_KV_DEFAULT_PART_BYTES, "partBytes");
    this.#inlineBytes = positive(options.inlineBytes, DENO_KV_DEFAULT_INLINE_BYTES, "inlineBytes");
    this.#maxParts = positive(options.maxParts, DENO_KV_DEFAULT_MAX_PARTS, "maxParts");
    this.#concurrency = positive(options.concurrency, DENO_KV_DEFAULT_CONCURRENCY, "concurrency");
    validateSizePolicy(this.#partBytes, this.#inlineBytes, this.#maxParts);
    const streamWriteModes: readonly WriteModeType[] = this.#partition === "never" ? [] : ["replace"];
    this.capabilities = {
      rangeRead: true,
      streamRead: true,
      writeModes: ["replace", "append", "update"],
      streamWriteModes,
    } as const;
  }

  /** Refuses implicit cutover of a legacy namespace; mixed live writers cannot share fences. */
  #open(): Promise<void> {
    if (this.#ready !== undefined) return this.#ready;
    this.#ready = (async () => {
      for await (const _ of this.#database.list({ prefix: [this.#legacyPrefix, "entry"] }, { limit: 1 })) {
        throw new TypeError(
          `Legacy Deno KV namespace '${this.#legacyPrefix}' needs a quiescent export/import into a fresh prefix before v3 maintenance is enabled.`,
        );
      }
      await this.#generation.open();
    })().catch((error) => {
      this.#ready = undefined;
      throw error;
    });
    return this.#ready;
  }

  async probe(): Promise<DenoKvUsageType> {
    await this.#open();
    return await this.#generation.probe();
  }

  /** Pins the observed logical generation; replacement during acquisition causes an explicit retryable conflict. */
  async #pin(path: string, generation: string): Promise<KvPinType> {
    const entry = await this.#entry(path);
    if (entry.value === null || !isManifest(entry.value) || entry.value.generation !== generation) {
      throw new FileSystemError(
        "locked",
        "read",
        path,
        "File changed before generation pin admission; retry the read.",
      );
    }
    return await this.#generation.pin(path, generation, entry);
  }

  /** Reads one exact logical entry and retains its provider version for a later optimistic commit. */
  async #entry(path: string): Promise<DenoKvStoredEntryType> {
    await this.#open();
    const entry = await this.#database.get<unknown>(key(this.#prefix, path));
    const value = entry.value === null
      ? null
      : isManifest(entry.value)
      ? DenoKvManifestSchema.parse(entry.value)
      : RecordSchema.parse(entry.value);
    return { key: entry.key, value, versionstamp: entry.versionstamp };
  }

  /** Reads one exact stored logical value without following a partition manifest. */
  async #stored(path: string): Promise<DenoKvStoredType | null> {
    return (await this.#entry(path)).value;
  }

  /**
   * Validates one immutable physical part before any bytes leave the driver.
   *
   * The manifest fixes each part's logical position, so equal total length is
   * insufficient: a short part followed by an oversized part would shift range
   * reads and could corrupt a later patch. Empty files own one empty part. Pins
   * and their retirement remain owned by the caller of this read.
   */
  async #part(path: string, manifest: DenoKvManifestType, index: number): Promise<Uint8Array> {
    const entry = await this.#database.get<Uint8Array>(partKey(this.#prefix, path, manifest.generation, index));
    if (!isBytes(entry.value)) {
      throw new FileSystemError(
        "unknown",
        "read",
        path,
        `Deno KV file '${path}' is missing or has invalid physical part ${index} of ${manifest.parts}.`,
      );
    }
    const expected = Math.min(manifest.partBytes, manifest.file.size - index * manifest.partBytes);
    if (entry.value.byteLength !== expected) {
      throw new FileSystemError(
        "unknown",
        "read",
        path,
        `Deno KV physical part ${index} of '${path}' has ${entry.value.byteLength} bytes; expected ${expected}.`,
      );
    }
    return entry.value;
  }

  /** Returns logical metadata without joining any partition body. */
  async stat(path: Parameters<NonNullable<RecordBackendType["stat"]>>[0]): Promise<RecordListType | null> {
    const stored = await this.#stored(path);
    if (stored === null) return null;
    return isManifest(stored) ? manifestList(stored) : stored;
  }

  /** Reads and validates one exact logical record, joining parts only for an exact file read. */
  async get(path: Parameters<RecordBackendType["get"]>[0]): Promise<RecordType | null> {
    const stored = await this.#stored(path);
    if (stored === null) return null;
    if (!isManifest(stored)) return stored;

    const manifest = stored;
    const pin = await this.#pin(path, manifest.generation);
    let primary: readonly unknown[] = [];
    try {
      const chunks = new Array<Uint8Array>(manifest.parts);
      const indexes = Array.from({ length: manifest.parts }, (_, index) => index);
      for await (
        const result of pooledMap(this.#concurrency, indexes, async (index) => {
          await pin.check();
          const bytes = await this.#part(path, manifest, index);
          await pin.check();
          return { index, bytes };
        })
      ) chunks[result.index] = result.bytes;

      const bytes = concat(chunks);
      if (bytes.byteLength !== manifest.file.size) {
        throw new FileSystemError(
          "unknown",
          "read",
          path,
          `Deno KV file '${path}' reconstructed ${bytes.byteLength} bytes; manifest expects ${manifest.file.size}.`,
        );
      }
      return RecordSchema.parse({ ...manifest.file, data: encodeBase64(bytes) });
    } catch (reason) {
      primary = [reason];
      throw reason;
    } finally {
      await close([() => pin.release()], primary);
    }
  }

  /**
   * Reads only physical parts that overlap the requested logical byte range.
   *
   * This is the critical difference from a generic record store: a 500 MiB
   * partitioned file can satisfy a 4 KiB read without reconstructing 500 MiB or
   * allocating a 500 MiB base64 record first.
   */
  async readFile(
    path: Parameters<NonNullable<RecordBackendType["readFile"]>>[0],
    options: FileDriverReadOptionsType = {},
  ): Promise<Uint8Array> {
    throwIfAborted(options.signal, "read", path);
    const stored = await this.#stored(path);
    if (stored === null) throw new FileSystemError("not-found", "read", path, `File '${path}' does not exist.`);
    if (!isManifest(stored)) {
      if (stored.kind !== "file") throw new FileSystemError("type-mismatch", "read", path, `'${path}' is a directory.`);
      const bytes = decodeBase64(stored.data);
      const start = Math.min(options.at ?? 0, bytes.byteLength);
      const end = options.length === undefined ? bytes.byteLength : Math.min(bytes.byteLength, start + options.length);
      return bytes.slice(start, end);
    }

    const manifest = stored;
    const pin = await this.#pin(path, manifest.generation);
    let primary: readonly unknown[] = [];
    try {
      const start = Math.min(options.at ?? 0, manifest.file.size);
      const end = options.length === undefined
        ? manifest.file.size
        : Math.min(manifest.file.size, start + options.length);
      if (start === end) return new Uint8Array();

      const first = Math.floor(start / manifest.partBytes);
      const last = Math.ceil(end / manifest.partBytes);
      const indexes = Array.from({ length: last - first }, (_, offset) => first + offset);
      const chunks = new Array<Uint8Array>(indexes.length);
      for await (
        const result of pooledMap(this.#concurrency, indexes, async (index) => {
          throwIfAborted(options.signal, "read", path);
          await pin.check();
          const bytes = await this.#part(path, manifest, index);
          await pin.check();
          return { index, bytes };
        })
      ) chunks[result.index - first] = result.bytes;

      const joined = concat(chunks);
      const localStart = start - first * manifest.partBytes;
      const result = joined.slice(localStart, localStart + (end - start));
      if (result.byteLength !== end - start) {
        throw new FileSystemError(
          "unknown",
          "read",
          path,
          `Deno KV range for '${path}' reconstructed ${result.byteLength} bytes; expected ${end - start}.`,
        );
      }
      return result;
    } catch (reason) {
      primary = [reason];
      throw reason;
    } finally {
      await close([() => pin.release()], primary);
    }
  }

  /**
   * Streams partitioned bytes one physical part at a time under consumer backpressure.
   *
   * One part is resident in this layer at a time. The provider request itself is
   * not cancellable through Deno KV, so an abort can stop before the next part
   * but cannot revoke an exact get that the runtime has already started.
   */
  async openReadStream(
    path: Parameters<NonNullable<RecordBackendType["openReadStream"]>>[0],
    options: FileDriverReadOptionsType = {},
  ): Promise<ReadableStream<Uint8Array>> {
    throwIfAborted(options.signal, "read", path);
    const stored = await this.#stored(path);
    if (stored === null) throw new FileSystemError("not-found", "read", path, `File '${path}' does not exist.`);
    if (!isManifest(stored)) {
      if (stored.kind !== "file") throw new FileSystemError("type-mismatch", "read", path, `'${path}' is a directory.`);
      const bytes = await this.readFile(path, options);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          if (bytes.byteLength > 0) controller.enqueue(bytes);
          controller.close();
        },
      });
    }

    const manifest = stored;
    const start = Math.min(options.at ?? 0, manifest.file.size);
    const end = options.length === undefined
      ? manifest.file.size
      : Math.min(manifest.file.size, start + options.length);
    let index = Math.floor(start / manifest.partBytes);
    const last = Math.ceil(end / manifest.partBytes);
    const first = index;
    const readPart = (index: number): Promise<Uint8Array> => this.#part(path, manifest, index);
    const signal = options.signal;
    const pin = await this.#pin(path, manifest.generation);

    type ReadOutcomeType =
      | { readonly ok: true; readonly value: { readonly complete: boolean; readonly chunk?: Uint8Array } }
      | { readonly ok: false; readonly reason: unknown };
    type ReleaseOutcomeType = { readonly ok: true } | { readonly ok: false; readonly reason: unknown };
    let pending: Promise<ReadOutcomeType> | undefined;
    let cancelled = false;
    let retirement: Promise<ReleaseOutcomeType> | undefined;
    // One physical release and terminal result belongs to the first terminal
    // owner. Cancellation joins a real in-flight get; the database cannot revoke it.
    const finish = (primary: readonly unknown[] = []): Promise<ReleaseOutcomeType> =>
      retirement ??= close(
        [() => pin.release()],
        primary,
      ).then(() => ({ ok: true }), (reason: unknown) => ({ ok: false, reason }));
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const read = async (): Promise<{ readonly complete: boolean; readonly chunk?: Uint8Array }> => {
          await pin.check();
          throwIfAborted(signal, "read", path);
          if (start === end || index >= last) return { complete: true };
          const bytes = await readPart(index);
          throwIfAborted(signal, "read", path);
          await pin.check();
          const physicalStart = index * manifest.partBytes;
          const from = index === first ? start - physicalStart : 0;
          const to = index === last - 1 ? Math.min(bytes.byteLength, end - physicalStart) : bytes.byteLength;
          index += 1;
          return { complete: index >= last, ...(to > from ? { chunk: bytes.slice(from, to) } : {}) };
        };
        pending = read().then(
          (value): ReadOutcomeType => ({ ok: true, value }),
          (reason: unknown): ReadOutcomeType => ({ ok: false, reason }),
        );
        const result = await pending;
        if (cancelled) return;
        if (result.ok && result.value.chunk !== undefined) controller.enqueue(result.value.chunk);
        if (result.ok && !result.value.complete) {
          pending = undefined;
          return;
        }
        const retired = await finish(result.ok ? [] : [result.reason]);
        if (cancelled) return;
        if (retired.ok) controller.close();
        else controller.error(retired.reason);
      },
      async cancel() {
        cancelled = true;
        const read = await pending;
        const retired = await finish(read === undefined || read.ok ? [] : [read.reason]);
        if (!retired.ok) throw retired.reason;
      },
    });
  }

  /**
   * Reads one range from a previously resolved value without materializing the
   * complete logical file.
   *
   * Patch writes use this while constructing a new immutable generation. An
   * inline predecessor is small by configuration, while a partitioned
   * predecessor reads only the physical parts that overlap the requested
   * output part.
   */
  async #readRange(
    path: string,
    stored: DenoKvStoredType,
    at: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (length === 0) return new Uint8Array();
    throwIfAborted(signal, "read", path);
    if (!isManifest(stored)) {
      if (stored.kind !== "file") throw new FileSystemError("type-mismatch", "read", path, `'${path}' is a directory.`);
      return decodeBase64(stored.data).slice(at, at + length);
    }

    const pin = await this.#pin(path, stored.generation);
    let primary: readonly unknown[] = [];
    try {
      const start = Math.min(at, stored.file.size);
      const end = Math.min(stored.file.size, start + length);
      if (start === end) return new Uint8Array();
      const first = Math.floor(start / stored.partBytes);
      const last = Math.ceil(end / stored.partBytes);
      const chunks: Uint8Array[] = [];
      for (let index = first; index < last; index += 1) {
        throwIfAborted(signal, "read", path);
        await pin.check();
        const bytes = await this.#part(path, stored, index);
        await pin.check();
        chunks.push(bytes);
      }

      const joined = concat(chunks);
      const localStart = start - first * stored.partBytes;
      return joined.slice(localStart, localStart + (end - start));
    } catch (reason) {
      primary = [reason];
      throw reason;
    } finally {
      await close([() => pin.release()], primary);
    }
  }

  /**
   * Atomically changes logical visibility after all new physical parts exist.
   *
   * Deno KV's version check prevents an independent writer from publishing over
   * stale state. When the previous value is partitioned, the same transaction
   * writes its retirement timestamp and then replaces or deletes the logical
   * entry. The transaction contains only small metadata, so file bodies stay
   * outside the provider's atomic-operation byte ceiling.
   */
  async #commit(
    path: string,
    previous: DenoKvStoredEntryType,
    next: DenoKvStoredType | undefined,
    operation: "write" | "remove",
    signal?: AbortSignal,
  ): Promise<void> {
    for (let retry = 0; retry < this.#generation.maxRetries; retry++) {
      const current = await this.#entry(path);
      if (current.versionstamp !== previous.versionstamp) {
        throw new FileSystemError(
          "locked",
          operation,
          path,
          "Logical entry changed during preparation; retry the operation.",
        );
      }
      const transaction = this.#database.atomic().check(previous);
      const nextGeneration = next !== undefined && isManifest(next) ? next.generation : undefined;
      const previousGeneration = previous.value !== null && isManifest(previous.value)
        ? previous.value.generation
        : undefined;
      await this.#generation.publish(transaction, path, nextGeneration, previousGeneration);
      if (next === undefined) transaction.delete(previous.key);
      else transaction.set(previous.key, next);
      throwIfAborted(signal, operation, path);
      try {
        const result = await transaction.commit();
        if (!result.ok) continue; // Reader pin metadata may have changed; refresh its fence.
        if (nextGeneration !== undefined) this.#generation.finish(nextGeneration);
        return;
      } catch (error) {
        try {
          if (nextGeneration !== undefined && await this.#generation.published(path, nextGeneration)) {
            this.#generation.finish(nextGeneration);
            return; // Own durable state reconciles an applied-but-unacknowledged publication.
          }
        } catch (reconcile) {
          throw new DenoKvCommitError(
            operation,
            path,
            aggregate([error, reconcile], "Commit response and own-state reconciliation failed."),
          );
        }
        throw new DenoKvCommitError(operation, path, error);
      }
    }
    throw new FileSystemError("locked", operation, path, "Visibility commit exceeded its bounded contention budget.");
  }

  /**
   * Commits materialized replace, append, and update writes without rebuilding
   * a complete base64 record.
   *
   * Replace can write the supplied bytes directly. Append/update construct a
   * new immutable generation one provider part at a time. Existing bytes are
   * read only for the output part currently being built, so a small patch to a
   * large partitioned file does not allocate the old logical file in memory.
   */
  async writeFile(
    path: Parameters<NonNullable<RecordBackendType["writeFile"]>>[0],
    data: Uint8Array,
    options: FileDriverWriteOptionsType,
  ): Promise<void> {
    throwIfAborted(options.signal, "write", path);
    const previousEntry = await this.#entry(path);
    const previousStored = previousEntry.value;
    if (previousStored !== null && !isManifest(previousStored) && previousStored.kind === "directory") {
      throw new FileSystemError("type-mismatch", "write", path, `'${path}' is a directory.`);
    }
    const previous = previousStored === null ? null : isManifest(previousStored) ? previousStored.file : previousStored;
    const previousSize = previous?.kind === "file" ? previous.size : 0;
    const position = options.mode === "append" ? previousSize : options.mode === "update" ? options.at ?? 0 : 0;
    const outputSize = options.mode === "replace"
      ? data.byteLength
      : options.truncate
      ? position + data.byteLength
      : Math.max(previousSize, position + data.byteLength);
    const file = {
      version: 1 as const,
      path,
      parent: dirname(path),
      name: basename(path),
      kind: "file" as const,
      size: outputSize,
      lastModified: Date.now(),
      mediaType: options.mediaType ?? (previous?.kind === "file" ? previous.mediaType : ""),
    };

    if (options.mode === "replace") {
      await this.#saveFile(file, data, previousEntry, options.signal);
      return;
    }

    const useParts = this.#partition === "always" || (this.#partition === "auto" && outputSize > this.#inlineBytes);
    if (!useParts) {
      if (outputSize > this.#inlineBytes && this.#partition === "never") {
        throw new FileSystemError(
          "too-large",
          "write",
          path,
          `Deno KV file is ${outputSize} bytes; configured inlineBytes is ${this.#inlineBytes}. Enable partitioning or lower the logical write size.`,
        );
      }
      const output = new Uint8Array(outputSize);
      if (previousStored !== null && previousSize > 0) {
        output.set(await this.#readRange(path, previousStored, 0, Math.min(previousSize, outputSize), options.signal));
      }
      output.set(data, position);
      await this.#saveFile(file, output, previousEntry, options.signal);
      return;
    }

    const partCount = Math.max(1, Math.ceil(outputSize / this.#partBytes));
    if (partCount > this.#maxParts) {
      throw new FileSystemError(
        "too-large",
        "write",
        path,
        `Deno KV file requires ${partCount} parts, above configured maxParts ${this.#maxParts}.`,
      );
    }

    const nextGeneration = generation();
    const indexes = Array.from({ length: partCount }, (_, index) => index);
    try {
      for await (
        const _ of pooledMap(this.#concurrency, indexes, async (index) => {
          throwIfAborted(options.signal, "write", path);
          const start = index * this.#partBytes;
          const end = Math.min(outputSize, start + this.#partBytes);
          const chunk = new Uint8Array(end - start);

          const preservedEnd = Math.min(end, previousSize, outputSize);
          if (previousStored !== null && preservedEnd > start) {
            const preserved = await this.#readRange(path, previousStored, start, preservedEnd - start, options.signal);
            chunk.set(preserved, 0);
          }

          const patchStart = Math.max(start, position);
          const patchEnd = Math.min(end, position + data.byteLength);
          if (patchEnd > patchStart) {
            chunk.set(data.subarray(patchStart - position, patchEnd - position), patchStart - start);
          }
          await this.#generation.part(path, nextGeneration, index, chunk);
        })
      ) {
        // The iterator is consumed so all bounded reads/writes settle before the manifest becomes visible.
      }

      throwIfAborted(options.signal, "write", path);
      const manifest = DenoKvManifestSchema.parse({
        storage: "deno-kv-parts-v3",
        generation: nextGeneration,
        parts: partCount,
        partBytes: this.#partBytes,
        file,
      });
      await this.#commit(path, previousEntry, manifest, "write", options.signal);
    } catch (error) {
      await close([() => this.#deleteGeneration(path, nextGeneration, partCount)], [error]);
      throw error;
    }
  }

  /**
   * Writes an unknown-size replacement directly into Deno KV parts.
   *
   * `auto` uses the partition layout for streams even when the final file is
   * small. The final size is unknown until EOF, and switching from an inline
   * buffer to partitioned storage after a threshold would retain exactly the
   * memory growth this lane exists to avoid. Callers can disable this behavior
   * with `partition: "never"`, which also removes native stream-write support.
   */
  async writeStream(
    path: Parameters<NonNullable<RecordBackendType["writeStream"]>>[0],
    source: ReadableStream<Uint8Array>,
    options: FileDriverWriteOptionsType,
  ): Promise<void> {
    try {
      if (options.mode !== "replace" || this.#partition === "never") {
        throw new FileSystemError(
          "not-supported",
          "write",
          path,
          `Deno KV streaming requires partitioned replace mode.`,
        );
      }
      throwIfAborted(options.signal, "write", path);
    } catch (reason) {
      await close([() => retireBytes(source)], [reason]);
      throw reason;
    }
    const inputSignal = new AbortController();
    // The actual caller event creates the public filesystem cancellation reason.
    // Internal mapper-stop interrupts only the byte input, not admitted KV writes.
    const abort = (): void =>
      inputSignal.abort(
        new FileSystemError(
          "aborted",
          "write",
          path,
          `Writing '${path}' was aborted.`,
          options.signal?.reason,
        ),
      );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    let retired = false;
    let nextGeneration: string | undefined;
    let scheduled = 0;
    let primary: readonly unknown[] = [];
    let chunks: ReturnType<typeof open> | undefined;
    const retire = async (): Promise<void> => {
      if (retired) return;
      retired = true;
      if (chunks === undefined) await retireBytes(source);
      else await chunks.return?.();
    };
    try {
      chunks = open(source, this.#partBytes, inputSignal.signal);
      const input = chunks;
      const previousEntry = await this.#entry(path);
      const previousStored = previousEntry.value;
      if (previousStored !== null && !isManifest(previousStored) && previousStored.kind === "directory") {
        throw new FileSystemError("type-mismatch", "write", path, `'${path}' is a directory.`);
      }
      const previousMediaType = previousStored === null
        ? ""
        : isManifest(previousStored)
        ? previousStored.file.mediaType
        : previousStored.kind === "file"
        ? previousStored.mediaType
        : "";
      const ownedGeneration = generation();
      nextGeneration = ownedGeneration;
      const numbered: AsyncIterableIterator<Uint8Array> = {
        next: () => input.next(),
        return: async () => {
          await retire();
          return { done: true, value: undefined };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      let size = 0;
      for await (
        const written of pooledMap(this.#concurrency, numbered, async (chunk) => {
          const index = scheduled++;
          if (index >= this.#maxParts) {
            throw new FileSystemError(
              "too-large",
              "write",
              path,
              `Deno KV stream exceeded configured maxParts ${this.#maxParts}.`,
            );
          }
          throwIfAborted(options.signal, "write", path);
          await this.#generation.part(path, ownedGeneration, index, chunk);
          return { bytes: chunk.byteLength };
        }, { interrupt: () => input.interrupt() })
      ) size += written.bytes;
      if (scheduled === 0) {
        scheduled = 1;
        await this.#generation.part(path, ownedGeneration, 0, new Uint8Array());
      }
      throwIfAborted(options.signal, "write", path);
      const manifest = DenoKvManifestSchema.parse({
        storage: "deno-kv-parts-v3",
        generation: ownedGeneration,
        parts: scheduled,
        partBytes: this.#partBytes,
        file: {
          version: 1,
          path,
          parent: dirname(path),
          name: basename(path),
          kind: "file",
          size,
          lastModified: Date.now(),
          mediaType: options.mediaType ?? previousMediaType,
        },
      });
      await this.#commit(path, previousEntry, manifest, "write", options.signal);
    } catch (reason) {
      primary = [reason];
      throw reason;
    } finally {
      options.signal?.removeEventListener("abort", abort);
      await close([
        retire,
        async () => {
          if (primary.length > 0 && nextGeneration !== undefined) {
            await this.#deleteGeneration(path, nextGeneration, scheduled);
          }
        },
      ], primary);
    }
  }

  /** Replaces one exact logical record and commits partition manifests only after every new part exists. */
  async set(record: RecordType): Promise<void> {
    const previousEntry = await this.#entry(record.path);

    if (record.kind === "directory") {
      await this.#commit(record.path, previousEntry, record, "write");
      return;
    }

    const bytes = decodeBase64(record.data);
    const partition = this.#partition === "always" ||
      (this.#partition === "auto" && bytes.byteLength > this.#inlineBytes);
    if (!partition) {
      if (bytes.byteLength > this.#inlineBytes && this.#partition === "never") {
        throw new FileSystemError(
          "too-large",
          "write",
          record.path,
          `Deno KV inline file is ${bytes.byteLength} bytes; configured inlineBytes is ${this.#inlineBytes}. ` +
            "Enable partitioning or lower the logical write size.",
        );
      }
      await this.#commit(record.path, previousEntry, record, "write");
      return;
    }

    const count = Math.max(1, Math.ceil(bytes.byteLength / this.#partBytes));
    if (count > this.#maxParts) {
      throw new FileSystemError(
        "too-large",
        "write",
        record.path,
        `Deno KV file requires ${count} parts, above configured maxParts ${this.#maxParts}.`,
      );
    }

    const nextGeneration = generation();
    const indexes = Array.from({ length: count }, (_, index) => index);
    try {
      for await (
        const _ of pooledMap(
          this.#concurrency,
          indexes,
          (index) =>
            this.#generation.part(
              record.path,
              nextGeneration,
              index,
              bytes.slice(index * this.#partBytes, (index + 1) * this.#partBytes),
            ),
        )
      ) {
        // pooledMap owns bounded concurrency; values are intentionally ignored.
      }
      const { data: _data, ...file } = record;
      const manifest = DenoKvManifestSchema.parse({
        storage: "deno-kv-parts-v3",
        generation: nextGeneration,
        parts: count,
        partBytes: this.#partBytes,
        file,
      });
      await this.#commit(record.path, previousEntry, manifest, "write");
    } catch (error) {
      await close([() => this.#deleteGeneration(record.path, nextGeneration, count)], [error]);
      throw error;
    }
  }

  /** Removes logical visibility while deferring partition reclamation to explicit collection. */
  async delete(path: Parameters<RecordBackendType["delete"]>[0]): Promise<void> {
    const previousEntry = await this.#entry(path);
    await this.#commit(path, previousEntry, undefined, "remove");
  }

  /** Lists direct children from the parent-indexed entry key and never scans descendant subtrees or partition bodies. */
  async *list(parent: Parameters<RecordBackendType["list"]>[0]): AsyncIterableIterator<RecordListType> {
    await this.#open();
    for await (const entry of this.#database.list<unknown>({ prefix: listKey(this.#prefix, parent) })) {
      if (entry.value === null) continue;
      const record = isManifest(entry.value)
        ? manifestList(DenoKvManifestSchema.parse(entry.value))
        : RecordSchema.parse(entry.value);
      if (record.parent === parent) yield record;
    }
  }

  /** Stores one complete file from bytes while preserving the manifest-last visibility rule. */
  async #saveFile(
    file: z.output<typeof DenoKvFileSchema>,
    bytes: Uint8Array,
    previousEntry: DenoKvStoredEntryType,
    signal?: AbortSignal,
  ): Promise<void> {
    const useParts = this.#partition === "always" ||
      (this.#partition === "auto" && bytes.byteLength > this.#inlineBytes);
    if (!useParts) {
      if (bytes.byteLength > this.#inlineBytes && this.#partition === "never") {
        throw new FileSystemError(
          "too-large",
          "write",
          file.path,
          `Deno KV inline file is ${bytes.byteLength} bytes; configured inlineBytes is ${this.#inlineBytes}. ` +
            "Enable partitioning or lower the logical write size.",
        );
      }
      const record = RecordSchema.parse({ ...file, data: encodeBase64(bytes) });
      await this.#commit(file.path, previousEntry, record, "write", signal);
      return;
    }

    const count = Math.max(1, Math.ceil(bytes.byteLength / this.#partBytes));
    if (count > this.#maxParts) {
      throw new FileSystemError(
        "too-large",
        "write",
        file.path,
        `Deno KV file requires ${count} parts, above configured maxParts ${this.#maxParts}.`,
      );
    }
    const nextGeneration = generation();
    const indexes = Array.from({ length: count }, (_, index) => index);
    try {
      for await (
        const _ of pooledMap(
          this.#concurrency,
          indexes,
          (index) =>
            this.#generation.part(
              file.path,
              nextGeneration,
              index,
              bytes.slice(index * this.#partBytes, (index + 1) * this.#partBytes),
            ),
        )
      ) {
        // pooledMap owns bounded concurrency; values are intentionally ignored.
      }
      const manifest = DenoKvManifestSchema.parse({
        storage: "deno-kv-parts-v3",
        generation: nextGeneration,
        parts: count,
        partBytes: this.#partBytes,
        file,
      });
      await this.#commit(file.path, previousEntry, manifest, "write", signal);
    } catch (error) {
      await close([() => this.#deleteGeneration(file.path, nextGeneration, count)], [error]);
      throw error;
    }
  }

  /** Claims cleanup before deleting, and preserves an acknowledged or uncertain publication. */
  async #deleteGeneration(path: string, value: string, _count: number): Promise<void> {
    await this.#generation.abort(path, value);
  }

  /** Reclaims only CAS-claimed generations; grace never disables writer or reader exclusion. */
  async collect(options: DenoKvCollectOptionsType = {}): Promise<DenoKvCollectResultType> {
    if (this.#readOnly) throw new Error("Deno KV driver is read-only; maintenance is forbidden.");
    throwIfAborted(options.signal, "collect");
    const minAgeMs = options.minAgeMs ?? DENO_KV_DEFAULT_COLLECT_AGE_MS;
    const tombstoneAgeMs = options.tombstoneAgeMs ?? DENO_KV_DEFAULT_COLLECT_AGE_MS;
    for (const value of [minAgeMs, tombstoneAgeMs]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError("Retention ages must be non-negative safe integers.");
      }
    }
    const policy = {
      minAgeMs,
      tombstoneAgeMs,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      maxDeletes: positive(options.maxDeletes, DENO_KV_DEFAULT_COLLECT_DELETES, "maxDeletes"),
      maxScans: positive(options.maxScans, 20_000, "maxScans"),
      maxPinScans: positive(options.maxPinScans, 1_000, "maxPinScans"),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    await this.#open();
    return await this.#generation.collect(policy);
  }

  /** Closes the database only when the driver was given ownership. */
  dispose(): void {
    if (this.#disposeDatabase) this.#database.close?.();
  }
}

/** Creates an independently useful Deno KV record driver. */
export function createDenoKvDriver(database: DenoKvType, options: DenoKvDriverOptionsType = {}): DenoKvDriverType {
  const partition = PartitionModeSchema.parse(options.partition ?? "auto");
  const partBytes = positive(options.partBytes, DENO_KV_DEFAULT_PART_BYTES, "partBytes");
  const inlineBytes = positive(options.inlineBytes, DENO_KV_DEFAULT_INLINE_BYTES, "inlineBytes");
  const maxParts = positive(options.maxParts, DENO_KV_DEFAULT_MAX_PARTS, "maxParts");
  const concurrency = positive(options.concurrency, DENO_KV_DEFAULT_CONCURRENCY, "concurrency");
  validateSizePolicy(partBytes, inlineBytes, maxParts);
  const backend = new DenoKvBackend(database, options);
  const driver = defineRecordDriver(backend, {
    name: "deno-kv",
    capabilities: {
      ...backend.capabilities,
      replacement: "atomic",
      transactions: true,
      binary: true,
    },
    requirements: [{ code: "deno-kv", state: "available" }],
    limits: [
      { code: "serialized-key-bytes", kind: "hard", source: "provider", unit: "bytes", value: DENO_KV_MAX_KEY_BYTES },
      {
        code: "serialized-value-bytes",
        kind: "hard",
        source: "provider",
        unit: "bytes",
        value: DENO_KV_MAX_VALUE_BYTES,
      },
      { code: "atomic-bytes", kind: "hard", source: "provider", unit: "bytes", value: DENO_KV_MAX_ATOMIC_BYTES },
      { code: "part-bytes", kind: "policy", source: "user", unit: "bytes", value: partBytes },
      { code: "inline-bytes", kind: "policy", source: "user", unit: "bytes", value: inlineBytes },
      { code: "parts", kind: "policy", source: "user", unit: "count", value: maxParts },
      { code: "file-bytes", kind: "policy", source: "implementation", unit: "bytes", value: partBytes * maxParts },
      { code: "concurrency", kind: "policy", source: "user", unit: "count", value: concurrency },
    ],
    optimizations: [{
      code: "partition",
      enabled: partition !== "never",
      changesBehavior: true,
      disableable: true,
      detail: `Physical layout mode is ${partition}.`,
    }],
    readOnly: options.readOnly ?? false,
    disposeBackend: options.disposeDatabase ?? false,
    plan: (input) => createDenoKvPlan(options, input),
  });
  return Object.assign(driver, {
    collect: (collectOptions?: DenoKvCollectOptionsType) => backend.collect(collectOptions),
    probe: () => backend.probe(),
    maintenance: {
      layout: "deno-kv-parts-v3" as const,
      writerLeaseMs: options.writerLeaseMs ?? 60_000,
      readerLeaseMs: options.readerLeaseMs ?? 60_000,
      maxReaders: options.maxReaders ?? 64,
      ...(options.maxRetainedBytes === undefined ? {} : { maxRetainedBytes: options.maxRetainedBytes }),
      ...(options.maxGenerations === undefined ? {} : { maxGenerations: options.maxGenerations }),
    },
  });
}
