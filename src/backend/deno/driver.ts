/// <reference types="deno" />
/** Deno host operations compose explicit range, stream, positional and synchronous resource owners. @module */
import {
  admitHost,
  assertHostAdmission,
  assertHostPrimitive,
  getHostCapabilities,
  getHostPublication,
  type HostProfileInputType,
  type HostProfileType,
  resolveHostProfile,
} from "../../driver/host.ts";
import type { DriverPlanInputType, DriverPlanType } from "../../driver/definition.ts";
import { validateWritableOptions, type WritableOptionsType } from "../../driver/writable.ts";
import type {
  FileBackendType,
  FileDriverCopyOptionsType,
  FileDriverDirectoryEntryType,
  FileDriverMoveOptionsType,
  FileDriverReadOptionsType,
  FileDriverSignalOptionsType,
  FileDriverStatType,
  FileDriverSyncFileType,
  FileDriverType,
  FileDriverWritableFileType,
  FileDriverWriteOptionsType,
  FileEntryKindType,
  FileEntryType,
} from "../../driver/file.ts";
import { defineFileDriver } from "../../driver/file.ts";
import { createLocalPath } from "../../driver/local.ts";
import { FileSystemError, throwIfAborted, toFileSystemError } from "../../error.ts";
import { dirname, joinPath, type PathType } from "../../path.ts";
import { withAbortSignal } from "../../stream/mod.ts";
import { close } from "../../close.ts";
import { isBytes, toView } from "../../bytes.ts";
import { DenoRangeSource } from "./range.ts";
import { DenoSyncFile } from "./sync.ts";
import { DenoWritableFile } from "./writable.ts";
import { writeStreamToFile } from "./write.ts";

export { DenoRangeSource, RANGE_CHUNK_BYTES } from "./range.ts";
export { DenoSyncFile } from "./sync.ts";
export { DenoWritableFile } from "./writable.ts";
export { writeStreamToFile } from "./write.ts";

/**
 * Options for the Deno-native file driver.
 *
 * The configured `root` is the lexical host namespace represented by virtual
 * `/`. Deno-specific I/O semantics stay in the driver rather than being
 * flattened into the adapter or facade layers. Native Deno calls follow
 * symbolic links already present below that root, so the root must be trusted
 * when filesystem access is a security concern.
 */
export interface DenoDriverOptionsType {
  /** Host directory exposed as virtual `/`. */
  readonly root: string;
  /** Creates the host root during driver creation. Defaults to true. */
  readonly createRoot?: boolean;
  /** Explicit root deployment facts. Defaults to the ordinary native-host assumption. */
  readonly profile?: HostProfileInputType;
}

/**
 * Deno host-filesystem implementation of the portable file-driver contract.
 *
 * Deno owns the native file and directory operations. `@std/path` is used only
 * by the shared host-path mapper so Deno, Node, and Bun apply the same host-root
 * containment rule.
 */
export class DenoBackend implements FileBackendType {
  /** Validated immutable root facts, separate from live mount/permission observations. */
  readonly hostProfile: HostProfileType;
  /** Native operation-specific guarantees derived from the selected profile. */
  readonly publication: ReturnType<typeof getHostPublication>;
  /** Admitted native feature surface for this root deployment. */
  readonly capabilities: ReturnType<typeof getHostCapabilities>;

  /** One hard policy shared by native entrypoints and pure planning. */
  admit(input: DriverPlanInputType): DriverPlanType {
    return admitHost(this.hostProfile, input);
  }

