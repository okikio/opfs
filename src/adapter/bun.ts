import type {
  AdapterCopyOptionsType,
  AdapterDirectoryEntryType,
  AdapterMoveOptionsType,
  AdapterReadOptionsType,
  AdapterSignalOptionsType,
  AdapterStatType,
  AdapterSyncFileType,
  AdapterType,
  AdapterWritableFileType,
  AdapterWriteOptionsType,
} from "./definition.ts";
import { defineAdapter } from "./definition.ts";
import { createLocalPath } from "./local.ts";
import { createNodeAdapter, type NodeAdapterOptionsType } from "./node.ts";
import { throwIfAborted } from "../error.ts";
import type { PathType } from "../path.ts";
import { withAbortSignal } from "../stream.ts";

/** Minimal Bun file object used without requiring global Bun types in core declarations. */
interface BunFileType extends Blob {}

/** Bun runtime methods required by the fast read and replace-write paths. */
interface BunRuntimeType {
  /** Opens a lazy `BunFile` for one host path. */
  file(path: string): BunFileType;
  /** Replaces one host file with bytes or a stream-compatible body. */
  write(path: string, data: Blob | Response | ArrayBufferView | ArrayBuffer | string): Promise<number>;
}

/** Options for exposing one host directory through Bun. */
export type BunAdapterOptionsType = NodeAdapterOptionsType;

/**
 * Resolves Bun only when the adapter is created.
 *
 * Keeping this lookup out of module evaluation lets Node and Deno inspect or
 * type-check the explicit Bun subpath without requiring the `Bun` global.
 */
function getBun(): BunRuntimeType {
  const runtime = Reflect.get(globalThis, "Bun") as BunRuntimeType | undefined;
  if (runtime === undefined || typeof runtime.file !== "function" || typeof runtime.write !== "function") {
    throw new TypeError("Bun adapter requires the Bun runtime.");
  }
  return runtime;
}

/**
 * Bun implementation of the portable filesystem adapter.
 *
 * Bun owns the lazy read and complete replacement paths. Operations that need
 * directory traversal, positioned writes, rename, or synchronous descriptors
 * delegate to Bun's Node-compatible filesystem layer through `NodeAdapter`.
 * The two paths share the same `@std/path` host-root mapper, so neither can
 * address a host path outside the configured root.
 */
class BunAdapter implements AdapterType {
  /** Stable adapter identity used in diagnostics. */
  readonly name = "bun";
  /** Native capabilities inherited from Bun's Node-compatible filesystem. */
  readonly capabilities;
  /** Bun runtime used by lazy reads and replacement writes. */
  readonly #bun: BunRuntimeType;
  /** Maps canonical virtual paths below the configured host root. */
  readonly #hostPath: (path: string) => string;
  /** Node-compatible adapter that owns operations Bun does not improve. */
  readonly #node: AdapterType;

  /** Resolves Bun and creates the shared Node-compatible host adapter. */
  constructor(options: BunAdapterOptionsType) {
    this.#bun = getBun();
    this.#hostPath = createLocalPath(options.root);
    this.#node = createNodeAdapter(options);
    this.capabilities = this.#node.capabilities;
  }

  /** Delegates metadata lookup to the Node-compatible filesystem surface. */
  stat(path: PathType, options: AdapterSignalOptionsType = {}): Promise<AdapterStatType | null> {
    return this.#node.stat(path, options);
  }

  /** Reads only the requested slice through Bun's lazy `BunFile` object. */
  async readFile(path: PathType, options: AdapterReadOptionsType = {}): Promise<Uint8Array> {
    throwIfAborted(options.signal, "read", path);
    const file = this.#bun.file(this.#hostPath(path));
    const start = options.at ?? 0;
    const end = options.length === undefined ? file.size : Math.min(file.size, start + options.length);
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  }

  /** Returns Bun's native Blob stream for the requested byte range. */
  async openReadStream(path: PathType, options: AdapterReadOptionsType = {}): Promise<ReadableStream<Uint8Array>> {
    throwIfAborted(options.signal, "read", path);
    const file = this.#bun.file(this.#hostPath(path));
    const start = options.at ?? 0;
    const end = options.length === undefined ? file.size : Math.min(file.size, start + options.length);
    return file.slice(start, end).stream() as ReadableStream<Uint8Array>;
  }

  /** Uses `Bun.write()` for replacement and delegates append/update semantics. */
  async writeFile(path: PathType, data: Uint8Array, options: AdapterWriteOptionsType): Promise<void> {
    if (options.mode !== "replace") {
      await this.#node.writeFile(path, data, options);
      return;
    }

    throwIfAborted(options.signal, "write", path);
    await this.#bun.write(this.#hostPath(path), data);
  }

  /** Streams replacement writes through `Bun.write()` without facade buffering. */
  async writeStream(path: PathType, source: ReadableStream<Uint8Array>, options: AdapterWriteOptionsType): Promise<void> {
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
  readDir(path: PathType, options: AdapterSignalOptionsType = {}): AsyncIterableIterator<AdapterDirectoryEntryType> {
    return this.#node.readDir(path, options);
  }

  /** Creates one host directory after facade parent resolution. */
  createDir(path: PathType, options: AdapterSignalOptionsType = {}): Promise<void> {
    return this.#node.createDir(path, options);
  }

  /** Removes one host file or empty directory. */
  remove(path: PathType, options: AdapterSignalOptionsType = {}): Promise<void> {
    return this.#node.remove(path, options);
  }

  /** Uses native host copy without routing bytes through JavaScript. */
  copy(source: PathType, destination: PathType, options: AdapterCopyOptionsType): Promise<void> {
    if (this.#node.copy === undefined) throw new TypeError("Bun host adapter does not expose native copy.");
    return this.#node.copy(source, destination, options);
  }

  /** Uses native host rename for move semantics. */
  move(source: PathType, destination: PathType, options: AdapterMoveOptionsType): Promise<void> {
    if (this.#node.move === undefined) throw new TypeError("Bun host adapter does not expose native move.");
    return this.#node.move(source, destination, options);
  }

  /** Opens one long-lived asynchronous positional host file. */
  openWritableFile(path: PathType): Promise<AdapterWritableFileType> {
    if (this.#node.openWritableFile === undefined) {
      throw new TypeError("Bun host adapter does not expose positional writes.");
    }
    return this.#node.openWritableFile(path);
  }

  /** Opens one synchronous random-access host file. */
  openSyncFile(path: PathType): Promise<AdapterSyncFileType> {
    if (this.#node.openSyncFile === undefined) {
      throw new TypeError("Bun host adapter does not expose synchronous access.");
    }
    return this.#node.openSyncFile(path);
  }

  /** Releases resources owned by the delegated host adapter, when any exist. */
  async dispose(): Promise<void> {
    await this.#node.dispose?.();
  }
}

/**
 * Creates an adapter optimized for Bun.
 *
 * The adapter uses `Bun.file()` for lazy reads and `Bun.write()` for complete
 * replacement writes. It uses Bun's Node-compatible filesystem APIs for
 * operations that need stronger file semantics. Importing this module does not
 * require Bun; adapter creation does.
 *
 * @example Persist below one Bun host directory.
 * ```ts
 * const fs = createFileSystem(createBunAdapter({ root: "./data" }));
 * await fs.writeFile("/result.bin", new Uint8Array([1, 2, 3]));
 * ```
 */
export function createBunAdapter(options: BunAdapterOptionsType): AdapterType {
  return defineAdapter(new BunAdapter(options));
}
