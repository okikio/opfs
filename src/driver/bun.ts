import type { FileBackendType, FileDriverType } from "./file.ts";
import { defineFileDriver } from "./file.ts";
import type {
  FileDriverCopyOptionsType,
  FileDriverDirectoryEntryType,
  FileDriverMoveOptionsType,
  FileDriverReadOptionsType,
  FileDriverSignalOptionsType,
  FileDriverStatType,
  FileDriverSyncFileType,
  FileDriverWritableFileType,
  FileDriverWriteOptionsType,
} from "./file.ts";
import { createLocalPath } from "./local.ts";
import { createNodeDriver, type NodeDriverOptionsType } from "./node.ts";
import { FileSystemError, throwIfAborted } from "../error.ts";
import type { PathType } from "../path.ts";
import { withAbortSignal } from "../stream.ts";

/** Minimal Bun file object used without requiring global Bun types in core declarations. */
export interface BunFileType extends Blob {}

/** Bun runtime methods required by the fast read and replace-write paths. */
export interface BunRuntimeType {
  /** Opens a lazy `BunFile` for one host path. */
  file(path: string): BunFileType;
  /** Replaces one host file with bytes or a stream-compatible body. */
  write(path: string, data: Blob | Response | ArrayBufferView | ArrayBuffer | string): Promise<number>;
}

/**
 * Options for exposing one host directory through Bun.
 *
 * Bun shares the same host-root contract as the Node and Deno file drivers so
 * the portable path model stays identical across host runtimes.
 */
export type BunDriverOptionsType = NodeDriverOptionsType;

/**
 * Resolves Bun only when the driver is created.
 *
 * Keeping this lookup out of module evaluation lets Node and Deno inspect or
 * type-check the explicit Bun subpath without requiring the `Bun` global.
 */
export function getBun(): BunRuntimeType {
  const runtime = Reflect.get(globalThis, "Bun") as BunRuntimeType | undefined;
  if (runtime === undefined || typeof runtime.file !== "function" || typeof runtime.write !== "function") {
    throw new TypeError("Bun driver requires the Bun runtime.");
  }
  return runtime;
}

/**
 * Bun implementation of the portable file-driver contract.
 *
 * Bun owns the lazy read and complete replacement paths. Operations that need
 * directory traversal, positioned writes, rename, or synchronous descriptors
 * delegate to Bun's Node-compatible filesystem layer through the Node driver.
 * Both paths share the same lexical host-root mapper. As with Node, a symbolic
 * link already present below that root can resolve outside it, so this mapping
 * is not a security isolation mechanism for untrusted host filesystem content.
 */
export class BunBackend implements FileBackendType {
  /** Stable driver identity used in diagnostics. */
  readonly name = "bun";
  /** Native capabilities inherited from Bun's Node-compatible filesystem. */
  readonly capabilities;
  /** Bun runtime used by lazy reads and replacement writes. */
  readonly #bun: BunRuntimeType;
  /** Maps canonical virtual paths below the configured host root. */
  readonly #hostPath: (path: string) => string;
  /** Node-compatible driver that owns operations Bun does not improve. */
  readonly #node: FileDriverType;

  /** Resolves Bun and creates the shared Node-compatible host driver. */
  constructor(options: BunDriverOptionsType) {
    this.#bun = getBun();
    this.#hostPath = createLocalPath(options.root);
    this.#node = createNodeDriver(options);
    this.capabilities = this.#node.capabilities;
  }