  /** Enforces declared policy before parent probes or descriptor acquisition. */
  #admit(input: DriverPlanInputType): void {
    assertHostAdmission(this.admit(input), input.path);
  }

  /** Stable driver identity used in diagnostics. */
  readonly name = "deno";

  /** Maps canonical virtual paths below the configured host root. */
  readonly #hostPath: (path: string) => string;

  /** Resolves the host root once and optionally creates it. */
  constructor(options: DenoDriverOptionsType) {
    this.hostProfile = resolveHostProfile(options.profile);
    this.publication = getHostPublication(this.hostProfile);
    this.capabilities = getHostCapabilities(this.hostProfile);
    if (this.hostProfile.readOnly && options.createRoot === true) {
      throw new TypeError("Read-only host profile cannot createRoot.");
    }
    this.#hostPath = createLocalPath(options.root);
    if (options.createRoot ?? !this.hostProfile.readOnly) Deno.mkdirSync(this.#hostPath("/"), { recursive: true });
  }

  /** Rejects stable alias ancestors before structural work; hostile path swaps remain a host boundary. */
  async #parents(path: PathType, options: FileDriverSignalOptionsType): Promise<void> {
    for (let parent = dirname(path); parent !== "/"; parent = dirname(parent)) {
      const kind = await this.entry(parent, options);
      if (kind === "link" || kind === "foreign") {
        throw new FileSystemError(
          "not-supported",
          "structure",
          path,
          "Structural paths cannot traverse a link or foreign ancestor.",
        );
      }
    }
  }

  /** Returns physical identity; destructive traversal must never use followed target metadata. */
  async entry(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<FileEntryKindType | null> {
    throwIfAborted(options.signal, "stat", path);
    try {
      const info = await Deno.lstat(this.#hostPath(path));
      throwIfAborted(options.signal, "stat", path);
      return info.isSymlink ? "link" : info.isDirectory ? "directory" : info.isFile ? "file" : "foreign";
    } catch (error) {
      throwIfAborted(options.signal, "stat", path);
      if (toFileSystemError(error, "stat", path).code === "not-found") return null;
      throw error;
    }
  }

  /** Lists every physical child, including links, for no-follow removal. */
  async *entries(path: PathType, options: FileDriverSignalOptionsType = {}): AsyncIterableIterator<FileEntryType> {
    await this.#parents(path, options);
    if (await this.entry(path, options) !== "directory") {
      throw new FileSystemError(
        "type-mismatch",
        "read-dir",
        path,
        "Physical traversal requires an ordinary directory.",
      );
    }
    throwIfAborted(options.signal, "read-dir", path);
    for await (const entry of Deno.readDir(this.#hostPath(path))) {
      throwIfAborted(options.signal, "read-dir", path);
      yield {
        name: entry.name,
        kind: entry.isSymlink ? "link" : entry.isDirectory ? "directory" : entry.isFile ? "file" : "foreign",
      };
    }
  }

  /**
   * Reads the entry at `path`, or returns `null` when nothing is there.
   * @param path Path in the driver's root.
   * @param options Cancellation for the call.
   */
  async stat(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<FileDriverStatType | null> {
    throwIfAborted(options.signal, "stat", path);
    try {
      const info = await Deno.stat(this.#hostPath(path));
      throwIfAborted(options.signal, "stat", path);
      return info.isDirectory
        ? { kind: "directory", ...(info.mtime === null ? {} : { lastModified: info.mtime.getTime() }) }
        : { kind: "file", size: info.size, lastModified: info.mtime?.getTime() ?? 0, mediaType: "" };
    } catch (error) {
      throwIfAborted(options.signal, "stat", path);
      const mapped = toFileSystemError(error, "stat", path);
      if (mapped.code === "not-found") return null;
      throw mapped;
    }
  }

  /** Reads complete bytes or performs positioned reads for one range. */
  async readFile(path: PathType, options: FileDriverReadOptionsType = {}): Promise<Uint8Array> {
    throwIfAborted(options.signal, "read", path);
    if (options.at === undefined && options.length === undefined) {
      try {
        const bytes = await Deno.readFile(this.#hostPath(path), {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        throwIfAborted(options.signal, "read", path);
        return bytes;
      } catch (error) {
        throwIfAborted(options.signal, "read", path);
        throw error;
      }
    }

    const file = await Deno.open(this.#hostPath(path), { read: true });
    let primary: readonly unknown[] = [];
    try {
      throwIfAborted(options.signal, "read", path);
      const info = await file.stat();
      throwIfAborted(options.signal, "read", path);
      if (info.isDirectory) throw new FileSystemError("type-mismatch", "read", path, `'${path}' is a directory.`);
      const start = options.at ?? 0;
      const length = Math.max(0, Math.min(options.length ?? info.size - start, info.size - start));
      throwIfAborted(options.signal, "read", path);
      await file.seek(start, Deno.SeekMode.Start);
      throwIfAborted(options.signal, "read", path);
      const output = new Uint8Array(length);
      let offset = 0;
      while (offset < length) {
        throwIfAborted(options.signal, "read", path);
        const count = await file.read(output.subarray(offset));
        throwIfAborted(options.signal, "read", path);
        if (count === null) break;
        offset += count;
      }
      return offset === output.byteLength ? output : output.slice(0, offset);
    } catch (reason) {
      primary = [reason];
      throw reason;
    } finally {
      await close([() => file.close()], primary);
    }
  }

  /** Opens Deno's native stream, or a bounded incremental stream for one finite range. */
  async openReadStream(path: PathType, options: FileDriverReadOptionsType = {}): Promise<ReadableStream<Uint8Array>> {
    throwIfAborted(options.signal, "read", path);
    const file = await Deno.open(this.#hostPath(path), { read: true });
    let closing = false;
    try {
      throwIfAborted(options.signal, "read", path);
      if (options.at === undefined && options.length === undefined) {
        return withAbortSignal(file.readable, options.signal, path);
      }
      throwIfAborted(options.signal, "read", path);
      const info = await file.stat();
      throwIfAborted(options.signal, "read", path);
      if (info.isDirectory) throw new FileSystemError("type-mismatch", "read", path, `'${path}' is a directory.`);
      const start = options.at ?? 0;
      throwIfAborted(options.signal, "read", path);
      await file.seek(start, Deno.SeekMode.Start);
      throwIfAborted(options.signal, "read", path);
      if (options.length === undefined) return withAbortSignal(file.readable, options.signal, path);
      if (options.length === 0) {
        closing = true;
        file.close();
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
      }
      return withAbortSignal(new ReadableStream(new DenoRangeSource(file, options.length)), options.signal, path);
    } catch (error) {
      await close([() => {
        if (!closing) file.close();
      }], [error]);
      throw error;
    }
  }

  /** Writes materialized bytes with replace, append, or positioned update semantics. */
  async writeFile(path: PathType, data: Uint8Array, options: FileDriverWriteOptionsType): Promise<void> {
    this.#admit({ operation: "write", path, mode: options.mode, source: "bytes" });
    throwIfAborted(options.signal, "write", path);
    if (!isBytes(data)) throw new TypeError("A file write must use a Uint8Array.");
    data = toView(data);
    if (options.mode === "replace") {
      try {
        await Deno.writeFile(this.#hostPath(path), data, {
          create: true,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        throwIfAborted(options.signal, "write", path);
        return;
      } catch (error) {
        throwIfAborted(options.signal, "write", path);
        throw error;
      }
    }

    const file = await Deno.open(this.#hostPath(path), { read: true, write: true, create: true });
    let primary: readonly unknown[] = [];
    try {
      throwIfAborted(options.signal, "write", path);
      const position = options.mode === "append" ? (await file.stat()).size : options.at ?? 0;
      throwIfAborted(options.signal, "write", path);
      await file.seek(position, Deno.SeekMode.Start);
      throwIfAborted(options.signal, "write", path);
      let offset = 0;
      while (offset < data.byteLength) {
        throwIfAborted(options.signal, "write", path);
        const count = await file.write(data.subarray(offset));
        throwIfAborted(options.signal, "write", path);
        if (count <= 0) throw new Error(`Deno write made no progress for '${path}'.`);
        offset += count;
      }
      throwIfAborted(options.signal, "write", path);
      if (options.truncate) await file.truncate(position + data.byteLength);
    } catch (reason) {
      primary = [reason];
      throw reason;
    } finally {
      await close([() => file.close()], primary);
    }
  }

  /** Streams directly into one Deno file without facade materialization. */
  async writeStream(
    path: PathType,
    source: ReadableStream<Uint8Array>,
    options: FileDriverWriteOptionsType,
  ): Promise<void> {
    this.#admit({ operation: "write", path, mode: options.mode, source: "stream" });
    throwIfAborted(options.signal, "write", path);
    const file = await Deno.open(this.#hostPath(path), {
      read: true,
      write: true,
      create: true,
      truncate: options.mode === "replace",
    });
    let primary: readonly unknown[] = [];
    try {
      const position = await writeStreamToFile(file, path, source, options);
      throwIfAborted(options.signal, "write", path);
      if (options.truncate) await file.truncate(position);
    } catch (reason) {
      primary = [reason];
      throw reason;
    } finally {
      await close([() => file.close()], primary);
    }
  }

  /** Lazily yields direct file and directory children from Deno. */
  async *readDir(
    path: PathType,
    options: FileDriverSignalOptionsType = {},
  ): AsyncIterableIterator<FileDriverDirectoryEntryType> {
    throwIfAborted(options.signal, "read-dir", path);
    for await (const entry of this.entries(path, options)) {
      if (entry.kind !== "file" && entry.kind !== "directory") {
        throw new FileSystemError(
          "not-supported",
          "read-dir",
          path,
          `Entry '${entry.name}' is ${entry.kind}; use explicit remove to unlink it without following its target.`,
        );
      }
      yield { name: entry.name, kind: entry.kind };
    }
  }

  /** Creates one directory after facade parent resolution. */
  async createDir(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<void> {
    this.#admit({ operation: "write", path });
    await this.#parents(path, options);
    throwIfAborted(options.signal, "mkdir", path);
    await Deno.mkdir(this.#hostPath(path));
  }

  /** Removes one file or empty directory. */
  async remove(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<void> {
    this.#admit({ operation: "remove", path });
    await this.#parents(path, options);
    throwIfAborted(options.signal, "remove", path);
    await Deno.remove(this.#hostPath(path));
  }

  /** Copies one host file through Deno's native copy operation. */
  async copy(source: PathType, destination: PathType, options: FileDriverCopyOptionsType): Promise<void> {
    this.#admit({
      operation: "copy",
      path: source,
      destination,
      overwrite: options.overwrite,
      preserve: options.preserve,
      exclusive: options.exclusive,
    });
    await this.#parents(source, options);
    await this.#parents(destination, options);
    if (await this.entry(source, options) !== "file") {
      throw new FileSystemError("type-mismatch", "copy", source, "Native file copy requires an ordinary source file.");
    }
    throwIfAborted(options.signal, "copy", source);
    const from = this.#hostPath(source);
    const to = this.#hostPath(destination);
    const stage = this.#hostPath(joinPath(dirname(destination), `.opfs-${crypto.randomUUID()}.part`));
    // Reserve before copying; cleanup must never remove an unowned collision.
    const reservation = await Deno.open(stage, { write: true, createNew: true });
    let consumed = false;
    let primary: readonly unknown[] = [];
    try {
      reservation.close();
      throwIfAborted(options.signal, "copy", source);
      await Deno.copyFile(from, stage);
      throwIfAborted(options.signal, "copy", source);
      if (options.overwrite) {
        await Deno.rename(stage, to);
        consumed = true;
      } else await Deno.link(stage, to);
    } catch (reason) {
      primary = [reason];
      throw reason;
    } finally {
      // A successful rename consumed this name. Never remove a later entry there.
      await close([async () => {
        if (!consumed) await Deno.remove(stage);
      }], primary);
    }
  }

  /** Moves one host path through Deno's native rename operation. */
  async move(source: PathType, destination: PathType, options: FileDriverMoveOptionsType): Promise<void> {
    this.#admit({
      operation: "move",
      path: source,
      destination,
      overwrite: options.overwrite,
      preserve: options.preserve,
      exclusive: options.exclusive,
    });
    await this.#parents(source, options);
    await this.#parents(destination, options);
    throwIfAborted(options.signal, "move", source);
    if (options.exclusive && !options.overwrite) {
      throw new FileSystemError(
        "not-supported",
        "move",
        destination,
        "Portable host rename has no atomic no-replace primitive; omit exclusive for a cooperating-owner precheck.",
      );
    }
    if (await this.entry(source, options) === null) {
      throw new FileSystemError("not-found", "move", source, `Source '${source}' does not exist.`);
    }
    if (!options.overwrite && await this.entry(destination, options) !== null) {
      throw new FileSystemError("already-exists", "move", destination, `Destination '${destination}' already exists.`);
    }
    throwIfAborted(options.signal, "move", source);
    await Deno.rename(this.#hostPath(source), this.#hostPath(destination));
  }

  /** Reserves a private sibling before any fallback can write or clean it up. */
  async reserve(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<void> {
    assertHostPrimitive(this.hostProfile, "reserve", path);
    await this.#parents(path, options);
    throwIfAborted(options.signal, "reserve", path);
    const file = await Deno.open(this.#hostPath(path), { write: true, createNew: true });
    try {
      file.close();
    } catch (reason) {
      await close([() => Deno.remove(this.#hostPath(path))], [reason]);
    }
  }

  /** Opens one long-lived asynchronous positional Deno file. */
  async openWritableFile(path: PathType, options?: WritableOptionsType): Promise<FileDriverWritableFileType> {
    assertHostPrimitive(this.hostProfile, "positionalWrite", path);
    validateWritableOptions(options);
    const file = await Deno.open(this.#hostPath(path), { read: true, write: true });
    try {
      return new DenoWritableFile(path, file, options);
    } catch (reason) {
      await close([() => file.close()], [reason]);
      throw reason;
    }
  }

  /** Opens one synchronous Deno file and transfers ownership to the wrapper. */
  async openSyncFile(path: PathType): Promise<FileDriverSyncFileType> {
    assertHostPrimitive(this.hostProfile, "syncAccess", path);
    return new DenoSyncFile(path, Deno.openSync(this.#hostPath(path), { read: true, write: true }));
  }
}

/**
 * Creates a file driver backed by Deno file APIs.
 *
 * The driver remains Deno-native for filesystem work while sharing only the
 * portable `@std/path` host-root mapper with Node and Bun.
 *
 * @example Persist below one Deno host directory.
 * ```ts
 * const driver = createDenoDriver({ root: "./data" });
 * const adapter = createFileAdapter(driver);
 * const fs = createFileSystem(adapter, { coordination: "local" });
 * await fs.writeFile("/cache/result.json", "{}", { parents: true });
 * ```
 */
export function createDenoDriver(options: DenoDriverOptionsType): FileDriverType {
  const backend = new DenoBackend(options);
  return defineFileDriver(backend, {
    name: "deno",
    requirements: [{ code: "deno-filesystem", state: "available" }],
    limits: [],
    // Deno already exposes the required file semantics directly, so the driver
    // does not need additional behavior-changing optimization toggles here.
    optimizations: [],
  });
}
