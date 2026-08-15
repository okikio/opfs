import type { InspectionType } from "../capability.ts";
import type { FileSystemType } from "../filesystem.ts";
import type { MetricsType } from "../metrics.ts";
import { joinPath, normalizePath, ROOT_PATH } from "../path.ts";
import type { PlanInputType, PlanType } from "../plan.ts";

/** Metadata returned by the generic key-value driver. */
export interface KeyValueMetaType {
  /** Last modification time when the filesystem exposes one. */
  readonly modified?: Date;
}

/** Options for the reverse key-value view. */
export interface KeyValueDriverOptionsType {
  /** Virtual directory that contains key data. Defaults to `/`. */
  readonly root?: string;
  /** Closes the injected filesystem when the driver closes. */
  readonly disposeFileSystem?: boolean;
}

/**
 * Minimal asynchronous key-value behavior backed by a `FileSystemType`.
 *
 * This contract is deliberately smaller than unstorage. It is useful for
 * ecosystem drivers that need strings/raw bytes plus hierarchical key listing
 * without copying the collision-safe key mapping again.
 */
export interface KeyValueDriverType {
  /** Returns the exact effective filesystem capabilities, limits, partition policy, and metrics backing this driver. */
  inspect(): InspectionType;
  /** Preflights one underlying filesystem operation without touching storage. */
  plan(input: PlanInputType): PlanType;
  /** Returns current filesystem metrics without exposing mutable counters. */
  getMetrics(): MetricsType;
  /** Tests whether one exact key has a value. */
  has(key: string): Promise<boolean>;
  /** Reads one UTF-8 string value. */
  get(key: string): Promise<string | null>;
  /** Replaces one UTF-8 string value. */
  set(key: string, value: string): Promise<void>;
  /** Reads raw bytes. */
  getRaw(key: string): Promise<Uint8Array | null>;
  /** Replaces one raw value. */
  setRaw(key: string, value: string | Blob | ArrayBuffer | ArrayBufferView): Promise<void>;
  /** Removes one exact value. */
  remove(key: string): Promise<void>;
  /** Reads filesystem-backed metadata. */
  meta(key: string): Promise<KeyValueMetaType | null>;
  /** Lists keys below one colon-delimited hierarchy prefix. */
  keys(base?: string, options?: { readonly maxDepth?: number }): Promise<string[]>;
  /** Removes keys below a hierarchy prefix. */
  clear(base?: string, options?: { readonly preserveExact?: boolean }): Promise<void>;
  /** Releases explicitly transferred filesystem ownership. */
  dispose(): Promise<void>;
}

/** Prefix that makes driver-owned key directories distinguishable from ordinary files. */
const KEY_PREFIX = "key-";
/** Leaf filename used so both `foo` and `foo:bar` can exist without file/directory collisions. */
const VALUE_FILE = "value";

/** Encodes one logical key segment into one collision-free filesystem name. */
function encodeSegment(value: string): string {
  const encoded = encodeURIComponent(value).replace(/~/g, "%7E").replace(/%/g, "~");
  return `${KEY_PREFIX}${encoded}`;
}

/** Reverses one driver-owned directory name. */
function decodeSegment(value: string): string | null {
  if (!value.startsWith(KEY_PREFIX)) return null;
  return decodeURIComponent(value.slice(KEY_PREFIX.length).replace(/~/g, "%"));
}

/** Splits the conventional colon hierarchy used by many JavaScript KV APIs. */
function parts(key: string): string[] {
  return key.split(":").filter((part) => part.length > 0).map(encodeSegment);
}

/** Directory that can contain both the exact value and descendant keys. */
function directory(root: string, key: string): string {
  return joinPath(root, ...parts(key));
}

/** Private leaf file storing one exact key value. */
function path(root: string, key: string): string {
  return joinPath(directory(root, key), VALUE_FILE);
}

/** Converts one driver-owned value file back to the logical key. */
function key(root: string, value: string): string | null {
  const relative = normalizePath(value).slice(root === ROOT_PATH ? 1 : root.length + 1);
  if (relative.length === 0) return null;
  const pathParts = relative.split("/");
  if (pathParts.pop() !== VALUE_FILE) return null;
  const decoded: string[] = [];
  for (const pathPart of pathParts) {
    const item = decodeSegment(pathPart);
    if (item === null) return null;
    decoded.push(item);
  }
  return decoded.join(":");
}

/** Counts logical hierarchy separators for depth filtering. */
function depth(value: string): number {
  let count = 0;
  for (const character of value) if (character === ":") count += 1;
  return count;
}

/**
 * Collision-safe key-value projection over one filesystem.
 *
 * Each key gets a private directory with a `value` leaf. The extra level solves
 * a filesystem mismatch that ordinary `key.replace(":", "/")` mappings miss:
 * key-value stores can contain both `foo` and `foo:bar`, while a filesystem
 * cannot make `/foo` a file and a directory at the same time.
 *
 * ```text
 * foo       -> /key-foo/value
 * foo:bar   -> /key-foo/key-bar/value
 * ```
 *
 * The class borrows the filesystem unless `disposeFileSystem` explicitly
 * transfers ownership. It never configures storage, logging, or global state.
 */
