/// <reference types="deno" />
import { pooledMap } from "@std/async/pool";
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
import { split } from "../chunk.ts";
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

/** Structural Deno KV entry used by the driver. */
export interface DenoKvEntryType<T> {
  /** Stored tuple returned by exact reads and prefix iteration. */
  readonly key: Deno.KvKey;
  /** Stored value, or null for a missing exact get. */
  readonly value: T | null;
  /** Provider version used for optimistic visibility commits. Missing entries use null. */
  readonly versionstamp: string | null;
}

/** Version check accepted by the Deno KV atomic operation. */
export interface DenoKvCheckType {
  /** Exact logical entry key observed before the operation started. */
  readonly key: Deno.KvKey;
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
  set(key: Deno.KvKey, value: unknown): DenoKvAtomicType;
  /** Adds one logical-entry deletion to the transaction. */
  delete(key: Deno.KvKey): DenoKvAtomicType;
  /** Commits checks and metadata mutations atomically. */
  commit(): Promise<DenoKvCommitType>;
}

/** Structural Deno KV subset required by this driver. */
export interface DenoKvType {
  /** Reads one exact key. */
  get<T = unknown>(key: Deno.KvKey): Promise<DenoKvEntryType<T>>;
  /** Replaces one key. */
  set(key: Deno.KvKey, value: unknown): Promise<unknown>;
  /** Removes one key. */
  delete(key: Deno.KvKey): Promise<void>;
  /** Starts one optimistic transaction for the logical visibility mutation. */
  atomic(): DenoKvAtomicType;
  /**
   * Streams keys through Deno KV's native selector contract.
   *
   * The driver currently uses prefix-based listing, but the wider selector type
   * keeps the structural contract compatible with the real Deno KV API.
   */
  list<T = unknown>(selector: Deno.KvListSelector, options?: Deno.KvListOptions): AsyncIterable<DenoKvEntryType<T>>;
  /** Closes the database when the caller transfers ownership. */
  close?(): void;
}

/** Options for explicit reclamation of superseded or unpublished Deno KV body parts. */
export interface DenoKvCollectOptionsType {
  /**
   * Minimum retirement or unpublished-generation age before physical parts can be removed.
   *
   * Defaults to one hour. Published generations measure this delay from the
   * moment they are retired, so a long-lived generation is not reclaimed
   * immediately after an overwrite. Unpublished crash leftovers use generation
   * creation time because no reader could have resolved them through a manifest.
   */
  readonly minAgeMs?: number;
  /** Maximum part deletions in one call. Defaults to 10,000. */
  readonly maxDeletes?: number;
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
}

/** Deno KV record driver with explicit physical maintenance. */
export interface DenoKvDriverType extends RecordDriverType {
  /** Reclaims old part generations that are not referenced by a published manifest. */
  collect(options?: DenoKvCollectOptionsType): Promise<DenoKvCollectResultType>;
}

/** Configuration for the Deno KV record driver and its physical partition layout. */
export interface DenoKvDriverOptionsType {
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
  storage: z.literal("deno-kv-parts-v2"),
  generation: z.string().min(1),
  parts: z.number().int().positive(),
  partBytes: z.number().int().positive(),
  file: DenoKvFileSchema,
}).strict();

/** Validated private manifest that publishes one complete partition generation. */
type DenoKvManifestType = z.output<typeof DenoKvManifestSchema>;

/** Retirement metadata written before a visible generation is superseded or removed. */
const DenoKvRetiredSchema = z.object({
  storage: z.literal("deno-kv-retired-v1"),
  retiredAt: z.number().int().nonnegative(),
}).strict();

/** Validated retirement marker used to delay reclamation after visibility changes. */
type DenoKvRetiredType = z.output<typeof DenoKvRetiredSchema>;

/** Physical value stored at one logical entry key: inline record or partition manifest. */
type DenoKvStoredType = RecordType | DenoKvManifestType;

/** Parsed logical entry plus the Deno KV version that protects its visibility mutation. */
type DenoKvStoredEntryType = DenoKvEntryType<DenoKvStoredType>;

