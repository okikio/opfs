import { pooledMap } from "@std/async/pool";
import { concat } from "@std/bytes";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { z } from "zod";

import type { AdapterReadOptionsType, AdapterType, AdapterWriteOptionsType } from "./definition.ts";
import { createRecordAdapter, type RecordListType, type RecordStoreType } from "./record.ts";
import { FileSystemError, throwIfAborted } from "../error.ts";
import { basename, dirname } from "../path.ts";
import { split } from "../chunk.ts";
import {
  PartitionModeSchema,
  PathSchema,
  RecordSchema,
  type PartitionModeType,
  type RecordType,
} from "../schema.ts";

/** Maximum serialized Deno KV key size documented by the runtime. */
export const DENO_KV_MAX_KEY_BYTES = 2 * 1024;
/** Maximum serialized Deno KV value size documented by the runtime. */
export const DENO_KV_MAX_VALUE_BYTES = 64 * 1024;
/** Maximum total serialized size of one Deno KV atomic mutation. */
export const DENO_KV_MAX_ATOMIC_BYTES = 800 * 1024;
/** Conservative decoded payload kept in one raw binary part. */
export const DENO_KV_DEFAULT_PART_BYTES = 48 * 1024;
/** Conservative decoded payload kept inline with filesystem metadata. */
export const DENO_KV_DEFAULT_INLINE_BYTES = 32 * 1024;
/** Explicit safety ceiling that prevents one logical file from creating unbounded keys. */
export const DENO_KV_DEFAULT_MAX_PARTS = 10_000;
/** Default concurrent exact reads/deletes for partitioned file bodies. */
export const DENO_KV_DEFAULT_CONCURRENCY = 8;

/** Structural Deno KV entry used by the adapter. */
export interface DenoKvEntryType<T> {
  /** Stored tuple when iteration exposes it. */
  readonly key?: readonly unknown[];
  /** Stored value, or null for a missing exact get. */
  readonly value: T | null;
}

/** Structural Deno KV subset required by this adapter. */
export interface DenoKvType {
  /** Reads one exact key. */
  get<T = unknown>(key: readonly unknown[]): Promise<DenoKvEntryType<T>>;
  /** Replaces one key. */
  set(key: readonly unknown[], value: unknown): Promise<unknown>;
  /** Removes one key. */
  delete(key: readonly unknown[]): Promise<void>;
  /** Streams keys with one prefix. */
  list<T = unknown>(selector: { prefix: readonly unknown[] }, options?: unknown): AsyncIterable<DenoKvEntryType<T>>;
  /** Closes the database when the caller transfers ownership. */
  close?(): void;
}

