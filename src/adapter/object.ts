import { toBytes as readStreamBytes } from "@std/streams/to-bytes";
import { FileSystemError, throwIfAborted } from "../error.ts";
import { type PathType, ROOT_PATH } from "../path.ts";
import type { AdapterLimitsType, WriteModeType } from "../schema.ts";
import type { AdapterType } from "./definition.ts";
import { defineAdapter } from "./definition.ts";
import type {
  FileDriverCopyOptionsType,
  FileDriverDirectoryEntryType,
  FileDriverReadOptionsType,
  FileDriverSignalOptionsType,
  FileDriverStatType,
  FileDriverWriteOptionsType,
} from "../driver/file.ts";

import type {
  ObjectCopyOptionsType,
  ObjectDriverType,
  ObjectEntryType,
  ObjectGetOptionsType,
  ObjectListOptionsType,
  ObjectListType,
  ObjectPutOptionsType,
  ObjectStatType,
} from "../driver/object.ts";

/** Filesystem mapping options for an object store. */
export interface ObjectAdapterOptionsType {
  /** Prefix reserved for this virtual filesystem. The default is the bucket/container root. */
  readonly prefix?: string;
  /** Disposes the injected object client when the adapter closes. */
  readonly disposeDriver?: boolean;
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
 * The adapter borrows the object client unless `disposeDriver` is true.
 */
class ObjectAdapter implements AdapterType {
  /** Object service that owns provider I/O and provider-specific semantics. */
  readonly driver: ObjectDriverType;
  /** Normalized object-key prefix reserved for this filesystem. */
  readonly #prefix: string;
  /** Whether adapter disposal transfers to the injected object client. */
  readonly #disposeDriver: boolean;

  /** Stable adapter name inherited from the provider client. */
  readonly name: string;
  /** Native paths the facade can use without emulation or materialization. */
  readonly capabilities: AdapterType["capabilities"];
  /** Portable provider limits inherited from the object client. */
  readonly limits?: AdapterLimitsType;

  /** Creates one adapter without performing network I/O. */
  constructor(driver: ObjectDriverType, options: ObjectAdapterOptionsType) {
    this.driver = driver;
    this.#prefix = normalizePrefix(options.prefix);
    this.#disposeDriver = options.disposeDriver ?? false;
    this.name = driver.name;
    if (driver.portableLimits !== undefined) this.limits = driver.portableLimits;
    this.capabilities = {
      read: true,
      write: true,
      streamRead: driver.capabilities.streamRead,
      streamWriteModes: driver.capabilities.streamWrite ? ["replace"] : [],
      rangeRead: driver.capabilities.rangeRead,
      nativeCopy: driver.capabilities.copy,
      nativeMove: false,
      positionalWrite: false,
      syncAccess: false,
    };
  }

