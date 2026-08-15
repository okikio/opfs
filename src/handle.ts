import { FileSystemError } from "./error.ts";
import type { FileSystemType } from "./filesystem.ts";
import { basename, isAncestorPath, joinPath, normalizePath, validateName } from "./path.ts";
import type { EntryKindType } from "./schema.ts";
import type { SyncFileType } from "./sync.ts";
import { toBytes, type WriteDataType } from "./stream.ts";

/** Options matching the File System API create flag. */
export interface HandleCreateOptionsType {
  /** Creates the requested entry when it does not exist. */
  readonly create?: boolean;
}

/** Options matching directory `removeEntry()`. */
export interface HandleRemoveOptionsType {
  /** Removes descendants before a directory. */
  readonly recursive?: boolean;
}

/** Options matching file `createWritable()`. */
export interface CreateWritableOptionsType {
  /** Starts the temporary write image with current file bytes. */
  readonly keepExistingData?: boolean;
}

/** Command accepted by {@link WritableFileStreamType.write}. */
export type WriteCommandType =
  | {
      /** Selects a byte write command. */
      readonly type: "write";
      /** Optional explicit position. Omit it to use the staged stream cursor. */
      readonly position?: number;
      /** Materialized write input inserted at the selected position. */
      readonly data: Exclude<WriteDataType, ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>>;
    }
  | {
      /** Selects a cursor movement without changing file bytes. */
      readonly type: "seek";
      /** New zero-based staged cursor position. */
      readonly position: number;
    }
  | {
      /** Selects a staged file-size change. */
      readonly type: "truncate";
      /** New non-negative staged file size. */
      readonly size: number;
    };

/** Input accepted by OPFS-compatible writable handles. */
export type WritableChunkType =
  | Exclude<WriteDataType, ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>>
  | WriteCommandType;

/** Base contract shared by file and directory handle facades. */
export interface HandleType {
  /** File System API discriminator. */
  readonly kind: EntryKindType;
  /** Final entry name. Root uses an empty string. */
  readonly name: string;
  /** Canonical virtual path that identifies this facade entry. Native FileSystemHandle does not expose it. */
  readonly path: string;
  /** Returns true when both facades represent the same path in the same filesystem. */
  isSameEntry(other: HandleType): Promise<boolean>;
}

/** File System API-shaped file handle backed by the selected adapter. */
export interface FileHandleType extends HandleType {
  /** File discriminator compatible with `FileSystemFileHandle.kind`. */
  readonly kind: "file";
  /** Returns a snapshot File object. */
  getFile(): Promise<File>;
  /** Opens a staged writable object. Bytes commit on close and discard on abort. */
  createWritable(options?: CreateWritableOptionsType): Promise<WritableFileStreamType>;
  /** Opens synchronous random access when the adapter supports it. */
  createSyncAccessHandle(): Promise<SyncFileType>;
}

/** File System API-shaped directory handle backed by the selected adapter. */
export interface DirectoryHandleType extends HandleType, AsyncIterable<[string, FileHandleType | DirectoryHandleType]> {
  /** Directory discriminator compatible with `FileSystemDirectoryHandle.kind`. */
  readonly kind: "directory";
  /** Opens or creates one direct child directory. */
  getDirectoryHandle(name: string, options?: HandleCreateOptionsType): Promise<DirectoryHandleType>;
  /** Opens or creates one direct child file. */
  getFileHandle(name: string, options?: HandleCreateOptionsType): Promise<FileHandleType>;
  /** Removes one direct child. */
  removeEntry(name: string, options?: HandleRemoveOptionsType): Promise<void>;
  /** Resolves a descendant handle to names relative to this directory, or null when unrelated. */
  resolve(possibleDescendant: HandleType): Promise<string[] | null>;
  /** Lazily iterates `[name, handle]` pairs. */
  entries(): AsyncIterableIterator<[string, FileHandleType | DirectoryHandleType]>;
  /** Lazily iterates child names. */
  keys(): AsyncIterableIterator<string>;
  /** Lazily iterates child handles. */
  values(): AsyncIterableIterator<FileHandleType | DirectoryHandleType>;
}

