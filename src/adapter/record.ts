import { decodeBase64, encodeBase64 } from "@std/encoding/base64";

import type {
  AdapterDirectoryEntryType,
  AdapterReadOptionsType,
  AdapterSignalOptionsType,
  AdapterStatType,
  AdapterType,
  AdapterWriteOptionsType,
} from "./definition.ts";
import { defineAdapter } from "./definition.ts";
import { FileSystemError, throwIfAborted } from "../error.ts";
import { basename, dirname, ROOT_PATH, type PathType } from "../path.ts";
import {
  RecordSchema,
  type AdapterLimitsType,
  type AdapterPartitionType,
  type DirectoryRecordType,
  type FileRecordType,
  type RecordType,
  type WriteModeType,
} from "../schema.ts";

/** Metadata returned during direct-child listing without requiring file-body materialization. */
export type RecordListType = DirectoryRecordType | Omit<FileRecordType, "data">;

/** Optional byte lanes a value store can expose without abandoning the record contract. */
export interface RecordStoreCapabilitiesType {
  /** `readFile()` can fetch only the requested range instead of loading the complete logical value. */
  readonly rangeRead?: boolean;
  /** `openReadStream()` can preserve producer backpressure without materializing the complete logical value. */
  readonly streamRead?: boolean;
  /** Write modes that `writeFile()` handles directly instead of rebuilding a base64 record in the generic adapter. */
  readonly writeModes?: readonly WriteModeType[];
  /** Write modes that `writeStream()` can commit without facade materialization. */
  readonly streamWriteModes?: readonly WriteModeType[];
}

/**
 * Persistence contract used by value/document/SQL ecosystem bridges.
 *
 * The required methods describe one complete logical record. That keeps simple
 * document and SQL integrations small. Stores with a more capable physical
 * layout can additionally expose metadata-only stat, byte ranges, streams, and
 * selected direct write modes. The record adapter advertises those lanes through
 * normal `AdapterType` capabilities, so a third-party store can become faster
 * without reimplementing recursive filesystem behavior.
 *
 * `list(parent)` returns direct children only. Stores own indexing choices.
 * The filesystem adapter borrows the store unless a store implementation says
 * otherwise through its own creation options.
 */
export interface RecordStoreType {
  /** Optional native byte-lane declarations. Missing fields mean the generic complete-record path is used. */
  readonly capabilities?: RecordStoreCapabilitiesType;
  /** Returns one complete record by canonical path, or null when absent. */
  get(path: PathType): Promise<RecordType | null>;
  /** Returns metadata without requiring a file body when the store can do so. */
  stat?(path: PathType): Promise<RecordListType | null>;
  /** Reads bytes directly when the physical layout can avoid complete-record decode/materialization. */
  readFile?(path: PathType, options?: AdapterReadOptionsType): Promise<Uint8Array>;
  /** Opens a native logical-byte stream when `capabilities.streamRead` is true. */
  openReadStream?(path: PathType, options?: AdapterReadOptionsType): Promise<ReadableStream<Uint8Array>>;
  /** Commits materialized bytes directly for modes listed in `capabilities.writeModes`. */
  writeFile?(path: PathType, data: Uint8Array, options: AdapterWriteOptionsType): Promise<void>;
  /** Commits a byte stream directly for modes listed in `capabilities.streamWriteModes`. */
  writeStream?(path: PathType, source: ReadableStream<Uint8Array>, options: AdapterWriteOptionsType): Promise<void>;
  /** Atomically replaces one logical record as far as the backend permits. */
  set(record: RecordType): Promise<void>;
  /** Deletes one record. The record adapter removes descendants separately. */
  delete(path: PathType): Promise<void>;
  /** Lazily returns direct child metadata without requiring a file body. */
  list(parent: PathType): AsyncIterableIterator<RecordListType>;
  /** Releases resources explicitly owned by this store. */
  dispose?(): void | Promise<void>;
}

/** Options for a filesystem adapter created from a record store. */
export interface RecordAdapterOptionsType {
  /** Diagnostic adapter name. Defaults to `record`. */
  readonly name?: string;
  /** Disposes the record store when the adapter is disposed. */
  readonly disposeStore?: boolean;
  /** Rejects every mutating operation. Useful for read-only unstorage drivers. */
  readonly readOnly?: boolean;
  /** Portable hard limits known by the underlying value store. */
  readonly limits?: AdapterLimitsType;
  /** Physical partition layout implemented below the logical record contract. */
  readonly partition?: AdapterPartitionType;
}

/**
 * Applies filesystem write semantics to one materialized record image.
 *
 * Record stores cannot update an arbitrary byte range natively, so append and
 * update build the next complete byte image before the record is replaced.
 */
