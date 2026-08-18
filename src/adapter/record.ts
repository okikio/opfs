import { decodeBase64, encodeBase64 } from "@std/encoding/base64";

import type { AdapterType } from "./definition.ts";
import { defineAdapter } from "./definition.ts";
import type {
  FileDriverDirectoryEntryType,
  FileDriverReadOptionsType,
  FileDriverSignalOptionsType,
  FileDriverStatType,
  FileDriverWriteOptionsType,
} from "../driver/file.ts";
import { FileSystemError, throwIfAborted } from "../error.ts";
import { basename, dirname, type PathType, ROOT_PATH } from "../path.ts";
import {
  type AdapterLimitsType,
  type AdapterPartitionType,
  RecordSchema,
} from "../schema.ts";

import type { RecordDriverType } from "../driver/record.ts";

/** Options for a filesystem adapter created from a record driver. */
export interface RecordAdapterOptionsType {
  /** Diagnostic adapter name. Defaults to `record`. */
  readonly name?: string;
  /** Disposes the record driver when the adapter is disposed. */
  readonly disposeDriver?: boolean;
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

/** Fails before touching a record driver when the adapter was intentionally opened read-only. */
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
 * Filesystem primitive adapter over one value-oriented record driver.
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
  /** Native capabilities of a value-oriented record driver. */
  readonly capabilities;
  /** Portable hard limits inherited from the underlying value store. */
  readonly limits?: AdapterLimitsType;
  /** Physical partition layout inherited from the underlying value store. */
  readonly partition?: AdapterPartitionType;
  /** Store that owns durable record persistence. */
  readonly driver: RecordDriverType;
  /** Prevents all mutation when the upstream storage is read-only. */
  readonly #readOnly: boolean;
  /** Whether adapter disposal also disposes the injected driver. */
  readonly #disposeDriver: boolean;

  /** Resolves immutable adapter policy once instead of closing over factory locals. */
  constructor(driver: RecordDriverType, options: RecordAdapterOptionsType) {
    this.driver = driver;
    this.#readOnly = options.readOnly ?? false;
    this.#disposeDriver = options.disposeDriver ?? false;
    this.name = options.name ?? "record";
    if (options.limits !== undefined) this.limits = options.limits;
    if (options.partition !== undefined) this.partition = options.partition;
    const streamWriteModes = this.#readOnly || !driver.capabilities.write || driver.writeStream === undefined
      ? []
      : [...(driver.capabilities?.streamWriteModes ?? [])];
    this.capabilities = {
      read: true,
      write: !this.#readOnly && driver.capabilities.write,
      streamRead: driver.capabilities?.streamRead === true && driver.openReadStream !== undefined,
      streamWriteModes,
      rangeRead: driver.capabilities?.rangeRead === true && driver.readFile !== undefined,
      nativeCopy: false,
      nativeMove: false,
      positionalWrite: false,
      syncAccess: false,
    } as const;
  }

