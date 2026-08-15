import { toBytes as readStreamBytes } from "@std/streams/to-bytes";
import { z } from "zod";

import { FileSystemError, throwIfAborted } from "../error.ts";
import { ROOT_PATH, type PathType } from "../path.ts";
import type { AdapterLimitsType, WriteModeType } from "../schema.ts";
import type {
  AdapterCopyOptionsType,
  AdapterDirectoryEntryType,
  AdapterReadOptionsType,
  AdapterSignalOptionsType,
  AdapterStatType,
  AdapterType,
  AdapterWriteOptionsType,
} from "./definition.ts";
import { defineAdapter } from "./definition.ts";

/**
 * Native behavior exposed by an object-storage client.
 *
 * These fields describe operations the provider can perform without the
 * filesystem adapter downloading, buffering, or reconstructing an object.
 * Keeping those distinctions visible prevents a remote object service from
 * being documented as if it had local filesystem semantics.
 */
export const ObjectCapabilitiesSchema = z.object({
  rangeRead: z.boolean(),
  streamRead: z.boolean(),
  streamWrite: z.boolean(),
  copy: z.boolean(),
  conditionalWrite: z.boolean(),
});

/** Native object-store behavior used by the filesystem adapter. */
export type ObjectCapabilitiesType = z.output<typeof ObjectCapabilitiesSchema>;

/** Portable object metadata returned by {@link ObjectStoreType.head}. */
export interface ObjectStatType {
  /** Object byte length. */
  readonly size: number;
  /** Last modification time when the provider exposes it. */
  readonly lastModified?: number;
  /** HTTP media type when known. */
  readonly mediaType?: string;
  /** Provider entity tag used for optimistic conditional replacement. */
  readonly etag?: string;
  /** Provider version identity when versioning is enabled. */
  readonly version?: string;
  /** User metadata retained by the provider. */
  readonly metadata?: Readonly<Record<string, string>>;
}

/** One object returned from a prefix listing. */
export interface ObjectEntryType extends ObjectStatType {
  /** Provider object key. */
  readonly key: string;
}

/** One page from an object-store prefix listing. */
export interface ObjectListType {
  /** Objects whose keys match the requested prefix. */
  readonly objects: readonly ObjectEntryType[];
  /** Delimited child prefixes when a delimiter was requested. */
  readonly prefixes: readonly string[];
  /** Cursor supplied to the next list call when more results exist. */
  readonly cursor?: string;
}

/** Options for one object GET. */
export interface ObjectGetOptionsType {
  /** Zero-based byte offset. */
  readonly at?: number;
  /** Maximum bytes to return after `at`. */
  readonly length?: number;
  /** Cancels the HTTP/provider operation. */
  readonly signal?: AbortSignal;
}

/** Options for one object PUT. */
export interface ObjectPutOptionsType {
  /** Media type stored with the object. */
  readonly mediaType?: string;
  /** Provider user metadata. */
  readonly metadata?: Readonly<Record<string, string>>;
  /** Replace only when the current entity tag still matches. */
  readonly ifMatch?: string;
  /** Replace only when the current entity tag does not match. `*` means create only. */
  readonly ifNoneMatch?: string;
  /**
   * Expected body size when the caller knows it before streaming begins.
   *
   * Multipart providers use this value to choose a part size that remains
   * within their maximum part-count limit. The client verifies the declared
   * size when it can observe the final byte count.
   */
  readonly size?: number;
  /** Cancels the HTTP/provider operation. */
  readonly signal?: AbortSignal;
}

/** Options for one provider-side object copy. */
export interface ObjectCopyOptionsType {
  /** Replace only when the destination entity tag still matches. */
  readonly ifMatch?: string;
  /** Replace only when the destination entity tag does not match. */
  readonly ifNoneMatch?: string;
  /** Copy only when the source entity tag still matches. */
  readonly sourceIfMatch?: string;
  /** Copy only when the source entity tag does not match. */
  readonly sourceIfNoneMatch?: string;
  /** Copy only when the source changed after this time. */
  readonly sourceIfModifiedSince?: Date;
  /** Copy only when the source did not change after this time. */
  readonly sourceIfUnmodifiedSince?: Date;
  /** Cancels the provider operation. */
  readonly signal?: AbortSignal;
}