/** Options for Deno KV persistence. */
export interface DenoKvAdapterOptionsType {
  /** Key namespace. Defaults to `okikio-opfs`. */
  readonly prefix?: string;
  /** Closes the injected KV database with the adapter. */
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
/** Physical value stored at one logical entry key: inline record or partition manifest. */
type DenoKvStoredType = RecordType | DenoKvManifestType;

/** Maps one exact virtual path to a Deno KV entry key derived from its parent and name. */
function key(prefix: string, path: string): readonly unknown[] {
  return [prefix, "entry", dirname(path), basename(path)];
}

/** Prefix whose entries are exactly the direct children of one canonical parent path. */
function listKey(prefix: string, parent: string): readonly unknown[] {
  return [prefix, "entry", parent];
}

/** Maps one logical file generation and part number to a separate raw binary key. */
function partKey(prefix: string, path: string, generation: string, index: number): readonly unknown[] {
  return [prefix, "part", path, generation, index];
}

/** Validates a positive safe integer configuration value. */
function positive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new RangeError(`${name} must be a positive safe integer.`);
  return resolved;
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

/** Splits bytes into independent copies so each stored value owns a stable ArrayBuffer. */
function parts(bytes: Uint8Array, partBytes: number): Uint8Array[] {
  if (bytes.byteLength === 0) return [new Uint8Array()];
  const output: Uint8Array[] = [];
  for (let at = 0; at < bytes.byteLength; at += partBytes) output.push(bytes.slice(at, at + partBytes));
  return output;
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
 * commit new manifest     <- visibility point
 *         |
 *         v
 * remove old parts
 * ```
 *
 * Readers therefore observe the previous complete generation until the new
 * manifest commit succeeds. A process crash before the manifest commit can
 * leave unreachable part keys. That is storage leakage, not a partial logical
 * file; a later successful overwrite removes the previous reachable generation.
 */
class DenoKvRecordStore implements RecordStoreType {
  /** Optional byte lanes that keep large logical files out of generic base64 record materialization. */
  readonly capabilities: NonNullable<RecordStoreType["capabilities"]>;
  /** Deno KV-compatible database borrowed from the caller. */
  readonly #database: DenoKvType;
  /** First key tuple component reserved for this filesystem. */
  readonly #prefix: string;
  /** Whether store disposal also closes the injected database. */
  readonly #disposeDatabase: boolean;
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
  constructor(database: DenoKvType, options: DenoKvAdapterOptionsType) {
    this.#database = database;
    this.#prefix = options.prefix ?? "okikio-opfs";
    this.#disposeDatabase = options.disposeDatabase ?? false;
    this.#partition = PartitionModeSchema.parse(options.partition ?? "auto");
    this.#partBytes = positive(options.partBytes, DENO_KV_DEFAULT_PART_BYTES, "partBytes");
    this.#inlineBytes = positive(options.inlineBytes, DENO_KV_DEFAULT_INLINE_BYTES, "inlineBytes");
    this.#maxParts = positive(options.maxParts, DENO_KV_DEFAULT_MAX_PARTS, "maxParts");
    this.#concurrency = positive(options.concurrency, DENO_KV_DEFAULT_CONCURRENCY, "concurrency");
    if (this.#partBytes >= DENO_KV_MAX_VALUE_BYTES) {
      throw new RangeError(`partBytes must stay below the Deno KV ${DENO_KV_MAX_VALUE_BYTES}-byte value ceiling.`);
    }
    if (this.#inlineBytes >= DENO_KV_MAX_VALUE_BYTES) {
      throw new RangeError(`inlineBytes must stay below the Deno KV ${DENO_KV_MAX_VALUE_BYTES}-byte value ceiling.`);
    }
    this.capabilities = {
      rangeRead: true,
      streamRead: true,
      writeModes: ["replace", "append", "update"],
      streamWriteModes: this.#partition === "never" ? [] : ["replace"],
    } as const;
  }

  /** Reads one exact stored logical value without following a partition manifest. */
  async #stored(path: string): Promise<DenoKvStoredType | null> {
    const entry = await this.#database.get<unknown>(key(this.#prefix, path));
    if (entry.value === null) return null;
    if (isManifest(entry.value)) return DenoKvManifestSchema.parse(entry.value);
    return RecordSchema.parse(entry.value);
  }

  /** Returns logical metadata without joining any partition body. */
  async stat(path: Parameters<NonNullable<RecordStoreType["stat"]>>[0]): Promise<RecordListType | null> {
    const stored = await this.#stored(path);
    if (stored === null) return null;
    return isManifest(stored) ? manifestList(stored) : stored;
  }

  /** Reads and validates one exact logical record, joining parts only for an exact file read. */
  async get(path: Parameters<RecordStoreType["get"]>[0]): Promise<RecordType | null> {
    const stored = await this.#stored(path);
    if (stored === null) return null;
    if (!isManifest(stored)) return stored;

    const manifest = stored;
    const chunks = new Array<Uint8Array>(manifest.parts);
    const indexes = Array.from({ length: manifest.parts }, (_, index) => index);
    for await (const result of pooledMap(this.#concurrency, indexes, async (index) => {
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
    })) chunks[result.index] = result.bytes;

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
    path: Parameters<NonNullable<RecordStoreType["readFile"]>>[0],
    options: AdapterReadOptionsType = {},
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
    for await (const result of pooledMap(this.#concurrency, indexes, async (index) => {
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
    })) chunks[result.index - first] = result.bytes;

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
    path: Parameters<NonNullable<RecordStoreType["openReadStream"]>>[0],
    options: AdapterReadOptionsType = {},
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
          controller.error(new FileSystemError(
            "unknown",
            "read",
            path,
            `Deno KV file '${path}' is missing physical part ${index} of ${manifest.parts}.`,
          ));
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
   * Commits materialized replace, append, and update writes without rebuilding
   * a complete base64 record.
   *
   * Replace can write the supplied bytes directly. Append/update construct a
   * new immutable generation one provider part at a time. Existing bytes are
   * read only for the output part currently being built, so a small patch to a
   * large partitioned file does not allocate the old logical file in memory.
   */
  async writeFile(
    path: Parameters<NonNullable<RecordStoreType["writeFile"]>>[0],
    data: Uint8Array,
    options: AdapterWriteOptionsType,
  ): Promise<void> {
    throwIfAborted(options.signal, "write", path);
    const previousStored = await this.#stored(path);
    if (previousStored !== null && !isManifest(previousStored) && previousStored.kind === "directory") {
      throw new FileSystemError("type-mismatch", "write", path, `'${path}' is a directory.`);
    }
    const previous = previousStored === null
      ? null
      : isManifest(previousStored)
      ? previousStored.file
      : previousStored;
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
      await this.#saveFile(file, data);
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
      await this.#saveFile(file, output);
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

    const previousManifest = previousStored !== null && isManifest(previousStored) ? previousStored : undefined;
    const nextGeneration = generation();
    const indexes = Array.from({ length: partCount }, (_, index) => index);
    try {
      for await (const _ of pooledMap(this.#concurrency, indexes, async (index) => {
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
      })) {
        // The iterator is consumed so all bounded reads/writes settle before the manifest becomes visible.
      }

      throwIfAborted(options.signal, "write", path);
      await this.#database.set(key(this.#prefix, path), DenoKvManifestSchema.parse({
        storage: "deno-kv-parts-v2",
        generation: nextGeneration,
        parts: partCount,
        partBytes: this.#partBytes,
        file,
      }));
    } catch (error) {
      await this.#deleteGeneration(path, nextGeneration, partCount).catch(() => undefined);
      throw error;
    }

    if (previousManifest !== undefined) await this.#deleteParts(path, previousManifest);
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
    path: Parameters<NonNullable<RecordStoreType["writeStream"]>>[0],
    source: ReadableStream<Uint8Array>,
    options: AdapterWriteOptionsType,
  ): Promise<void> {
    if (options.mode !== "replace" || this.#partition === "never") {
      await source.cancel().catch(() => undefined);
      throw new FileSystemError("not-supported", "write", path, `Deno KV streaming requires partitioned replace mode.`);
    }
    throwIfAborted(options.signal, "write", path);
    const previousStored = await this.#stored(path);
    if (previousStored !== null && !isManifest(previousStored) && previousStored.kind === "directory") {
      await source.cancel().catch(() => undefined);
      throw new FileSystemError("type-mismatch", "write", path, `'${path}' is a directory.`);
    }
    const previousManifest = isManifest(previousStored) ? previousStored : undefined;
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
      for await (const written of pooledMap(this.#concurrency, split(source, this.#partBytes), async (chunk) => {
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
      })) size += written.bytes;

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
      await this.#database.set(key(this.#prefix, path), manifest);
    } catch (error) {
      await this.#deleteGeneration(path, nextGeneration, scheduled).catch(() => undefined);
      throw error;
    }

    if (previousManifest !== undefined) await this.#deleteParts(path, previousManifest);
  }

  /** Replaces one exact logical record and commits partition manifests only after every new part exists. */
  async set(record: RecordType): Promise<void> {
    const previous = await this.#database.get<unknown>(key(this.#prefix, record.path));
    const previousManifest = previous.value !== null && isManifest(previous.value)
      ? DenoKvManifestSchema.parse(previous.value)
      : undefined;

    if (record.kind === "directory") {
      await this.#database.set(key(this.#prefix, record.path), record);
      if (previousManifest !== undefined) await this.#deleteParts(record.path, previousManifest);
      return;
    }

    const bytes = decodeBase64(record.data);
    const partition = this.#partition === "always" || (this.#partition === "auto" && bytes.byteLength > this.#inlineBytes);
    if (!partition) {
      if (bytes.byteLength > this.#inlineBytes && this.#partition === "never") {
        throw new FileSystemError(
          "too-large",
          "write",
          record.path,
          `Deno KV inline file is ${bytes.byteLength} bytes; configured inlineBytes is ${this.#inlineBytes}. Enable partitioning or lower the logical write size.`,
        );
      }
      await this.#database.set(key(this.#prefix, record.path), record);
      if (previousManifest !== undefined) await this.#deleteParts(record.path, previousManifest);
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
      for await (const _ of pooledMap(this.#concurrency, indexes, (index) =>
        this.#database.set(partKey(this.#prefix, record.path, nextGeneration, index), chunks[index]!))) {
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
      await this.#database.set(key(this.#prefix, record.path), manifest);
    } catch (error) {
      await this.#deleteGeneration(record.path, nextGeneration, chunks.length).catch(() => undefined);
      throw error;
    }

    if (previousManifest !== undefined) await this.#deleteParts(record.path, previousManifest);
  }