function applyWrite(
  existing: Uint8Array,
  data: Uint8Array,
  mode: "replace" | "append" | "update",
  at: number | undefined,
  truncate: boolean,
): Uint8Array {
  if (mode === "replace") return data.slice();
  const position = mode === "append" ? existing.byteLength : at ?? 0;
  const size = Math.max(existing.byteLength, position + data.byteLength);
  let output = new Uint8Array(size);
  output.set(existing);
  output.set(data, position);
  if (truncate) output = output.slice(0, position + data.byteLength);
  return output;
}

/** Narrows a mixed record-store result to a file record that still carries bytes. */
function isFileRecord(record: RecordListType | RecordType | null): record is FileRecordType {
	return record?.kind === "file" && "data" in record;
}

/** Fails before touching a record store when the adapter was intentionally opened read-only. */
function assertWritable(readOnly: boolean, operation: string, path: string): void {
  if (readOnly) {
    throw new FileSystemError(
      "permission-denied",
      operation,
      path,
      `Adapter is configured read-only; '${path}' cannot be changed.`,
    );
  }
}

/**
 * Filesystem primitive adapter over one value-oriented record store.
 *
 * The class deliberately owns no recursive filesystem behavior. It translates
 * the primitive adapter operations to complete record reads and replacements,
 * while {@link FileSystemType} above it owns parent creation, recursive copy,
 * recursive remove, handles, locks, and stream fallback.
 *
 * The complete-record path remains the portable fallback. A store can expose
 * metadata-only stat, ranges, streams, or selected direct write modes when its
 * physical layout supports them. Copy, move, positional-write, and synchronous
 * access remain facade-owned or unsupported because they are not record-store
 * primitives.
 */
class RecordAdapter implements AdapterType {
  /** Diagnostic adapter identity exposed through the public facade. */
  readonly name: string;
  /** Native capabilities of a value-oriented record store. */
  readonly capabilities;
  /** Portable hard limits inherited from the underlying value store. */
  readonly limits?: AdapterLimitsType;
  /** Physical partition layout inherited from the underlying value store. */
  readonly partition?: AdapterPartitionType;
  /** Store that owns durable record persistence. */
  readonly #store: RecordStoreType;
  /** Prevents all mutation when the upstream storage is read-only. */
  readonly #readOnly: boolean;
  /** Whether adapter disposal also disposes the injected store. */
  readonly #disposeStore: boolean;

  /** Resolves immutable adapter policy once instead of closing over factory locals. */
  constructor(store: RecordStoreType, options: RecordAdapterOptionsType) {
    this.#store = store;
    this.#readOnly = options.readOnly ?? false;
    this.#disposeStore = options.disposeStore ?? false;
    this.name = options.name ?? "record";
    if (options.limits !== undefined) this.limits = options.limits;
    if (options.partition !== undefined) this.partition = options.partition;
    const streamWriteModes = this.#readOnly || store.writeStream === undefined
      ? []
      : [...(store.capabilities?.streamWriteModes ?? [])];
    this.capabilities = {
      read: true,
      write: !this.#readOnly,
      streamRead: store.capabilities?.streamRead === true && store.openReadStream !== undefined,
      streamWriteModes,
      rangeRead: store.capabilities?.rangeRead === true && store.readFile !== undefined,
      nativeCopy: false,
      nativeMove: false,
      positionalWrite: false,
      syncAccess: false,
    } as const;
  }

  /** Returns portable metadata without materializing file bytes. */
  async stat(path: PathType, options: AdapterSignalOptionsType = {}): Promise<AdapterStatType | null> {
    throwIfAborted(options.signal, "stat", path);
    if (path === ROOT_PATH) return { kind: "directory" };

    const record = this.#store.stat === undefined ? await this.#store.get(path) : await this.#store.stat(path);
    if (record === null) return null;
    if (record.kind === "directory") return { kind: "directory", lastModified: record.lastModified };
    return { kind: "file", size: record.size, lastModified: record.lastModified, mediaType: record.mediaType };
  }

