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
import { FileSystemError, throwIfAborted, toFileSystemError } from "../error.ts";
import { close } from "../close.ts";
import { project } from "../iteration.ts";
import { retire } from "../stream.ts";
import { basename, dirname, type PathType, ROOT_PATH } from "../path.ts";
import { type AdapterLimitsType, type AdapterPartitionType, RecordMetadataSchema, RecordSchema } from "../schema.ts";

import { mutates, readOnlyPlan, type RecordDriverType } from "../driver/record.ts";
import type { DriverPlanInputType, DriverPlanType } from "../driver/definition.ts";

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

/** Capture cancellation before any other borrowed setting or storage capability. */
function signalSettings(
  options: FileDriverSignalOptionsType,
  operation: string,
  path: PathType,
): AbortSignal | undefined {
  const signal = options.signal;
  throwIfAborted(signal, operation, path);
  return signal;
}

/** Own range fields once; invalid arithmetic cannot reach a native or materialized read. */
function readSettings(options: FileDriverReadOptionsType, path: PathType): Readonly<FileDriverReadOptionsType> {
  const signal = signalSettings(options, "read", path);
  const { at, length } = options;
  for (const value of [at, length]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new RangeError("Record read offsets and lengths must be nonnegative safe integers.");
    }
  }
  throwIfAborted(signal, "read", path);
  return Object.freeze({
    ...(signal === undefined ? {} : { signal }),
    ...(at === undefined ? {} : { at }),
    ...(length === undefined ? {} : { length }),
  });
}