/** Options for prefix listing. */
export interface ObjectListOptionsType {
  /** Key prefix. */
  readonly prefix: string;
  /** Hierarchy delimiter. `/` produces filesystem-like direct children. */
  readonly delimiter?: string;
  /** Maximum entries requested from the provider. */
  readonly limit?: number;
  /** Opaque continuation cursor from a previous result. */
  readonly cursor?: string;
  /** Cancels the provider operation. */
  readonly signal?: AbortSignal;
}

/**
 * Provider-neutral object-storage client used by concrete object services.
 *
 * This contract stops at object-store concepts. S3 multipart state, Azure block
 * state, provider error records, signing, encryption controls, and other wire
 * details remain on the concrete client. The filesystem adapter consumes only
 * the capabilities required to map object keys into OPFS-shaped paths.
 */
export interface ObjectStoreType {
  /** Stable provider/client name used in diagnostics. */
  readonly name: string;
  /** Native object behavior available without filesystem emulation. */
  readonly capabilities: ObjectCapabilitiesType;
  /** Portable hard limits known by this configured client. Missing fields mean unknown. */
  readonly limits?: AdapterLimitsType;
  /** Returns metadata for an exact object key, or null when it is absent. */
  head(key: string, options?: { readonly signal?: AbortSignal }): Promise<ObjectStatType | null>;
  /** Opens one complete object or byte range as a Web stream. */
  get(key: string, options?: ObjectGetOptionsType): Promise<ReadableStream<Uint8Array>>;
  /** Replaces one object. Streaming bodies are allowed only when `streamWrite` is true. */
  put(key: string, body: Uint8Array | ReadableStream<Uint8Array>, options?: ObjectPutOptionsType): Promise<ObjectStatType>;
  /** Removes one exact object key. Missing objects are treated as already removed. */
  delete(key: string, options?: { readonly signal?: AbortSignal }): Promise<void>;
  /** Lists objects and optional child prefixes. */
  list(options: ObjectListOptionsType): Promise<ObjectListType>;
  /** Copies one object without downloading its bytes when `copy` is true. */
  copy?(source: string, destination: string, options?: ObjectCopyOptionsType): Promise<ObjectStatType>;
  /** Releases resources explicitly owned by the client. */
  dispose?(): void | Promise<void>;
}

/** Filesystem mapping options for an object store. */
export interface ObjectAdapterOptionsType {
  /** Prefix reserved for this virtual filesystem. The default is the bucket/container root. */
  readonly prefix?: string;
  /** Disposes the injected object client when the adapter closes. */
  readonly disposeStore?: boolean;
}

/** Minimal evidence retained while resolving whether one virtual directory exists. */
interface DirectoryEvidenceType {
  /** Last modification time when a concrete directory marker supplied one. */
  readonly lastModified?: number;
}

/** Private metadata key that distinguishes library-created directory markers from empty files. */
const DIRECTORY_META = "okikio-opfs-kind";
/** Metadata value written to directory marker objects. */
const DIRECTORY_VALUE = "directory";

/** Normalizes one optional object key prefix without changing provider key case. */
function normalizePrefix(prefix: string | undefined): string {
  if (!prefix) return "";
  return prefix.replace(/^\/+|\/+$/g, "") + "/";
}

/** Maps a canonical file path to its object key. */
function fileKey(prefix: string, path: string): string {
  return `${prefix}${path.slice(1)}`;
}

/** Maps a canonical directory path to its marker/prefix key. */
function directoryKey(prefix: string, path: string): string {
  if (path === ROOT_PATH) return prefix;
  return `${fileKey(prefix, path)}/`;
}