/** Maps one exact virtual path to a Deno KV entry key derived from its parent and name. */
function key(prefix: string, path: string): Deno.KvKey {
  return [prefix, "entry", dirname(path), basename(path)];
}

/** Prefix whose entries are exactly the direct children of one canonical parent path. */
function listKey(prefix: string, parent: string): Deno.KvKey {
  return [prefix, "entry", parent];
}

/** Maps one logical file generation and part number to a separate raw binary key. */
function partKey(prefix: string, path: string, generation: string, index: number): Deno.KvKey {
  return [prefix, "part", path, generation, index];
}

/** Maps one superseded generation to the time at which it stopped being visible. */
function retiredKey(prefix: string, path: string, generation: string): Deno.KvKey {
  return [prefix, "retired", path, generation];
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
  return typeof value === "object" && value !== null && (value as { storage?: unknown }).storage === "deno-kv-parts-v2";
}

/** Projects a manifest to listing metadata without reading any body part. */
function manifestList(manifest: DenoKvManifestType): RecordListType {
  return manifest.file;
}

/** Creates one new generation identifier without depending on Deno globals. */
function generation(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

/** Reads the timestamp prefix embedded in a project-generated physical generation ID. */
function generationTime(value: string): number | undefined {
  const [encoded] = value.split("-", 1);
  if (encoded === undefined || encoded.length === 0) return undefined;
  const time = Number.parseInt(encoded, 36);
  return Number.isSafeInteger(time) && time >= 0 ? time : undefined;
}

/** Splits bytes into independent copies so each stored value owns a stable ArrayBuffer. */
function parts(bytes: Uint8Array, partBytes: number): Uint8Array[] {
  if (bytes.byteLength === 0) return [new Uint8Array()];
  const output: Uint8Array[] = [];
  for (let at = 0; at < bytes.byteLength; at += partBytes) output.push(bytes.slice(at, at + partBytes));
  return output;
}

/** UTF-8 encoder used for conservative Deno KV tuple-size planning. */
const keyEncoder = new TextEncoder();

/** Conservatively estimates serialized tuple bytes for the key component types used here. */
function estimateKeyBytes(value: Deno.KvKey): number {
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
  const prefix = options.prefix ?? "okikio-opfs";
  const partBytes = positive(options.partBytes, DENO_KV_DEFAULT_PART_BYTES, "partBytes");
  const inlineBytes = positive(options.inlineBytes, DENO_KV_DEFAULT_INLINE_BYTES, "inlineBytes");
  const maxParts = positive(options.maxParts, DENO_KV_DEFAULT_MAX_PARTS, "maxParts");
  validateSizePolicy(partBytes, inlineBytes, maxParts);
  const problems: ProblemType[] = [];
  const actions: ActionType[] = [];
  if (request.path !== undefined) {
    const entryBytes = estimateKeyBytes(key(prefix, request.path));
    const partBytesEstimate = estimateKeyBytes(
      partKey(prefix, request.path, "00000000-0000-4000-8000-000000000000", maxParts - 1),
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
 * atomic retirement marker + manifest commit
 *                  <- visibility point
 *         |
 *         v
 * explicit collect() after retirement grace
 * ```
 *
 * Readers that already resolved the previous manifest can continue reading its
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
  /** Whether store disposal also closes the injected database. */
  readonly #disposeDatabase: boolean;
  /** Prevents all physical mutation, including maintenance collection. */
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
    this.#prefix = options.prefix ?? "okikio-opfs";
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

  /** Reads one exact logical entry and retains its provider version for a later optimistic commit. */
  async #entry(path: string): Promise<DenoKvStoredEntryType> {
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
    const chunks = new Array<Uint8Array>(manifest.parts);
    const indexes = Array.from({ length: manifest.parts }, (_, index) => index);
    for await (
      const result of pooledMap(this.#concurrency, indexes, async (index) => {
        const part = await this.#database.get<Uint8Array>(partKey(this.#prefix, path, manifest.generation, index));
        if (!(part.value instanceof Uint8Array)) {
          throw new FileSystemError(
            "unknown",
            "read",
            path,
            `Deno KV file '${path}' is missing physical part ${index} of ${manifest.parts}.`,
          );
        }
        return { index, bytes: part.value };
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
        const part = await this.#database.get<Uint8Array>(partKey(this.#prefix, path, manifest.generation, index));
        if (!(part.value instanceof Uint8Array)) {
          throw new FileSystemError(
            "unknown",
            "read",
            path,
            `Deno KV file '${path}' is missing physical part ${index} of ${manifest.parts}.`,
          );
        }
        return { index, bytes: part.value };
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
    const database = this.#database;
    const prefix = this.#prefix;
    const signal = options.signal;

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        throwIfAborted(signal, "read", path);
        if (start === end || index >= last) {
          controller.close();
          return;
        }
        const entry = await database.get<Uint8Array>(partKey(prefix, path, manifest.generation, index));
        throwIfAborted(signal, "read", path);
        if (!(entry.value instanceof Uint8Array)) {
          controller.error(
            new FileSystemError(
              "unknown",
              "read",
              path,
              `Deno KV file '${path}' is missing physical part ${index} of ${manifest.parts}.`,
            ),
          );
          return;
        }
        const physicalStart = index * manifest.partBytes;
        const from = index === first ? start - physicalStart : 0;
        const to = index === last - 1 ? Math.min(entry.value.byteLength, end - physicalStart) : entry.value.byteLength;
        index += 1;
        if (to > from) controller.enqueue(entry.value.slice(from, to));
        if (index >= last) controller.close();
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

    const start = Math.min(at, stored.file.size);
    const end = Math.min(stored.file.size, start + length);
    if (start === end) return new Uint8Array();
    const first = Math.floor(start / stored.partBytes);
    const last = Math.ceil(end / stored.partBytes);
    const chunks: Uint8Array[] = [];
    for (let index = first; index < last; index += 1) {
      throwIfAborted(signal, "read", path);
      const part = await this.#database.get<Uint8Array>(partKey(this.#prefix, path, stored.generation, index));
      if (!(part.value instanceof Uint8Array)) {
        throw new FileSystemError(
          "unknown",
          "read",
          path,
          `Deno KV file '${path}' is missing physical part ${index} of ${stored.parts}.`,
        );
      }
      chunks.push(part.value);
    }

    const joined = concat(chunks);
    const localStart = start - first * stored.partBytes;
    return joined.slice(localStart, localStart + (end - start));
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
  ): Promise<void> {
    const transaction = this.#database.atomic().check({
      key: previous.key,
      versionstamp: previous.versionstamp,
    });
    if (previous.value !== null && isManifest(previous.value)) {
      transaction.set(
        retiredKey(this.#prefix, path, previous.value.generation),
        DenoKvRetiredSchema.parse({ storage: "deno-kv-retired-v1", retiredAt: Date.now() }),
      );
    }
    if (next === undefined) transaction.delete(previous.key);
    else transaction.set(previous.key, next);

    const result = await transaction.commit();
    if (!result.ok) {
      throw new FileSystemError(
        "locked",
        operation,
        path,
        `Deno KV entry '${path}' changed while this operation prepared its commit. Retry the operation.`,
      );
    }
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
      await this.#saveFile(file, data, previousEntry);
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
      await this.#saveFile(file, output, previousEntry);
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
          await this.#database.set(partKey(this.#prefix, path, nextGeneration, index), chunk);
        })
      ) {
        // The iterator is consumed so all bounded reads/writes settle before the manifest becomes visible.
      }

      throwIfAborted(options.signal, "write", path);
      const manifest = DenoKvManifestSchema.parse({
        storage: "deno-kv-parts-v2",
        generation: nextGeneration,
        parts: partCount,
        partBytes: this.#partBytes,
        file,
      });
      await this.#commit(path, previousEntry, manifest, "write");
    } catch (error) {
      await this.#deleteGeneration(path, nextGeneration, partCount).catch(() => undefined);
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
    if (options.mode !== "replace" || this.#partition === "never") {
      await source.cancel().catch(() => undefined);
      throw new FileSystemError("not-supported", "write", path, `Deno KV streaming requires partitioned replace mode.`);
    }
    throwIfAborted(options.signal, "write", path);
    const previousEntry = await this.#entry(path);
    const previousStored = previousEntry.value;
    if (previousStored !== null && !isManifest(previousStored) && previousStored.kind === "directory") {
      await source.cancel().catch(() => undefined);
      throw new FileSystemError("type-mismatch", "write", path, `'${path}' is a directory.`);
    }
    const previousMediaType = previousStored === null
      ? ""
      : isManifest(previousStored)
      ? previousStored.file.mediaType
      : previousStored.kind === "file"
      ? previousStored.mediaType
      : "";
    const nextGeneration = generation();
    let scheduled = 0;
    let size = 0;

    try {
      for await (
        const written of pooledMap(this.#concurrency, split(source, this.#partBytes), async (chunk) => {
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
          await this.#database.set(partKey(this.#prefix, path, nextGeneration, index), chunk);
          return { bytes: chunk.byteLength };
        })
      ) size += written.bytes;

      if (scheduled === 0) {
        scheduled = 1;
        await this.#database.set(partKey(this.#prefix, path, nextGeneration, 0), new Uint8Array());
      }
      throwIfAborted(options.signal, "write", path);
      const manifest = DenoKvManifestSchema.parse({
        storage: "deno-kv-parts-v2",
        generation: nextGeneration,
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
      await this.#commit(path, previousEntry, manifest, "write");
    } catch (error) {
      await this.#deleteGeneration(path, nextGeneration, scheduled).catch(() => undefined);
      throw error;
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

    const chunks = parts(bytes, this.#partBytes);
    if (chunks.length > this.#maxParts) {
      throw new FileSystemError(
        "too-large",
        "write",
        record.path,
        `Deno KV file requires ${chunks.length} parts, above configured maxParts ${this.#maxParts}.`,
      );
    }

    const nextGeneration = generation();
    const indexes = chunks.map((_, index) => index);
    try {
      for await (
        const _ of pooledMap(
          this.#concurrency,
          indexes,
          (index) => this.#database.set(partKey(this.#prefix, record.path, nextGeneration, index), chunks[index]!),
        )
      ) {
        // pooledMap owns bounded concurrency; values are intentionally ignored.
      }
      const { data: _data, ...file } = record;
      const manifest = DenoKvManifestSchema.parse({
        storage: "deno-kv-parts-v2",
        generation: nextGeneration,
        parts: chunks.length,
        partBytes: this.#partBytes,
        file,
      });
      await this.#commit(record.path, previousEntry, manifest, "write");
    } catch (error) {
      await this.#deleteGeneration(record.path, nextGeneration, chunks.length).catch(() => undefined);
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
      await this.#commit(file.path, previousEntry, record, "write");
      return;
    }

    const chunks = parts(bytes, this.#partBytes);
    if (chunks.length > this.#maxParts) {
      throw new FileSystemError(
        "too-large",
        "write",
        file.path,
        `Deno KV file requires ${chunks.length} parts, above configured maxParts ${this.#maxParts}.`,
      );
    }
    const nextGeneration = generation();
    const indexes = chunks.map((_, index) => index);
    try {
      for await (
        const _ of pooledMap(
          this.#concurrency,
          indexes,
          (index) => this.#database.set(partKey(this.#prefix, file.path, nextGeneration, index), chunks[index]!),
        )
      ) {
        // pooledMap owns bounded concurrency; values are intentionally ignored.
      }
      const manifest = DenoKvManifestSchema.parse({
        storage: "deno-kv-parts-v2",
        generation: nextGeneration,
        parts: chunks.length,
        partBytes: this.#partBytes,
        file,
      });
      await this.#commit(file.path, previousEntry, manifest, "write");
    } catch (error) {
      await this.#deleteGeneration(file.path, nextGeneration, chunks.length).catch(() => undefined);
      throw error;
    }
  }

  /** Reclaims an unpublished generation after a failed manifest commit. */
  async #deleteGeneration(path: string, value: string, count: number): Promise<void> {
    const indexes = Array.from({ length: count }, (_, index) => index);
    for await (
      const _ of pooledMap(
        this.#concurrency,
        indexes,
        (index) => this.#database.delete(partKey(this.#prefix, path, value, index)),
      )
    ) {
      // Deletions are intentionally consumed so all already-started work settles.
    }
  }

  /** Removes a consumed retirement marker after every remaining part in its generation was reclaimed. */
  async #clearRetired(
    path: string | undefined,
    generation: string | undefined,
    retired: DenoKvRetiredType | undefined,
    reclaim: boolean,
    scanned: number,
    deleted: number,
  ): Promise<void> {
    if (
      path !== undefined &&
      generation !== undefined &&
      retired !== undefined &&
      reclaim &&
      scanned > 0 &&
      scanned === deleted
    ) {
      await this.#database.delete(retiredKey(this.#prefix, path, generation));
    }
  }

  /**
   * Reclaims old physical part generations that are no longer visible.
   *
   * Collection is explicit because a background scan would add hidden provider
   * I/O and could race independent writers. A published generation uses its
   * retirement timestamp, which is written before the visibility change. An
   * unpublished crash leftover has no retirement marker and uses generation
   * creation time instead. Set a shorter grace period only when the application
   * can account for every in-flight reader that may still hold an old manifest.
   */
  async collect(options: DenoKvCollectOptionsType = {}): Promise<DenoKvCollectResultType> {
    if (this.#readOnly) {
      throw new Error("Deno KV driver is read-only; physical collection would mutate storage.");
    }
    const minAgeMs = options.minAgeMs ?? DENO_KV_DEFAULT_COLLECT_AGE_MS;
    const maxDeletes = options.maxDeletes ?? DENO_KV_DEFAULT_COLLECT_DELETES;
    if (!Number.isSafeInteger(minAgeMs) || minAgeMs < 0) {
      throw new RangeError("minAgeMs must be a non-negative safe integer.");
    }
    if (!Number.isSafeInteger(maxDeletes) || maxDeletes < 1) {
      throw new RangeError("maxDeletes must be a positive safe integer.");
    }

    const cutoff = Date.now() - minAgeMs;
    let generations = 0;
    let scannedParts = 0;
    let deleted = 0;
    let retained = 0;
    let truncated = false;
    let currentPath: string | undefined;
    let currentGeneration: string | undefined;
    let currentReclaim = false;
    let currentRetired: DenoKvRetiredType | undefined;
    let currentGroupParts = 0;
    let currentGroupDeleted = 0;

    for await (const entry of this.#database.list<Uint8Array>({ prefix: [this.#prefix, "part"] })) {
      throwIfAborted(options.signal, "remove");
      const [, kind, path, value] = entry.key;
      if (kind !== "part" || typeof path !== "string" || typeof value !== "string") continue;
      scannedParts += 1;

      if (path !== currentPath || value !== currentGeneration) {
        await this.#clearRetired(
          currentPath,
          currentGeneration,
          currentRetired,
          currentReclaim,
          currentGroupParts,
          currentGroupDeleted,
        );
        currentPath = path;
        currentGeneration = value;
        currentGroupParts = 0;
        currentGroupDeleted = 0;
        currentRetired = undefined;
        generations += 1;

        const visible = await this.#database.get<unknown>(key(this.#prefix, path));
        if (visible.value !== null && isManifest(visible.value) && visible.value.generation === value) {
          currentReclaim = false;
        } else {
          const retired = await this.#database.get<unknown>(retiredKey(this.#prefix, path, value));
          if (retired.value !== null) {
            currentRetired = DenoKvRetiredSchema.parse(retired.value);
            currentReclaim = currentRetired.retiredAt <= cutoff;
          } else {
            const created = generationTime(value);
            currentReclaim = created !== undefined && created <= cutoff;
          }
        }
      }

      currentGroupParts += 1;
      if (!currentReclaim) {
        retained += 1;
        continue;
      }
      if (deleted >= maxDeletes) {
        truncated = true;
        break;
      }
      await this.#database.delete(entry.key);
      currentGroupDeleted += 1;
      deleted += 1;
    }

    await this.#clearRetired(
      currentPath,
      currentGeneration,
      currentRetired,
      currentReclaim,
      currentGroupParts,
      currentGroupDeleted,
    );
    return { generations, parts: scannedParts, deleted, retained, truncated };
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
  });
}