  /** Returns portable metadata without materializing file bytes. */
  async stat(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<FileDriverStatType | null> {
    throwIfAborted(options.signal, "stat", path);
    if (path === ROOT_PATH) return { kind: "directory" };

    const record = this.driver.stat === undefined ? await this.driver.get(path) : await this.driver.stat(path);
    if (record === null) return null;
    if (record.kind === "directory") return { kind: "directory", lastModified: record.lastModified };
    return { kind: "file", size: record.size, lastModified: record.lastModified, mediaType: record.mediaType };
  }

  /** Decodes one file record and slices the requested byte range in memory. */
  async readFile(path: PathType, options: FileDriverReadOptionsType = {}): Promise<Uint8Array> {
    throwIfAborted(options.signal, "read", path);
    if (this.driver.readFile !== undefined) return await this.driver.readFile(path, options);
    const record = await this.driver.get(path);
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
  async writeFile(path: PathType, data: Uint8Array, options: FileDriverWriteOptionsType): Promise<void> {
    assertWritable(this.#readOnly, "write", path);
    throwIfAborted(options.signal, "write", path);

    if (this.driver.writeFile !== undefined && this.driver.capabilities?.writeModes?.includes(options.mode)) {
      await this.driver.writeFile(path, data, options);
      return;
    }

    // Replace needs only previous metadata for directory/type and media-type
    // preservation. Append/update need the complete prior file image. Keeping
    // those paths separate prevents metadata-only stores from reassembling a
    // partitioned body solely to replace it.
    const previous = options.mode === "replace" && this.driver.stat !== undefined
      ? await this.driver.stat(path)
      : await this.driver.get(path);
    if (previous?.kind === "directory") {
      throw new FileSystemError("type-mismatch", "write", path, `'${path}' is a directory.`);
    }

    const existing = options.mode === "replace"
      ? new Uint8Array()
      : previous?.kind === "file" && "data" in previous && typeof previous.data === "string"
      ? decodeBase64(previous.data)
      : new Uint8Array();
    const bytes = applyWrite(existing, data, options.mode, options.at, options.truncate ?? false);
    await this.driver.set(RecordSchema.parse({
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
  async openReadStream(path: PathType, options: FileDriverReadOptionsType = {}): Promise<ReadableStream<Uint8Array>> {
    if (!this.capabilities.streamRead || this.driver.openReadStream === undefined) {
      throw new FileSystemError(
        "not-supported",
        "read",
        path,
        `Record driver '${this.driver.name}' does not expose streaming reads.`,
      );
    }
    return await this.driver.openReadStream(path, options);
  }

  /** Commits a native record-driver stream for the write modes the store explicitly advertises. */
  async writeStream(
    path: PathType,
    source: ReadableStream<Uint8Array>,
    options: FileDriverWriteOptionsType,
  ): Promise<void> {
    assertWritable(this.#readOnly, "write", path);
    if (!this.capabilities.streamWriteModes.includes(options.mode) || this.driver.writeStream === undefined) {
      await source.cancel().catch(() => undefined);
      throw new FileSystemError(
        "not-supported",
        "write",
        path,
        `Record driver '${this.driver.name}' does not expose streaming ${options.mode} writes.`,
      );
    }
    await this.driver.writeStream(path, source, options);
  }

  /** Lazily projects direct child records to adapter directory entries. */
  async *readDir(
    path: PathType,
    options: FileDriverSignalOptionsType = {},
  ): AsyncIterableIterator<FileDriverDirectoryEntryType> {
    throwIfAborted(options.signal, "read-dir", path);
    for await (const record of this.driver.list(path)) {
      throwIfAborted(options.signal, "read-dir", path);
      yield { name: record.name, kind: record.kind };
    }
  }

  /** Creates one empty directory record when the path is not already present. */
  async createDir(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<void> {
    assertWritable(this.#readOnly, "mkdir", path);
    throwIfAborted(options.signal, "mkdir", path);

    const existing = this.driver.stat === undefined ? await this.driver.get(path) : await this.driver.stat(path);
    if (existing?.kind === "file") throw new FileSystemError("type-mismatch", "mkdir", path, `'${path}' is a file.`);
    if (existing !== null) return;

    await this.driver.set(RecordSchema.parse({
      version: 1,
      path,
      parent: dirname(path),
      name: basename(path),
      kind: "directory",
      lastModified: Date.now(),
    }));
  }

  /** Removes one exact record after preserving the configured read-only policy. */
  async remove(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<void> {
    assertWritable(this.#readOnly, "remove", path);
    throwIfAborted(options.signal, "remove", path);
    await this.driver.delete(path);
  }

  /** Disposes the injected driver only when ownership was explicitly transferred. */
  async dispose(): Promise<void> {
    if (this.#disposeDriver) await this.driver.dispose?.();
  }
}

/**
 * Creates a filesystem adapter over a generic record driver.
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
export function createRecordAdapter(driver: RecordDriverType, options: RecordAdapterOptionsType = {}): AdapterType {
  return defineAdapter(new RecordAdapter(driver, options));
}