  /** Delegates metadata lookup to the Node-compatible filesystem surface. */
  stat(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<FileDriverStatType | null> {
    return this.#node.stat(path, options);
  }

  /** Reads only the requested slice through Bun's lazy `BunFile` object. */
  async readFile(path: PathType, options: FileDriverReadOptionsType = {}): Promise<Uint8Array> {
    throwIfAborted(options.signal, "read", path);
    if (options.length === 0) {
      const stat = await this.#node.stat(path, options);
      if (stat === null) throw new FileSystemError("not-found", "read", path, `File '${path}' does not exist.`);
      if (stat.kind === "directory") throw new FileSystemError("type-mismatch", "read", path, `'${path}' is a directory.`);
      return new Uint8Array();
    }
    const file = this.#bun.file(this.#hostPath(path));
    const start = options.at ?? 0;
    const end = options.length === undefined ? file.size : Math.min(file.size, start + options.length);
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  }

  /** Returns Bun's native Blob stream for the requested byte range. */
  async openReadStream(path: PathType, options: FileDriverReadOptionsType = {}): Promise<ReadableStream<Uint8Array>> {
    throwIfAborted(options.signal, "read", path);
    if (options.length === 0) {
      const stat = await this.#node.stat(path, options);
      if (stat === null) throw new FileSystemError("not-found", "read", path, `File '${path}' does not exist.`);
      if (stat.kind === "directory") throw new FileSystemError("type-mismatch", "read", path, `'${path}' is a directory.`);
      return new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    }
    const file = this.#bun.file(this.#hostPath(path));
    const start = options.at ?? 0;
    const end = options.length === undefined ? file.size : Math.min(file.size, start + options.length);
    return file.slice(start, end).stream() as ReadableStream<Uint8Array>;
  }

  /** Uses `Bun.write()` for replacement and delegates append/update semantics. */
  async writeFile(path: PathType, data: Uint8Array, options: FileDriverWriteOptionsType): Promise<void> {
    if (options.mode !== "replace") {
      await this.#node.writeFile(path, data, options);
      return;
    }

    throwIfAborted(options.signal, "write", path);
    await this.#bun.write(this.#hostPath(path), data);
  }

  /** Streams replacement writes through `Bun.write()` without facade buffering. */
  async writeStream(
    path: PathType,
    source: ReadableStream<Uint8Array>,
    options: FileDriverWriteOptionsType,
  ): Promise<void> {
    if (options.mode !== "replace") {
      if (this.#node.writeStream === undefined) {
        throw new TypeError("Bun Node compatibility layer does not expose streaming writes.");
      }
      await this.#node.writeStream(path, source, options);
      return;
    }

    throwIfAborted(options.signal, "write", path);
    const body = withAbortSignal(source, options.signal, path, "write");
    await this.#bun.write(this.#hostPath(path), new Response(body));
  }

  /** Delegates direct-child iteration to Bun's Node-compatible filesystem surface. */
  readDir(
    path: PathType,
    options: FileDriverSignalOptionsType = {},
  ): AsyncIterableIterator<FileDriverDirectoryEntryType> {
    return this.#node.readDir(path, options);
  }

  /** Creates one host directory after facade parent resolution. */
  createDir(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<void> {
    return this.#node.createDir(path, options);
  }

  /** Removes one host file or empty directory. */
  remove(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<void> {
    return this.#node.remove(path, options);
  }

  /** Uses native host copy without routing bytes through JavaScript. */
  copy(source: PathType, destination: PathType, options: FileDriverCopyOptionsType): Promise<void> {
    if (this.#node.copy === undefined) throw new TypeError("Bun host driver does not expose native copy.");
    return this.#node.copy(source, destination, options);
  }

  /** Uses native host rename for move semantics. */
  move(source: PathType, destination: PathType, options: FileDriverMoveOptionsType): Promise<void> {
    if (this.#node.move === undefined) throw new TypeError("Bun host driver does not expose native move.");
    return this.#node.move(source, destination, options);
  }

  /** Opens one long-lived asynchronous positional host file. */
  openWritableFile(path: PathType): Promise<FileDriverWritableFileType> {
    if (this.#node.openWritableFile === undefined) {
      throw new TypeError("Bun host driver does not expose positional writes.");
    }
    return this.#node.openWritableFile(path);
  }

  /** Opens one synchronous random-access host file. */
  openSyncFile(path: PathType): Promise<FileDriverSyncFileType> {
    if (this.#node.openSyncFile === undefined) {
      throw new TypeError("Bun host driver does not expose synchronous access.");
    }
    return this.#node.openSyncFile(path);
  }

  /** Releases resources owned by the delegated host driver, when any exist. */
  async dispose(): Promise<void> {
    await this.#node.dispose?.();
  }
}

/**
 * Creates a file driver optimized for Bun.
 *
 * The driver uses `Bun.file()` for lazy reads and `Bun.write()` for complete
 * replacement writes. It uses Bun's Node-compatible filesystem APIs for
 * operations that need stronger file semantics. Importing this module does not
 * require Bun; driver creation does.
 *
 * @example Persist below one Bun host directory.
 * ```ts
 * const driver = createBunDriver({ root: "./data" });
 * const adapter = createFileAdapter(driver);
 * const fs = createFileSystem(adapter);
 * await fs.writeFile("/result.bin", new Uint8Array([1, 2, 3]));
 * ```
 */
export function createBunDriver(options: BunDriverOptionsType): FileDriverType {
  return defineFileDriver(new BunBackend(options), {
    name: "bun",
    ownership: "none",
    requirements: [{ code: "bun-runtime", state: "available" }],
    limits: [],
    // These toggles document the fast paths Bun contributes beyond the shared
    // Node-compatible host filesystem fallback used for the rest of the file API.
    optimizations: [
      { code: "bun-file-read", enabled: true, changesBehavior: false, disableable: true },
      { code: "bun-write-replace", enabled: true, changesBehavior: false, disableable: true },
    ],
  });
}