  /** Returns exact file metadata without interpreting a sibling key prefix as a file. */
  async #getFile(path: PathType, signal?: AbortSignal): Promise<ObjectStatType | null> {
    return await this.driver.head(fileKey(this.#prefix, path), signal === undefined ? undefined : { signal });
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
    const marker = await this.driver.head(key, signal === undefined ? undefined : { signal });
    if (marker?.metadata?.[DIRECTORY_META] === DIRECTORY_VALUE) return marker;
    const found = await this.driver.list({
      prefix: key,
      delimiter: "/",
      limit: 1,
      ...(signal === undefined ? {} : { signal }),
    });
    return found.objects.length > 0 || found.prefixes.length > 0 ? {} : null;
  }

  /** Returns portable file/directory metadata for one virtual path. */
  async stat(path: PathType, options?: FileDriverSignalOptionsType): Promise<FileDriverStatType | null> {
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
  async readFile(path: PathType, options: FileDriverReadOptionsType = {}): Promise<Uint8Array> {
    throwIfAborted(options.signal, "read", path);
    if (await this.#getFile(path, options.signal) === null) {
      throw new FileSystemError("not-found", "read", path, `File '${path}' does not exist.`);
    }
    return await readStreamBytes(await this.driver.get(fileKey(this.#prefix, path), options));
  }

  /** Opens the provider's native response stream without eager materialization. */
  async openReadStream(path: PathType, options: FileDriverReadOptionsType = {}): Promise<ReadableStream<Uint8Array>> {
    throwIfAborted(options.signal, "read", path);
    if (await this.#getFile(path, options.signal) === null) {
      throw new FileSystemError("not-found", "read", path, `File '${path}' does not exist.`);
    }
    return await this.driver.get(fileKey(this.#prefix, path), options);
  }

  /**
   * Commits materialized bytes with filesystem append/update semantics.
   *
   * Append and update read the previous object, construct the next complete
   * image, then commit it with the previous ETag. A provider that advertises
   * conditional writes but omits an ETag cannot safely perform this sequence.
   */
  async writeFile(path: PathType, data: Uint8Array, options: FileDriverWriteOptionsType): Promise<void> {
    throwIfAborted(options.signal, "write", path);
    const previous = await this.#getFile(path, options.signal);
    if (previous === null && await this.#getDirectory(path, options.signal)) {
      throw new FileSystemError("type-mismatch", "write", path, `'${path}' is a directory.`);
    }

    let next = data;
    if (options.mode !== "replace") {
      if (this.driver.capabilities.conditionalWrite && previous !== null && previous.etag === undefined) {
        throw new FileSystemError(
          "unknown",
          "write",
          path,
          `${this.driver.name} advertises conditional writes but HEAD did not return an ETag for '${path}'.`,
        );
      }
      const current = previous === null ? new Uint8Array() : await readStreamBytes(
        await this.driver.get(
          fileKey(this.#prefix, path),
          options.signal === undefined ? undefined : { signal: options.signal },
        ),
      );
      next = applyWrite(current, data, options.mode, options.at, options.truncate ?? false);
    }

    await this.driver.put(fileKey(this.#prefix, path), next, {
      size: next.byteLength,
      ...(options.mediaType === undefined ? {} : { mediaType: options.mediaType }),
      ...(this.driver.capabilities.conditionalWrite && previous?.etag ? { ifMatch: previous.etag } : {}),
      ...(this.driver.capabilities.conditionalWrite && previous === null && options.mode !== "replace"
        ? { ifNoneMatch: "*" }
        : {}),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  /** Streams one complete replacement directly to providers with native stream upload. */
  async writeStream(
    path: PathType,
    source: ReadableStream<Uint8Array>,
    options: FileDriverWriteOptionsType,
  ): Promise<void> {
    if (options.mode !== "replace") {
      throw new FileSystemError(
        "not-supported",
        "write",
        path,
        "Object-store streaming is native only for replacement writes.",
      );
    }
    const previous = await this.#getFile(path, options.signal);
    if (previous === null && await this.#getDirectory(path, options.signal)) {
      throw new FileSystemError("type-mismatch", "write", path, `'${path}' is a directory.`);
    }
    await this.driver.put(fileKey(this.#prefix, path), source, {
      ...(options.mediaType === undefined ? {} : { mediaType: options.mediaType }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  /** Lazily lists direct virtual children over provider prefix pagination. */
  async *readDir(
    path: PathType,
    options?: FileDriverSignalOptionsType,
  ): AsyncIterableIterator<FileDriverDirectoryEntryType> {
    throwIfAborted(options?.signal, "read-dir", path);
    const parent = directoryKey(this.#prefix, path);
    let cursor: string | undefined;
    const seen = new Set<string>();

    do {
      const page = await this.driver.list({
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
  async createDir(path: PathType, options?: FileDriverSignalOptionsType): Promise<void> {
    throwIfAborted(options?.signal, "mkdir", path);
    if (await this.#getFile(path, options?.signal)) {
      throw new FileSystemError("type-mismatch", "mkdir", path, `'${path}' is a file.`);
    }
    if (path === ROOT_PATH || await this.#getDirectory(path, options?.signal)) return;
    await this.driver.put(directoryKey(this.#prefix, path), new Uint8Array(), {
      size: 0,
      metadata: { [DIRECTORY_META]: DIRECTORY_VALUE },
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  /** Removes one exact file or one empty directory marker. */
  async remove(path: PathType, options?: FileDriverSignalOptionsType): Promise<void> {
    throwIfAborted(options?.signal, "remove", path);
    const file = await this.#getFile(path, options?.signal);
    if (file !== null) {
      await this.driver.delete(fileKey(this.#prefix, path), options);
      return;
    }

    const directory = await this.#getDirectory(path, options?.signal);
    if (directory === null) return;
    const key = directoryKey(this.#prefix, path);
    const page = await this.driver.list({
      prefix: key,
      delimiter: "/",
      limit: 2,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    const hasChildren = page.prefixes.length > 0 || page.objects.some((entry) => entry.key !== key);
    if (hasChildren) {
      throw new FileSystemError("invalid-operation", "remove", path, `Directory '${path}' is not empty.`);
    }
    await this.driver.delete(key, options);
  }

  /** Delegates one file copy to the provider so bytes stay inside the object service. */
  async copy(source: PathType, destination: PathType, options: FileDriverCopyOptionsType): Promise<void> {
    if (!this.driver.capabilities.copy || this.driver.copy === undefined) {
      throw new FileSystemError(
        "not-supported",
        "copy",
        source,
        `${this.driver.name} does not expose provider-side copy.`,
      );
    }
    await this.driver.copy(fileKey(this.#prefix, source), fileKey(this.#prefix, destination), {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  /** Disposes the provider only when ownership was explicitly transferred. */
  async dispose(): Promise<void> {
    if (this.#disposeDriver) await this.driver.dispose?.();
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
export function createObjectAdapter(driver: ObjectDriverType, options: ObjectAdapterOptionsType = {}): AdapterType {
  return defineAdapter(new ObjectAdapter(driver, options));
}
