import type { AdapterType } from "./definition.ts";
import { defineAdapter } from "./definition.ts";
import { FileSystemError, throwIfAborted } from "../error.ts";
import { basename, dirname, ROOT_PATH, type PathType } from "../path.ts";
import { RecordSchema, type RecordType } from "../schema.ts";

/**
 * Persistence contract used by value/document/SQL ecosystem bridges.
 *
 * `list(parent)` returns direct children only. Stores own indexing choices.
 * The filesystem adapter borrows the store unless a store implementation says
 * otherwise through its own creation options.
 */
export interface RecordStoreType {
  /** Returns one record by canonical path, or null when absent. */
  get(path: PathType): Promise<RecordType | null>;
  /** Atomically replaces one logical record as far as the backend permits. */
  set(record: RecordType): Promise<void>;
  /** Deletes one record. The record adapter removes descendants separately. */
  delete(path: PathType): Promise<void>;
  /** Lazily returns direct child records. */
  list(parent: PathType): AsyncIterableIterator<RecordType>;
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
}

/** Encodes bytes in bounded chunks so large arrays do not overflow function-argument limits. */
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize)));
  }
  return btoa(binary);
}

/** Decodes the portable base64 representation used by JSON/document/SQL stores. */
function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
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
 * Creates a filesystem adapter over a generic record store.
 *
 * This is the common implementation used by RxDB, unstorage, db0, and Drizzle.
 * It intentionally reports no native streaming capability because a complete
 * base64 record is the durable unit in those ecosystems. The facade therefore
 * applies `maxBufferedWriteBytes` when a caller streams into this adapter.
 *
 * @example Build a filesystem over a custom document store.
 * ```ts
 * const adapter = createRecordAdapter(store, { name: "documents" });
 * const fs = createFileSystem(adapter);
 * await fs.writeFile("/state.json", "{}", { parents: true });
 * ```
 */
export function createRecordAdapter(store: RecordStoreType, options: RecordAdapterOptionsType = {}): AdapterType {
  const readOnly = options.readOnly ?? false;
  return defineAdapter({
    name: options.name ?? "record",
    capabilities: {
      read: true,
      write: !readOnly,
      streamRead: false,
      streamWrite: false,
      rangeRead: false,
      nativeMove: false,
      positionalWrite: false,
      syncAccess: false,
    },
    async stat(path, operationOptions) {
      throwIfAborted(operationOptions?.signal, "stat", path);
      if (path === ROOT_PATH) return { kind: "directory" };
      const record = await store.get(path);
      if (record === null) return null;
      if (record.kind === "directory") return { kind: "directory", lastModified: record.lastModified };
      return { kind: "file", size: record.size, lastModified: record.lastModified, mediaType: record.mediaType };
    },
    async readFile(path, readOptions = {}) {
      throwIfAborted(readOptions.signal, "read", path);
      const record = await store.get(path);
      if (record === null) throw new FileSystemError("not-found", "read", path, `File '${path}' does not exist.`);
      if (record.kind !== "file") throw new FileSystemError("type-mismatch", "read", path, `'${path}' is a directory.`);
      const bytes = decodeBase64(record.data);
      const start = readOptions.at ?? 0;
      const end = readOptions.length === undefined
        ? bytes.byteLength
        : Math.min(bytes.byteLength, start + readOptions.length);
      return bytes.slice(start, end);
    },
    async writeFile(path, data, writeOptions) {
      assertWritable(readOnly, "write", path);
      throwIfAborted(writeOptions.signal, "write", path);
      const previous = await store.get(path);
      if (previous?.kind === "directory") {
        throw new FileSystemError("type-mismatch", "write", path, `'${path}' is a directory.`);
      }
      const existing = previous?.kind === "file" ? decodeBase64(previous.data) : new Uint8Array();
      const bytes = applyWrite(existing, data, writeOptions.mode, writeOptions.at, writeOptions.truncate ?? false);
      await store.set(RecordSchema.parse({
        version: 1,
        path,
        parent: dirname(path),
        name: basename(path),
        kind: "file",
        data: encodeBase64(bytes),
        size: bytes.byteLength,
        lastModified: Date.now(),
        mediaType: writeOptions.mediaType ?? (previous?.kind === "file" ? previous.mediaType : ""),
      }));
    },
    async *readDir(path, operationOptions) {
      throwIfAborted(operationOptions?.signal, "read-dir", path);
      for await (const record of store.list(path)) {
        throwIfAborted(operationOptions?.signal, "read-dir", path);
        yield { name: record.name, kind: record.kind };
      }
    },
    async createDir(path, operationOptions) {
      assertWritable(readOnly, "mkdir", path);
      throwIfAborted(operationOptions?.signal, "mkdir", path);
      const existing = await store.get(path);
      if (existing?.kind === "file") throw new FileSystemError("type-mismatch", "mkdir", path, `'${path}' is a file.`);
      if (existing !== null) return;
      await store.set(RecordSchema.parse({
        version: 1,
        path,
        parent: dirname(path),
        name: basename(path),
        kind: "directory",
        lastModified: Date.now(),
      }));
    },
    async remove(path, operationOptions) {
      assertWritable(readOnly, "remove", path);
      throwIfAborted(operationOptions?.signal, "remove", path);
      await store.delete(path);
    },
    async dispose() {
      if (options.disposeStore) await store.dispose?.();
    },
  });
}