/** Own write policy before metadata acquisition; cancelled planning never dispatches a replacement. */
function writeSettings(options: FileDriverWriteOptionsType, path: PathType): Readonly<FileDriverWriteOptionsType> {
  const signal = signalSettings(options, "write", path);
  const { mode, at, truncate, mediaType } = options;
  if (mode !== "replace" && mode !== "append" && mode !== "update") throw new TypeError("Unknown record write mode.");
  if (at !== undefined && (!Number.isSafeInteger(at) || at < 0)) {
    throw new RangeError("Record write offset must be a nonnegative safe integer.");
  }
  if (truncate !== undefined && typeof truncate !== "boolean") throw new TypeError("Record truncate must be Boolean.");
  if (mediaType !== undefined && typeof mediaType !== "string") throw new TypeError("Record media type must be text.");
  throwIfAborted(signal, "write", path);
  return Object.freeze({
    mode,
    ...(signal === undefined ? {} : { signal }),
    ...(at === undefined ? {} : { at }),
    ...(truncate === undefined ? {} : { truncate }),
    ...(mediaType === undefined ? {} : { mediaType }),
  });
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
  readonly publication: NonNullable<AdapterType["publication"]>;
  /** Native capabilities of a value-oriented record driver. */
  readonly capabilities;
  /** Portable hard limits inherited from the underlying value store. */
  readonly limits?: AdapterLimitsType;
  /** Physical partition layout inherited from the underlying value store. */
  readonly partition?: AdapterPartitionType;
  /** Store that owns durable record persistence. */
  readonly driver: RecordDriverType;
  /** Native operations use the captured store, independent of public inspector shadows. */
  readonly #driver: RecordDriverType;
  /** Prevents all mutation when the upstream storage is read-only. */
  readonly #readOnly: boolean;
  /** Whether adapter disposal also disposes the injected driver. */
  readonly #disposeDriver: boolean;

  /** Resolves immutable adapter policy once instead of closing over factory locals. */
  constructor(driver: RecordDriverType, options: RecordAdapterOptionsType) {
    this.driver = driver;
    this.#driver = driver;
    this.publication = {
      copy: driver.capabilities.replacement === "atomic" ? "preserve" : "best-effort",
      move: "best-effort",
      noReplace: "cooperative",
      durability: "acknowledged",
    };
    this.#readOnly = options.readOnly === true || !driver.capabilities.write;
    this.#disposeDriver = options.disposeDriver ?? false;
    this.name = options.name ?? "record";
    if (options.limits !== undefined) this.limits = structuredClone(options.limits);
    if (options.partition !== undefined) this.partition = structuredClone(options.partition);
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

  /** Rejects configured mutation policy before facade metadata, parents, or source acquisition. */
  admit(input: DriverPlanInputType): DriverPlanType {
    if (mutates(input.operation) && !this.capabilities.write) return readOnlyPlan(input);
    return { operation: input.operation, supported: true, support: "native", problems: [], actions: [] };
  }

  /** Returns portable metadata without materializing file bytes. */
  async stat(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<FileDriverStatType | null> {
    const signal = signalSettings(options, "stat", path);
    if (path === ROOT_PATH) return { kind: "directory" };

    const stat = this.#driver.stat, get = this.#driver.get;
    throwIfAborted(signal, "stat", path);
    const input = await (stat === undefined ? get.call(this.#driver, path) : stat.call(this.#driver, path));
    throwIfAborted(signal, "stat", path);
    if (input === null) return null;
    const record = RecordMetadataSchema.parse(input);
    throwIfAborted(signal, "stat", path);
    if (record.path !== path) throw new TypeError("Stored metadata does not match its physical key.");
    if (record.kind === "directory") return { kind: "directory", lastModified: record.lastModified };
    return { kind: "file", size: record.size, lastModified: record.lastModified, mediaType: record.mediaType };
  }

  /** Decodes one file record and slices the requested byte range in memory. */
  async readFile(path: PathType, options: FileDriverReadOptionsType = {}): Promise<Uint8Array> {
    const settings = readSettings(options, path), native = this.#driver.readFile, get = this.#driver.get;
    throwIfAborted(settings.signal, "read", path);
    if (native !== undefined) {
      const bytes = await native.call(this.#driver, path, settings);
      throwIfAborted(settings.signal, "read", path);
      return bytes;
    }
    const input = await get.call(this.#driver, path);
    throwIfAborted(settings.signal, "read", path);
    const record = input === null ? null : RecordSchema.parse(input);
    throwIfAborted(settings.signal, "read", path);
    if (record === null) throw new FileSystemError("not-found", "read", path, `File '${path}' does not exist.`);
    if (record.kind !== "file") throw new FileSystemError("type-mismatch", "read", path, `'${path}' is a directory.`);

    if (record.path !== path) throw new TypeError("Stored record does not match its physical key.");
    const bytes = decodeBase64(record.data);
    const start = settings.at ?? 0;
    const end = settings.length === undefined ? bytes.byteLength : Math.min(bytes.byteLength, start + settings.length);
    return bytes.slice(start, end);
  }

  /**
   * Applies replace/append/update semantics to one complete record image.
   *
   * This method is intentionally materialized. The facade applies
   * `maxBufferedWriteBytes` before it calls this adapter with a streamed source.
   */
  async writeFile(path: PathType, data: Uint8Array, options: FileDriverWriteOptionsType): Promise<void> {
    const settings = writeSettings(options, path);
    assertWritable(this.#readOnly, "write", path);
    const native = this.#driver.writeFile, stat = this.#driver.stat, get = this.#driver.get, set = this.#driver.set;
    throwIfAborted(settings.signal, "write", path);

    if (native !== undefined && this.#driver.capabilities?.writeModes?.includes(settings.mode)) {
      throwIfAborted(settings.signal, "write", path);
      await native.call(this.#driver, path, data, settings);
      return;
    }

    // Replace needs only previous metadata for directory/type and media-type
    // preservation. Append/update need the complete prior file image. Keeping
    // those paths separate prevents metadata-only stores from reassembling a
    // partitioned body solely to replace it.
    const metadataOnly = settings.mode === "replace" && stat !== undefined;
    const input = await (metadataOnly ? stat.call(this.#driver, path) : get.call(this.#driver, path));
    throwIfAborted(settings.signal, "write", path);
    const previous = input === null
      ? null
      : metadataOnly
      ? RecordMetadataSchema.parse(input)
      : RecordSchema.parse(input);
    throwIfAborted(settings.signal, "write", path);
    if (previous !== null && previous.path !== path) {
      throw new TypeError("Stored metadata does not match its physical key.");
    }
    if (previous?.kind === "directory") {
      throw new FileSystemError("type-mismatch", "write", path, `'${path}' is a directory.`);
    }

    const existing = settings.mode === "replace"
      ? new Uint8Array()
      : previous?.kind === "file" && "data" in previous && typeof previous.data === "string"
      ? decodeBase64(previous.data)
      : new Uint8Array();
    const bytes = applyWrite(existing, data, settings.mode, settings.at, settings.truncate ?? false);
    const record = RecordSchema.parse({
      version: 1,
      path,
      parent: dirname(path),
      name: basename(path),
      kind: "file",
      data: encodeBase64(bytes),
      size: bytes.byteLength,
      lastModified: Date.now(),
      mediaType: settings.mediaType ?? (previous?.kind === "file" ? previous.mediaType : ""),
    });
    throwIfAborted(settings.signal, "write", path);
    await set.call(this.#driver, record);
  }

  /** Opens the store's byte stream only when its declared stream-read capability is active. */
  async openReadStream(path: PathType, options: FileDriverReadOptionsType = {}): Promise<ReadableStream<Uint8Array>> {
    const settings = readSettings(options, path), open = this.#driver.openReadStream;
    throwIfAborted(settings.signal, "read", path);
    if (!this.capabilities.streamRead || open === undefined) {
      throw new FileSystemError(
        "not-supported",
        "read",
        path,
        `Record driver '${this.#driver.name}' does not expose streaming reads.`,
      );
    }
    const stream = await open.call(this.#driver, path, settings);
    try {
      throwIfAborted(settings.signal, "read", path);
      return stream;
    } catch (reason) {
      // An acquired but unpublished stream belongs to this adapter. Join its
      // actual cancellation and preserve an independent producer fault.
      await close([() => retire(stream, reason)], [reason]);
      throw reason;
    }
  }

  /** Commits a native record-driver stream for the write modes the store explicitly advertises. */
  async writeStream(
    path: PathType,
    source: ReadableStream<Uint8Array>,
    options: FileDriverWriteOptionsType,
  ): Promise<void> {
    let settings: Readonly<FileDriverWriteOptionsType>;
    let write: NonNullable<RecordDriverType["writeStream"]>;
    try {
      settings = writeSettings(options, path);
      assertWritable(this.#readOnly, "write", path);
      const native = this.#driver.writeStream;
      throwIfAborted(settings.signal, "write", path);
      if (!this.capabilities.streamWriteModes.includes(settings.mode) || native === undefined) {
        throw new FileSystemError(
          "not-supported",
          "write",
          path,
          `Record driver '${this.#driver.name}' does not expose streaming ${settings.mode} writes.`,
        );
      }
      write = native;
    } catch (error) {
      // Rejected admission still owns the input supplied to this write. Wait
      // for its cancellation, retaining an independent producer cleanup fault.
      try {
        await close([() => retire(source, error)], [error]);
      } catch (reason) {
        throw toFileSystemError(reason, "write", path);
      }
      throw error;
    }
    await write.call(this.#driver, path, source, settings);
  }

  /** Lazily projects direct child records to adapter directory entries. */
  async *readDir(
    path: PathType,
    options: FileDriverSignalOptionsType = {},
  ): AsyncIterableIterator<FileDriverDirectoryEntryType> {
    const signal = signalSettings(options, "read-dir", path), list = this.#driver.list;
    throwIfAborted(signal, "read-dir", path);
    yield* project(list.call(this.#driver, path), (input) => {
      const record = RecordMetadataSchema.parse(input);
      if (record.path === path || record.parent !== path) throw new TypeError("Listed record is not a direct child.");
      return { name: record.name, kind: record.kind };
    }, () => throwIfAborted(signal, "read-dir", path));
  }

  /** Creates one empty directory record when the path is not already present. */
  async createDir(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<void> {
    const signal = signalSettings(options, "mkdir", path);
    assertWritable(this.#readOnly, "mkdir", path);
    const stat = this.#driver.stat, get = this.#driver.get, set = this.#driver.set;
    throwIfAborted(signal, "mkdir", path);

    const input = await (stat === undefined ? get.call(this.#driver, path) : stat.call(this.#driver, path));
    throwIfAborted(signal, "mkdir", path);
    const existing = input === null ? null : RecordMetadataSchema.parse(input);
    throwIfAborted(signal, "mkdir", path);
    if (existing !== null && existing.path !== path) {
      throw new TypeError("Stored metadata does not match its physical key.");
    }
    if (existing?.kind === "file") throw new FileSystemError("type-mismatch", "mkdir", path, `'${path}' is a file.`);
    if (existing !== null) return;

    const record = RecordSchema.parse({
      version: 1,
      path,
      parent: dirname(path),
      name: basename(path),
      kind: "directory",
      lastModified: Date.now(),
    });
    throwIfAborted(signal, "mkdir", path);
    await set.call(this.#driver, record);
  }

  /** Removes one exact record after preserving the configured read-only policy. */
  async remove(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<void> {
    const signal = signalSettings(options, "remove", path);
    assertWritable(this.#readOnly, "remove", path);
    const remove = this.#driver.delete;
    throwIfAborted(signal, "remove", path);
    await remove.call(this.#driver, path);
  }

  /** Disposes the injected driver only when ownership was explicitly transferred. */
  async dispose(): Promise<void> {
    if (this.#disposeDriver) await this.#driver.dispose?.();
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