/** Validates writable-stream cursor and truncate positions. */
function assertOffset(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer.`);
}

/**
 * Distinguishes File System API write commands from ordinary Blob data.
 *
 * Blob also exposes a string `type` property, so checking only for the property
 * would incorrectly classify Blob payloads as write commands.
 */
function isWriteCommand(value: WritableChunkType): value is WriteCommandType {
  if (typeof value !== "object" || value === null) return false;
  const type = Reflect.get(value, "type");
  return type === "write" || type === "seek" || type === "truncate";
}

/** Creates the next staged writable image while preserving bytes outside the write range. */
function writeAt(existing: Uint8Array, position: number, data: Uint8Array): Uint8Array {
  const size = Math.max(existing.byteLength, position + data.byteLength);
  const next = new Uint8Array(size);
  next.set(existing);
  next.set(data, position);
  return next;
}

/** Mutable staged image used behind FileSystemWritableFileStream-like methods. */
class WriteSession {
  /** Filesystem instance that owns path resolution and receives the staged image only after close commits. */
  readonly #fileSystem: FileSystemType;
  /** Canonical file path whose current bytes seeded this write session. */
  readonly #path: string;
  /** Mutable staged file image. Abort discards this image without persistence. */
  #bytes: Uint8Array;
  /** Cursor used by write and seek commands inside the staged image. */
  #position = 0;
  /** Prevents a second commit and rejects writes after close or abort. */
  #done = false;

  /** Starts one in-memory staged image from the file snapshot visible when the session opens. */
  constructor(fileSystem: FileSystemType, path: string, bytes: Uint8Array) {
    this.#fileSystem = fileSystem;
    this.#path = path;
    this.#bytes = bytes;
  }

  /** Rejects operations after the session has reached its terminal state. */
  #assertOpen(): void {
    if (this.#done) {
      throw new FileSystemError(
        "invalid-operation",
        "writable",
        this.#path,
        `Writable file '${this.#path}' is already closed or aborted.`,
      );
    }
  }

  /** Applies one File System API write command or byte payload to the staged image. */
  async write(chunk: WritableChunkType): Promise<void> {
    this.#assertOpen();
    if (isWriteCommand(chunk)) {
      if (chunk.type === "seek") return this.seek(chunk.position);
      if (chunk.type === "truncate") return this.truncate(chunk.size);
      if (chunk.position !== undefined) this.seek(chunk.position);
      return await this.write(chunk.data);
    }

    const data = await toBytes(chunk);
    this.#bytes = writeAt(this.#bytes, this.#position, data);
    this.#position += data.byteLength;
  }

  /** Moves the staged cursor without changing committed storage. */
  seek(position: number): void {
    this.#assertOpen();
    assertOffset(position, "position");
    this.#position = position;
  }

  /** Resizes the staged image and clamps the cursor when it falls past the new end. */
  truncate(size: number): void {
    this.#assertOpen();
    assertOffset(size, "size");
    const next = new Uint8Array(size);
    next.set(this.#bytes.subarray(0, size));
    this.#bytes = next;
    if (this.#position > size) this.#position = size;
  }

  /** Commits the complete staged image exactly once through the owning filesystem facade. */
  async close(): Promise<void> {
    this.#assertOpen();
    this.#done = true;
    await this.#fileSystem.writeFile(this.#path, this.#bytes, { mode: "replace" });
  }

  /** Marks the staged image terminal without persisting any of its bytes. */
  abort(): void {
    if (this.#done) return;
    this.#done = true;
  }
}

/**
 * WritableStream-compatible object returned by {@link FileHandleType.createWritable}.
 *
 * The standard OPFS writable stream stages data and commits on close. This
 * adapter-independent implementation does the same at the facade level. It
 * keeps the staged file in memory, so large sequential writes should use
 * `FileSystemType.writeFile()` with a streaming-capable adapter instead.
 */
export class WritableFileStream extends WritableStream<WritableChunkType> {
  /** In-memory staged write state committed only when the writable stream closes. */
  readonly #session: WriteSession;

  /** Wraps one staged session in the browser-compatible WritableStream contract. */
  constructor(session: WriteSession) {
    super({
      write: async (chunk) => await session.write(chunk),
      close: async () => await session.close(),
      abort: () => session.abort(),
    });
    this.#session = session;
  }

  /** Writes bytes or a standard write/seek/truncate command. */
  async write(data: WritableChunkType): Promise<void> {
    if (this.locked) throw new TypeError("Writable file stream is locked by another writer.");
    const writer = this.getWriter();
    try {
      await writer.write(data);
    } finally {
      writer.releaseLock();
    }
  }

  /** Changes the staged cursor without committing. */
  async seek(position: number): Promise<void> {
    if (this.locked) throw new TypeError("Writable file stream is locked by another writer.");
    this.#session.seek(position);
  }

  /** Changes staged file length without committing. */
  async truncate(size: number): Promise<void> {
    if (this.locked) throw new TypeError("Writable file stream is locked by another writer.");
    this.#session.truncate(size);
  }

  /** Commits staged bytes and closes the stream. */
  override async close(): Promise<void> {
    if (this.locked) throw new TypeError("Writable file stream is locked by another writer.");
    const writer = this.getWriter();
    try {
      await writer.close();
    } finally {
      writer.releaseLock();
    }
  }
}

/** Public type for the OPFS-compatible writable stream. */
export type WritableFileStreamType = WritableFileStream;

/**
 * Shared identity implementation for OPFS-shaped facade handles.
 *
 * Filesystem identity stays private so callers cannot mutate adapter ownership,
 * but sibling facade objects can still prove same-entry and descendant relations.
 */
abstract class BaseHandle implements HandleType {
  /** Concrete entry discriminator supplied by the file or directory subclass. */
  abstract readonly kind: EntryKindType;
  /** Canonical virtual path that identifies this facade entry. */
  readonly path: string;
  /** Filesystem instance that owns path resolution and persistence for this handle. */
  readonly #fileSystem: FileSystemType;

  /** Binds one normalized virtual path to the filesystem instance that owns its identity. */
  constructor(fileSystem: FileSystemType, path: string) {
    this.#fileSystem = fileSystem;
    this.path = normalizePath(path);
  }

  /** Returns the final path segment, or an empty string for the virtual root. */
  get name(): string {
    return basename(this.path);
  }

  /** Gives subclasses controlled access to the owning filesystem facade. */
  protected get fileSystem(): FileSystemType {
    return this.#fileSystem;
  }

  /** Returns whether another facade belongs to this exact filesystem instance. */
  protected belongsToSameFileSystem(other: HandleType): boolean {
    return other instanceof BaseHandle && other.#fileSystem === this.#fileSystem;
  }

  /** Compares both filesystem identity and canonical path, not only the visible name. */
  async isSameEntry(other: HandleType): Promise<boolean> {
    return this.belongsToSameFileSystem(other) && other.path === this.path;
  }
}

/**
 * Concrete File System API-shaped file handle facade.
 *
 * The object stores only filesystem identity and a canonical virtual path. It
 * does not pin an adapter-native file descriptor or browser handle. `getFile()`
 * therefore returns a fresh snapshot, while `createSyncAccessHandle()` acquires
 * the real backend resource only for the returned sync-file lifetime.
 */
export class FileHandle extends BaseHandle implements FileHandleType {
  /** File discriminator exposed to OPFS-oriented consumers. */
  readonly kind = "file" as const;

  /** Returns a fresh immutable `File` snapshot from the current backend state. */
  async getFile(): Promise<File> {
    return await this.fileSystem.getFile(this.path);
  }

  /**
   * Creates an OPFS-compatible staged writable stream.
   *
   * This handle-level API stages bytes in memory. Use `FileSystemType.writeFile`
   * for large streaming writes that should reach a streaming adapter directly.
   */
  async createWritable(options: CreateWritableOptionsType = {}): Promise<WritableFileStreamType> {
    const bytes = options.keepExistingData ? await this.fileSystem.readFile(this.path) : new Uint8Array();
    return new WritableFileStream(new WriteSession(this.fileSystem, this.path, bytes));
  }

  /** Opens adapter synchronous random access and transfers lock ownership to the returned resource. */
  async createSyncAccessHandle(): Promise<SyncFileType> {
    return await this.fileSystem.openSyncFile(this.path);
  }
}

/**
 * Concrete File System API-shaped directory handle facade.
 *
 * Child lookups stay direct-child operations and validate names before they are
 * joined to the directory path. Iteration delegates to the filesystem's lazy
 * `readDir()` implementation, so large directories are not eagerly collected by
 * this facade.
 */
export class DirectoryHandle extends BaseHandle implements DirectoryHandleType {
  /** Directory discriminator exposed to OPFS-oriented consumers. */
  readonly kind = "directory" as const;

  /** Opens or creates one direct child directory after validating the child name. */
  async getDirectoryHandle(name: string, options: HandleCreateOptionsType = {}): Promise<DirectoryHandleType> {
    validateName(name);
    return await this.fileSystem.getDirectoryHandle(joinPath(this.path, name), { create: options.create ?? false });
  }

  /** Opens or creates one direct child file after validating the child name. */
  async getFileHandle(name: string, options: HandleCreateOptionsType = {}): Promise<FileHandleType> {
    validateName(name);
    return await this.fileSystem.getFileHandle(joinPath(this.path, name), { create: options.create ?? false });
  }

  /** Removes one direct child through the filesystem's coordinated removal path. */
  async removeEntry(name: string, options: HandleRemoveOptionsType = {}): Promise<void> {
    validateName(name);
    await this.fileSystem.remove(joinPath(this.path, name), { recursive: options.recursive ?? false });
  }

  /** Resolves a descendant only when both handles belong to this same filesystem instance. */
  async resolve(possibleDescendant: HandleType): Promise<string[] | null> {
    if (!(possibleDescendant instanceof BaseHandle) || !this.belongsToSameFileSystem(possibleDescendant)) return null;
    if (possibleDescendant.path === this.path) return [];
    if (!isAncestorPath(this.path, possibleDescendant.path)) return null;
    const relative = possibleDescendant.path.slice(this.path === "/" ? 1 : this.path.length + 1);
    return relative.length === 0 ? [] : relative.split("/");
  }

  /** Lazily yields direct-child name and handle pairs. */
  async *entries(): AsyncIterableIterator<[string, FileHandleType | DirectoryHandleType]> {
    for await (const entry of this.fileSystem.readDir(this.path)) yield [entry.name, entry.handle];
  }

  /** Lazily yields direct-child names without collecting the directory. */
  async *keys(): AsyncIterableIterator<string> {
    for await (const [name] of this.entries()) yield name;
  }

  /** Lazily yields direct-child file or directory handles. */
  async *values(): AsyncIterableIterator<FileHandleType | DirectoryHandleType> {
    for await (const [, handle] of this.entries()) yield handle;
  }

  /** Makes the directory itself iterable with the same semantics as {@link entries}. */
  [Symbol.asyncIterator](): AsyncIterableIterator<[string, FileHandleType | DirectoryHandleType]> {
    return this.entries();
  }
}