  /** Decodes one file record and slices the requested byte range in memory. */
  async readFile(path: PathType, options: AdapterReadOptionsType = {}): Promise<Uint8Array> {
    throwIfAborted(options.signal, "read", path);
    if (this.#store.readFile !== undefined) return await this.#store.readFile(path, options);
    const record = await this.#store.get(path);
    if (record === null) throw new FileSystemError("not-found", "read", path, `File '${path}' does not exist.`);
    if (record.kind !== "file") throw new FileSystemError("type-mismatch", "read", path, `'${path}' is a directory.`);

    const bytes = decodeBase64(record.data);
    const start = options.at ?? 0;
    const end = options.length === undefined ? bytes.byteLength : Math.min(bytes.byteLength, start + options.length);
    return bytes.slice(start, end);
  }

  /**
   * Applies replace/append/update semantics to one complete record image.
   *
   * This method is intentionally materialized. The facade applies
   * `maxBufferedWriteBytes` before it calls this adapter with a streamed source.
   */
  async writeFile(path: PathType, data: Uint8Array, options: AdapterWriteOptionsType): Promise<void> {
    assertWritable(this.#readOnly, "write", path);
    throwIfAborted(options.signal, "write", path);

    if (this.#store.writeFile !== undefined && this.#store.capabilities?.writeModes?.includes(options.mode)) {
      await this.#store.writeFile(path, data, options);
      return;
    }

    // Replace needs only previous metadata for directory/type and media-type
    // preservation. Append/update need the complete prior file image. Keeping
    // those paths separate prevents metadata-only stores from reassembling a
    // partitioned body solely to replace it.
    const previous = options.mode === "replace" && this.#store.stat !== undefined
      ? await this.#store.stat(path)
      : await this.#store.get(path);
    if (previous?.kind === "directory") {
      throw new FileSystemError("type-mismatch", "write", path, `'${path}' is a directory.`);
    }

    const existing = options.mode === "replace"
      ? new Uint8Array()
      : isFileRecord(previous)
      ? decodeBase64(previous.data)
      : new Uint8Array();
    const bytes = applyWrite(existing, data, options.mode, options.at, options.truncate ?? false);
    await this.#store.set(RecordSchema.parse({
      version: 1,
      path,
      parent: dirname(path),
      name: basename(path),
      kind: "file",
      data: encodeBase64(bytes),
      size: bytes.byteLength,
      lastModified: Date.now(),
      mediaType: options.mediaType ?? (previous?.kind === "file" ? previous.mediaType : ""),
    }));
  }

  /** Opens the store's byte stream only when its declared stream-read capability is active. */
  async openReadStream(path: PathType, options: AdapterReadOptionsType = {}): Promise<ReadableStream<Uint8Array>> {
    if (!this.capabilities.streamRead || this.#store.openReadStream === undefined) {
      throw new FileSystemError("not-supported", "read", path, `Record store '${this.name}' does not expose streaming reads.`);
    }
    return await this.#store.openReadStream(path, options);
  }

  /** Commits a native record-store stream for the write modes the store explicitly advertises. */
  async writeStream(path: PathType, source: ReadableStream<Uint8Array>, options: AdapterWriteOptionsType): Promise<void> {
    assertWritable(this.#readOnly, "write", path);
    if (!this.capabilities.streamWriteModes.includes(options.mode) || this.#store.writeStream === undefined) {
      await source.cancel().catch(() => undefined);
      throw new FileSystemError(
        "not-supported",
        "write",
        path,
        `Record store '${this.name}' does not expose streaming ${options.mode} writes.`,
      );
    }
    await this.#store.writeStream(path, source, options);
  }

  /** Lazily projects direct child records to adapter directory entries. */
  async *readDir(path: PathType, options: AdapterSignalOptionsType = {}): AsyncIterableIterator<AdapterDirectoryEntryType> {
    throwIfAborted(options.signal, "read-dir", path);
    for await (const record of this.#store.list(path)) {
      throwIfAborted(options.signal, "read-dir", path);
      yield { name: record.name, kind: record.kind };
    }
  }

  /** Creates one empty directory record when the path is not already present. */
  async createDir(path: PathType, options: AdapterSignalOptionsType = {}): Promise<void> {
    assertWritable(this.#readOnly, "mkdir", path);
    throwIfAborted(options.signal, "mkdir", path);

    const existing = this.#store.stat === undefined ? await this.#store.get(path) : await this.#store.stat(path);
    if (existing?.kind === "file") throw new FileSystemError("type-mismatch", "mkdir", path, `'${path}' is a file.`);
    if (existing !== null) return;

    await this.#store.set(RecordSchema.parse({
      version: 1,
      path,
      parent: dirname(path),
      name: basename(path),
      kind: "directory",
      lastModified: Date.now(),
    }));
  }

  /** Removes one exact record after preserving the configured read-only policy. */
  async remove(path: PathType, options: AdapterSignalOptionsType = {}): Promise<void> {
    assertWritable(this.#readOnly, "remove", path);
    throwIfAborted(options.signal, "remove", path);
    await this.#store.delete(path);
  }

  /** Disposes the injected store only when ownership was explicitly transferred. */
  async dispose(): Promise<void> {
    if (this.#disposeStore) await this.#store.dispose?.();
  }
}

/**
 * Creates a filesystem adapter over a generic record store.
 *
 * This is the common implementation used by RxDB, unstorage, db0, Drizzle,
 * Deno KV, browser storage, and other value-oriented backends. The factory
 * validates the resulting adapter contract without registering global state.
 *
 * @example Build a filesystem over a custom document store.
 * ```ts
 * const adapter = createRecordAdapter(store, { name: "documents" });
 * const fs = createFileSystem(adapter);
 * await fs.writeFile("/state.json", "{}", { parents: true });
 * ```
 */
export function createRecordAdapter(store: RecordStoreType, options: RecordAdapterOptionsType = {}): AdapterType {
  return defineAdapter(new RecordAdapter(store, options));
}