  /** Removes the logical visibility key first, then reclaims reachable body parts. */
  async delete(path: Parameters<RecordStoreType["delete"]>[0]): Promise<void> {
    const previous = await this.#database.get<unknown>(key(this.#prefix, path));
    const manifest = previous.value !== null && isManifest(previous.value)
      ? DenoKvManifestSchema.parse(previous.value)
      : undefined;
    await this.#database.delete(key(this.#prefix, path));
    if (manifest !== undefined) await this.#deleteParts(path, manifest);
  }

  /** Lists direct children from the parent-indexed entry key and never scans descendant subtrees or partition bodies. */
  async *list(parent: Parameters<RecordStoreType["list"]>[0]): AsyncIterableIterator<RecordListType> {
    for await (const entry of this.#database.list<unknown>({ prefix: listKey(this.#prefix, parent) })) {
      if (entry.value === null) continue;
      const record = isManifest(entry.value)
        ? manifestList(DenoKvManifestSchema.parse(entry.value))
        : RecordSchema.parse(entry.value);
      if (record.parent === parent) yield record;
    }
  }

  /** Stores one complete file from bytes while preserving the manifest-last visibility rule. */
  async #saveFile(file: z.output<typeof DenoKvFileSchema>, bytes: Uint8Array): Promise<void> {
    const previousStored = await this.#stored(file.path);
    const previousManifest = isManifest(previousStored) ? previousStored : undefined;
    const useParts = this.#partition === "always" || (this.#partition === "auto" && bytes.byteLength > this.#inlineBytes);
    if (!useParts) {
      if (bytes.byteLength > this.#inlineBytes && this.#partition === "never") {
        throw new FileSystemError(
          "too-large",
          "write",
          file.path,
          `Deno KV inline file is ${bytes.byteLength} bytes; configured inlineBytes is ${this.#inlineBytes}. Enable partitioning or lower the logical write size.`,
        );
      }
      await this.#database.set(key(this.#prefix, file.path), RecordSchema.parse({ ...file, data: encodeBase64(bytes) }));
      if (previousManifest !== undefined) await this.#deleteParts(file.path, previousManifest);
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
      for await (const _ of pooledMap(this.#concurrency, indexes, (index) =>
        this.#database.set(partKey(this.#prefix, file.path, nextGeneration, index), chunks[index]!))) {
        // pooledMap owns bounded concurrency; values are intentionally ignored.
      }
      await this.#database.set(key(this.#prefix, file.path), DenoKvManifestSchema.parse({
        storage: "deno-kv-parts-v2",
        generation: nextGeneration,
        parts: chunks.length,
        partBytes: this.#partBytes,
        file,
      }));
    } catch (error) {
      await this.#deleteGeneration(file.path, nextGeneration, chunks.length).catch(() => undefined);
      throw error;
    }
    if (previousManifest !== undefined) await this.#deleteParts(file.path, previousManifest);
  }

  /** Removes every expected part in one committed manifest with bounded provider concurrency. */
  async #deleteParts(path: string, manifest: DenoKvManifestType): Promise<void> {
    await this.#deleteGeneration(path, manifest.generation, manifest.parts);
  }

  /** Reclaims a known generation after a failed or superseded manifest commit. */
  async #deleteGeneration(path: string, value: string, count: number): Promise<void> {
    const indexes = Array.from({ length: count }, (_, index) => index);
    for await (const _ of pooledMap(this.#concurrency, indexes, (index) =>
      this.#database.delete(partKey(this.#prefix, path, value, index)))) {
      // Deletions are intentionally consumed so all already-started work settles.
    }
  }

  /** Closes the database only when the adapter was given ownership. */
  dispose(): void {
    if (this.#disposeDatabase) this.#database.close?.();
  }
}