/** Returns the direct child name represented by an object key below one directory prefix. */
function childName(parentKey: string, key: string): string | null {
  if (!key.startsWith(parentKey)) return null;
  const rest = key.slice(parentKey.length).replace(/\/$/, "");
  if (rest.length === 0 || rest.includes("/")) return null;
  return rest;
}

/**
 * Applies append or positional-update semantics to one materialized object.
 *
 * Object services replace complete objects. They do not expose a portable
 * in-place append primitive, so these modes intentionally allocate a new file
 * image before the conditional replacement is committed.
 */
function applyWrite(
  existing: Uint8Array,
  data: Uint8Array,
  mode: WriteModeType,
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

/**
 * OPFS adapter over one object-store client.
 *
 * Files map to ordinary object keys. Directories use trailing-slash marker
 * objects so empty directories survive, while prefix listing also recognizes
 * provider objects that another client created. Append and update use a
 * conditional read-modify-write cycle when the provider exposes ETags.
 *
 * The adapter borrows the object client unless `disposeStore` is true.
 */
class ObjectAdapter implements AdapterType {
  /** Object service that owns provider I/O and provider-specific semantics. */
  readonly #store: ObjectStoreType;
  /** Normalized object-key prefix reserved for this filesystem. */
  readonly #prefix: string;
  /** Whether adapter disposal transfers to the injected object client. */
  readonly #disposeStore: boolean;

  /** Stable adapter name inherited from the provider client. */
  readonly name: string;
  /** Native paths the facade can use without emulation or materialization. */
  readonly capabilities: AdapterType["capabilities"];
  /** Portable provider limits inherited from the object client. */
  readonly limits?: AdapterLimitsType;

  /** Creates one adapter without performing network I/O. */
  constructor(store: ObjectStoreType, options: ObjectAdapterOptionsType) {
    ObjectCapabilitiesSchema.parse(store.capabilities);
    this.#store = store;
    this.#prefix = normalizePrefix(options.prefix);
    this.#disposeStore = options.disposeStore ?? false;
    this.name = store.name;
    if (store.limits !== undefined) this.limits = store.limits;
    this.capabilities = {
      read: true,
      write: true,
      streamRead: store.capabilities.streamRead,
      streamWriteModes: store.capabilities.streamWrite ? ["replace"] : [],
      rangeRead: store.capabilities.rangeRead,
      nativeCopy: store.capabilities.copy,
      nativeMove: false,
      positionalWrite: false,
      syncAccess: false,
    };
  }

  /** Returns exact file metadata without interpreting a sibling key prefix as a file. */
  async #getFile(path: PathType, signal?: AbortSignal): Promise<ObjectStatType | null> {
    return await this.#store.head(fileKey(this.#prefix, path), signal === undefined ? undefined : { signal });
  }

  /**
   * Returns directory evidence from a marker or at least one descendant.
   *
   * This second lookup lets external S3/Azure clients create usable directory
   * trees without knowing the private marker metadata used for empty folders.
   */
  async #getDirectory(path: PathType, signal?: AbortSignal): Promise<DirectoryEvidenceType | null> {
    if (path === ROOT_PATH) return {};
    const key = directoryKey(this.#prefix, path);
    const marker = await this.#store.head(key, signal === undefined ? undefined : { signal });
    if (marker?.metadata?.[DIRECTORY_META] === DIRECTORY_VALUE) return marker;
    const found = await this.#store.list({ prefix: key, delimiter: "/", limit: 1, ...(signal === undefined ? {} : { signal }) });
    return found.objects.length > 0 || found.prefixes.length > 0 ? {} : null;
  }

  /** Returns portable file/directory metadata for one virtual path. */
  async stat(path: PathType, options?: AdapterSignalOptionsType): Promise<AdapterStatType | null> {
    throwIfAborted(options?.signal, "stat", path);
    if (path === ROOT_PATH) return { kind: "directory" };

    const file = await this.#getFile(path, options?.signal);
    if (file !== null) {
      return {
        kind: "file",
        size: file.size,
        lastModified: file.lastModified ?? 0,
        mediaType: file.mediaType ?? "",
      };
    }

    const directory = await this.#getDirectory(path, options?.signal);
    if (directory === null) return null;
    return directory.lastModified === undefined
      ? { kind: "directory" }
      : { kind: "directory", lastModified: directory.lastModified };
  }

  /** Reads one materialized object or byte range. */
  async readFile(path: PathType, options: AdapterReadOptionsType = {}): Promise<Uint8Array> {
    throwIfAborted(options.signal, "read", path);
    if (await this.#getFile(path, options.signal) === null) {
      throw new FileSystemError("not-found", "read", path, `File '${path}' does not exist.`);
    }
    return await readStreamBytes(await this.#store.get(fileKey(this.#prefix, path), options));
  }

  /** Opens the provider's native response stream without eager materialization. */
  async openReadStream(path: PathType, options: AdapterReadOptionsType = {}): Promise<ReadableStream<Uint8Array>> {
    throwIfAborted(options.signal, "read", path);
    if (await this.#getFile(path, options.signal) === null) {
      throw new FileSystemError("not-found", "read", path, `File '${path}' does not exist.`);
    }
    return await this.#store.get(fileKey(this.#prefix, path), options);
  }

  /**
   * Commits materialized bytes with filesystem append/update semantics.
   *
   * Append and update read the previous object, construct the next complete
   * image, then commit it with the previous ETag. A provider that advertises
   * conditional writes but omits an ETag cannot safely perform this sequence.
   */
  async writeFile(path: PathType, data: Uint8Array, options: AdapterWriteOptionsType): Promise<void> {
    throwIfAborted(options.signal, "write", path);
    const previous = await this.#getFile(path, options.signal);
    if (previous === null && await this.#getDirectory(path, options.signal)) {
      throw new FileSystemError("type-mismatch", "write", path, `'${path}' is a directory.`);
    }

    let next = data;
    if (options.mode !== "replace") {
      if (this.#store.capabilities.conditionalWrite && previous !== null && previous.etag === undefined) {
        throw new FileSystemError(
          "unknown",
          "write",
          path,
          `${this.#store.name} advertises conditional writes but HEAD did not return an ETag for '${path}'.`,
        );
      }
      const current = previous === null
        ? new Uint8Array()
        : await readStreamBytes(await this.#store.get(fileKey(this.#prefix, path), options.signal === undefined ? undefined : { signal: options.signal }));
      next = applyWrite(current, data, options.mode, options.at, options.truncate ?? false);
    }

    await this.#store.put(fileKey(this.#prefix, path), next, {
      size: next.byteLength,
      ...(options.mediaType === undefined ? {} : { mediaType: options.mediaType }),
      ...(this.#store.capabilities.conditionalWrite && previous?.etag ? { ifMatch: previous.etag } : {}),
      ...(this.#store.capabilities.conditionalWrite && previous === null && options.mode !== "replace"
        ? { ifNoneMatch: "*" }
        : {}),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  /** Streams one complete replacement directly to providers with native stream upload. */
  async writeStream(path: PathType, source: ReadableStream<Uint8Array>, options: AdapterWriteOptionsType): Promise<void> {
    if (options.mode !== "replace") {
      throw new FileSystemError("not-supported", "write", path, "Object-store streaming is native only for replacement writes.");
    }
    const previous = await this.#getFile(path, options.signal);
    if (previous === null && await this.#getDirectory(path, options.signal)) {
      throw new FileSystemError("type-mismatch", "write", path, `'${path}' is a directory.`);
    }
    await this.#store.put(fileKey(this.#prefix, path), source, {
      ...(options.mediaType === undefined ? {} : { mediaType: options.mediaType }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  /** Lazily lists direct virtual children over provider prefix pagination. */
  async *readDir(path: PathType, options?: AdapterSignalOptionsType): AsyncIterableIterator<AdapterDirectoryEntryType> {
    throwIfAborted(options?.signal, "read-dir", path);
    const parent = directoryKey(this.#prefix, path);
    let cursor: string | undefined;
    const seen = new Set<string>();

    do {
      const page = await this.#store.list({
        prefix: parent,
        delimiter: "/",
        ...(cursor === undefined ? {} : { cursor }),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      for (const childPrefix of page.prefixes) {
        const name = childName(parent, childPrefix);
        if (name !== null && !seen.has(name)) {
          seen.add(name);
          yield { name, kind: "directory" };
        }
      }
      for (const object of page.objects) {
        const name = childName(parent, object.key);
        if (name === null || seen.has(name)) continue;
        seen.add(name);
        yield { name, kind: object.key.endsWith("/") ? "directory" : "file" };
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
  }

  /** Creates an empty-directory marker without replacing a file at the same path. */
  async createDir(path: PathType, options?: AdapterSignalOptionsType): Promise<void> {
    throwIfAborted(options?.signal, "mkdir", path);
    if (await this.#getFile(path, options?.signal)) {
      throw new FileSystemError("type-mismatch", "mkdir", path, `'${path}' is a file.`);
    }
    if (path === ROOT_PATH || await this.#getDirectory(path, options?.signal)) return;
    await this.#store.put(directoryKey(this.#prefix, path), new Uint8Array(), {
      size: 0,
      metadata: { [DIRECTORY_META]: DIRECTORY_VALUE },
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  /** Removes one exact file or one empty directory marker. */
  async remove(path: PathType, options?: AdapterSignalOptionsType): Promise<void> {
    throwIfAborted(options?.signal, "remove", path);
    const file = await this.#getFile(path, options?.signal);
    if (file !== null) {
      await this.#store.delete(fileKey(this.#prefix, path), options);
      return;
    }

    const directory = await this.#getDirectory(path, options?.signal);
    if (directory === null) return;
    const key = directoryKey(this.#prefix, path);
    const page = await this.#store.list({
      prefix: key,
      delimiter: "/",
      limit: 2,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    const hasChildren = page.prefixes.length > 0 || page.objects.some((entry) => entry.key !== key);
    if (hasChildren) throw new FileSystemError("invalid-operation", "remove", path, `Directory '${path}' is not empty.`);
    await this.#store.delete(key, options);
  }

  /** Delegates one file copy to the provider so bytes stay inside the object service. */
  async copy(source: PathType, destination: PathType, options: AdapterCopyOptionsType): Promise<void> {
    if (!this.#store.capabilities.copy || this.#store.copy === undefined) {
      throw new FileSystemError("not-supported", "copy", source, `${this.#store.name} does not expose provider-side copy.`);
    }
    await this.#store.copy(fileKey(this.#prefix, source), fileKey(this.#prefix, destination), {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  /** Disposes the provider only when ownership was explicitly transferred. */
  async dispose(): Promise<void> {
    if (this.#disposeStore) await this.#store.dispose?.();
  }
}

/**
 * Creates the OPFS-shaped filesystem translation for an object store.
 *
 * The returned adapter contains no provider credentials or ambient discovery.
 * It only translates canonical virtual paths into object keys. Provider
 * signing, HTTP behavior, multipart/block lifecycle, and error semantics remain
 * on the injected concrete client.
 *
 * @example Use a direct S3 client as a filesystem backend.
 * ```ts
 * const adapter = createObjectAdapter(s3, { prefix: "app" });
 * const fileSystem = createFileSystem(adapter);
 * await fileSystem.writeFile("/state.json", "{}", { parents: true });
 * ```
 */
export function createObjectAdapter(store: ObjectStoreType, options: ObjectAdapterOptionsType = {}): AdapterType {
  return defineAdapter(new ObjectAdapter(store, options));
}