class KeyValueDriver implements KeyValueDriverType {
  /** Filesystem that stores the encoded hierarchy and value leaves. */
  readonly #fileSystem: FileSystemType;
  /** Canonical directory below which all key data is stored. */
  readonly #root: string;
  /** Whether driver disposal also closes the injected filesystem. */
  readonly #disposeFileSystem: boolean;

  /** Resolves stable driver policy once instead of closing over factory locals. */
  constructor(fileSystem: FileSystemType, options: KeyValueDriverOptionsType) {
    this.#fileSystem = fileSystem;
    this.#root = normalizePath(options.root ?? ROOT_PATH);
    this.#disposeFileSystem = options.disposeFileSystem ?? false;
  }

  /** Returns the effective capability and limit report of the backing filesystem. */
  inspect(): InspectionType {
    return this.#fileSystem.inspect();
  }

  /** Uses the filesystem planner so reverse ecosystem callers see the same route and size checks. */
  plan(input: PlanInputType): PlanType {
    return this.#fileSystem.plan(input);
  }

  /** Returns the filesystem's detached metrics snapshot. */
  getMetrics(): MetricsType {
    return this.#fileSystem.getMetrics();
  }

  /** Tests whether one encoded value leaf exists as a file. */
  async has(value: string): Promise<boolean> {
    return await this.#fileSystem.exists(path(this.#root, value), { kind: "file" });
  }

  /** Reads one UTF-8 value without treating a missing key as a filesystem failure. */
  async get(value: string): Promise<string | null> {
    const file = path(this.#root, value);
    return await this.#fileSystem.exists(file, { kind: "file" }) ? await this.#fileSystem.readText(file) : null;
  }

  /** Replaces one UTF-8 value and creates hierarchy directories when needed. */
  async set(value: string, data: string): Promise<void> {
    await this.#fileSystem.writeFile(path(this.#root, value), data, { parents: true, mode: "replace" });
  }

  /** Reads one raw byte value without text transcoding. */
  async getRaw(value: string): Promise<Uint8Array | null> {
    const file = path(this.#root, value);
    return await this.#fileSystem.exists(file, { kind: "file" }) ? await this.#fileSystem.readFile(file) : null;
  }

  /** Replaces one raw value using the filesystem's normal write-data contract. */
  async setRaw(value: string, data: string | Blob | ArrayBuffer | ArrayBufferView): Promise<void> {
    await this.#fileSystem.writeFile(path(this.#root, value), data, { parents: true, mode: "replace" });
  }

  /** Removes only the exact value leaf and leaves descendant keys intact. */
  async remove(value: string): Promise<void> {
    const file = path(this.#root, value);
    if (await this.#fileSystem.exists(file, { kind: "file" })) await this.#fileSystem.remove(file);
  }

  /** Projects filesystem modification time into the small KV metadata contract. */
  async meta(value: string): Promise<KeyValueMetaType | null> {
    const file = path(this.#root, value);
    if (!(await this.#fileSystem.exists(file, { kind: "file" }))) return null;
    const valueStat = await this.#fileSystem.stat(file);
    return valueStat.kind === "file" ? { modified: new Date(valueStat.lastModified) } : null;
  }

  /**
   * Lists logical keys below one encoded hierarchy directory.
   *
   * Traversal remains lazy in the filesystem layer. This method materializes
   * only the final key strings because the ecosystem KV contract returns an
   * array rather than an iterator.
   */
  async keys(base = "", options: { readonly maxDepth?: number } = {}): Promise<string[]> {
    const baseDirectory = directory(this.#root, base);
    if (!(await this.#fileSystem.exists(baseDirectory, { kind: "directory" }))) return [];

    const output: string[] = [];
    for await (const entry of this.#fileSystem.walk(baseDirectory, { includeFiles: true, includeDirectories: false })) {
      const value = key(this.#root, entry.path);
      if (value === null) continue;
      if (options.maxDepth !== undefined && depth(value) > options.maxDepth) continue;
      output.push(value);
    }
    return output;
  }

  /**
   * Removes values below one hierarchy prefix while optionally retaining the
   * exact base key.
   *
   * `preserveExact` is needed by unstorage because `foo:` means descendants of
   * `foo`, not the exact `foo` value itself.
   */
  async clear(base = "", options: { readonly preserveExact?: boolean } = {}): Promise<void> {
    const baseDirectory = directory(this.#root, base);
    if (!(await this.#fileSystem.exists(baseDirectory, { kind: "directory" }))) return;
    if (!options.preserveExact) {
      await this.#fileSystem.emptyDir(baseDirectory);
      return;
    }

    for await (const entry of this.#fileSystem.readDir(baseDirectory)) {
      if (entry.kind === "directory") await this.#fileSystem.remove(entry.path, { recursive: true });
    }
  }

  /** Closes the injected filesystem only when ownership was explicitly transferred. */
  async dispose(): Promise<void> {
    if (this.#disposeFileSystem) await this.#fileSystem.close();
  }
}

/**
 * Exposes any OPFS filesystem as a collision-safe key-value store.
 *
 * The factory constructs a named driver object instead of defining behavior
 * methods inside the factory. This keeps the public call site small while the
 * lifecycle and mapping rules remain individually documented and testable.
 */
export function createKeyValueDriver(fileSystem: FileSystemType, options: KeyValueDriverOptionsType = {}): KeyValueDriverType {
  return new KeyValueDriver(fileSystem, options);
}