/**
 * Creates the record-store layer over an injected Deno KV database.
 *
 * The caller still decides whether the database is local, remote, persistent,
 * or ephemeral. Deno KV is runtime-specific but the structural adapter module
 * does not touch the ambient `Deno` global at import time.
 */
export function createDenoKvRecordStore(database: DenoKvType, options: DenoKvAdapterOptionsType = {}): RecordStoreType {
  return new DenoKvRecordStore(database, options);
}

/** Creates an OPFS-shaped adapter over an injected Deno KV database with inspectable provider limits. */
export function createDenoKvAdapter(database: DenoKvType, options: DenoKvAdapterOptionsType = {}): AdapterType {
  const partition = PartitionModeSchema.parse(options.partition ?? "auto");
  const partBytes = positive(options.partBytes, DENO_KV_DEFAULT_PART_BYTES, "partBytes");
  const maxParts = positive(options.maxParts, DENO_KV_DEFAULT_MAX_PARTS, "maxParts");
  return createRecordAdapter(createDenoKvRecordStore(database, options), {
    name: "deno-kv",
    readOnly: options.readOnly ?? false,
    disposeStore: true,
    limits: {
      maxFileBytes: partBytes * maxParts,
      maxValueBytes: DENO_KV_MAX_VALUE_BYTES,
      maxKeyBytes: DENO_KV_MAX_KEY_BYTES,
      maxParts,
      maxBatchBytes: DENO_KV_MAX_ATOMIC_BYTES,
      maxConcurrency: positive(options.concurrency, DENO_KV_DEFAULT_CONCURRENCY, "concurrency"),
    },
    partition: {
      mode: partition,
      partBytes,
      thresholdBytes: positive(options.inlineBytes, DENO_KV_DEFAULT_INLINE_BYTES, "inlineBytes"),
      stream: partition !== "never",
      maxParts,
      layout: "deno-kv-parts-v2",
    },
  });
}
