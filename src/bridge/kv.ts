import { FileSystemError } from "../error.ts";
import type { InspectionType } from "../capability.ts";
import type { FileSystemType } from "../filesystem.ts";
import type { MetricsType } from "../metrics.ts";
import { joinPath, normalizePath, ROOT_PATH } from "../path.ts";
import type { PlanInputType, PlanType } from "../plan.ts";

/** Metadata returned by the generic key-value bridge. */
export interface KeyValueMetaType {
  /** Last modification time when the filesystem exposes one. */
  readonly modified?: Date;
}

/** Filesystem inspection plus the bridge-owned exact-key namespace. */
export interface KeyValueInspectionType extends InspectionType {
  readonly namespace: { readonly root: string; readonly layout: "opfs-kv-v2"; readonly keys: "exact" };
}

/** Options for the reverse key-value bridge. */
export interface KeyValueBridgeOptionsType {
  /** Exclusive format directory containing bridge data. Defaults to `/.opfs-kv`; `/` is rejected. */
  readonly root?: string;
  /** Closes the injected filesystem when the bridge closes. */
  readonly disposeFileSystem?: boolean;
}

/**
 * Minimal asynchronous key-value behavior backed by a `FileSystemType`.
 *
 * This contract is deliberately smaller than unstorage. It is useful for
 * ecosystem drivers that need strings/raw bytes plus hierarchical key listing
 * without copying the collision-safe key mapping again.
 */
export interface KeyValueBridgeType {
  /** Returns the exact effective filesystem capabilities, limits, partition policy, and metrics backing this bridge. */
  inspect(): KeyValueInspectionType;
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

/** Prefix that makes bridge-owned key directories distinguishable from ordinary files. */
const KEY_PREFIX = "key-";
/** Leaf filename used so both `foo` and `foo:bar` can exist without file/directory collisions. */
const VALUE_FILE = "value";

/** Encodes one logical key segment into one collision-free filesystem name. */
function encodeSegment(value: string): string {
  const encode = (part: string) => encodeURIComponent(part).replace(/~/g, "%7E").replace(/%/g, "~");
  let encoded = "";
  let start = 0;
  for (let at = 0; at < value.length; at++) {
    const unit = value.charCodeAt(at);
    if (unit >= 0xd800 && unit <= 0xdbff && value.charCodeAt(at + 1) >= 0xdc00 && value.charCodeAt(at + 1) <= 0xdfff) {
      at++;
      continue;
    }
    if (unit >= 0xd800 && unit <= 0xdfff) {
      encoded += encode(value.slice(start, at)) + `~u${unit.toString(16).toUpperCase().padStart(4, "0")}`;
      start = at + 1;
    }
  }
  return `${KEY_PREFIX}${encoded}${encode(value.slice(start))}`;
}

/** Decodes URI runs and disjoint lone-code-unit tokens, then rejects noncanonical aliases. */
function decodeSegment(value: string): string | null {
  if (!value.startsWith(KEY_PREFIX)) return null;
  try {
    const encoded = value.slice(KEY_PREFIX.length);
    let decoded = "";
    let start = 0;
    for (const match of encoded.matchAll(/~u([0-9A-F]{4})/g)) {
      decoded += decodeURIComponent(encoded.slice(start, match.index).replace(/~/g, "%"));
      decoded += String.fromCharCode(Number.parseInt(match[1]!, 16));
      start = match.index! + match[0].length;
    }
    decoded += decodeURIComponent(encoded.slice(start).replace(/~/g, "%"));
    return encodeSegment(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

/** Splits the conventional colon hierarchy used by many JavaScript KV APIs. */
function parts(key: string): string[] {
  return key.split(":").map(encodeSegment);
}

/** Directory that can contain both the exact value and descendant keys. */
function directory(root: string, key: string): string {
  return joinPath(root, ...parts(key));
}

/** Private leaf file storing one exact key value. */
function path(root: string, key: string): string {
  return joinPath(directory(root, key), VALUE_FILE);
}

/** Converts one bridge-owned value file back to the logical key. */
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

/** Returns whether one normalized filesystem failure means the requested entry is absent. */
function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "not-found";
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
export class KeyValueBridgeImpl implements KeyValueBridgeType {
  /** Filesystem that stores the encoded hierarchy and value leaves. */
  readonly #fileSystem: FileSystemType;
  /** Canonical directory below which all key data is stored. */
  readonly #root: string;
  /** Whether bridge disposal also closes the injected filesystem. */
  readonly #disposeFileSystem: boolean;
  #ready: Promise<void> | undefined;

  /** Resolves stable driver policy once instead of closing over factory locals. */
  constructor(fileSystem: FileSystemType, options: KeyValueBridgeOptionsType) {
    this.#fileSystem = fileSystem;
    this.#root = normalizePath(options.root ?? "/.opfs-kv");
    if (this.#root === ROOT_PATH) {
      throw new TypeError(
        "A KV bridge needs a dedicated directory; omit root for /.opfs-kv or choose an exclusive subdirectory.",
      );
    }
    this.#disposeFileSystem = options.disposeFileSystem ?? false;
  }

  /** Returns the effective capability and limit report of the backing filesystem. */
  inspect(): KeyValueInspectionType {
    return { ...this.#fileSystem.inspect(), namespace: { root: this.#root, layout: "opfs-kv-v2", keys: "exact" } };
  }

  /** Uses the filesystem planner so reverse ecosystem callers see the same route and size checks. */
  plan(input: PlanInputType): PlanType {
    return this.#fileSystem.plan(input);
  }

  /** Returns the filesystem's detached metrics snapshot. */
  getMetrics(): MetricsType {
    return this.#fileSystem.getMetrics();
  }

  /** Claims an empty dedicated area, or verifies its format before any mutation. */
  #open(): Promise<void> {
    if (this.#ready !== undefined) return this.#ready;
    this.#ready = this.#verify().catch((error) => {
      this.#ready = undefined;
      throw error;
    });
    return this.#ready;
  }

  async #verify(): Promise<void> {
    const marker = joinPath(this.#root, ".format");
    try {
      if (await this.#fileSystem.readText(marker) !== "opfs-kv-v2\n") {
        throw new TypeError(`KV namespace '${this.#root}' has a different format; migrate it explicitly.`);
      }
      return;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await this.#fileSystem.ensureDir(this.#root);
    for await (const entry of this.#fileSystem.readDir(this.#root)) {
      throw new TypeError(
        `KV namespace '${this.#root}' is not empty and has no format marker (${entry.name}); choose a dedicated area or migrate it explicitly.`,
      );
    }
    // This is a cooperating-owner claim, not an atomic reservation against outside writers.
    await this.#fileSystem.writeFile(marker, "opfs-kv-v2\n");
  }

  /** Reads ownership without creating it; foreign or legacy areas require explicit migration. */
  async #existing(): Promise<boolean> {
    try {
      const format = await this.#fileSystem.readText(joinPath(this.#root, ".format"));
      if (format !== "opfs-kv-v2\n") throw new TypeError(`KV namespace '${this.#root}' has an incompatible format.`);
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }

  /** Tests whether one encoded value leaf exists as a file. */
  async has(value: string): Promise<boolean> {
    if (!await this.#existing()) return false;
    return await this.#fileSystem.exists(path(this.#root, value), { kind: "file" });
  }

  /** Reads one UTF-8 value without a check-then-read race. */
  async get(value: string): Promise<string | null> {
    if (!await this.#existing()) return null;
    const file = path(this.#root, value);
    try {
      return await this.#fileSystem.readText(file);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  /** Rejects a declared read-only host before namespace format reads or clear membership listing. */
  #assertWritable(): void {
    const inspection = this.#fileSystem.inspect();
    if (!inspection.adapter.native.write) {
      throw new FileSystemError(
        "not-supported",
        "write",
        this.#root,
        "The backing filesystem is configured read-only.",
      );
    }
    const profile = inspection.adapter.hostProfile;
    if (profile?.readOnly) {
      throw new FileSystemError("not-supported", "write", this.#root, `Host profile '${profile.name}' is read-only.`);
    }
  }

  /** Replaces one UTF-8 value and creates hierarchy directories when needed. */
  async set(value: string, data: string): Promise<void> {
    this.#assertWritable();
    path(this.#root, value);
    await this.#open();
    await this.#fileSystem.writeFile(path(this.#root, value), data, { parents: true, mode: "replace" });
  }

  /** Reads one raw byte value without a check-then-read race. */
  async getRaw(value: string): Promise<Uint8Array | null> {
    if (!await this.#existing()) return null;
    const file = path(this.#root, value);
    try {
      return await this.#fileSystem.readFile(file);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  /** Replaces one raw value using the filesystem's normal write-data contract. */
  async setRaw(value: string, data: string | Blob | ArrayBuffer | ArrayBufferView): Promise<void> {
    this.#assertWritable();
    path(this.#root, value);
    await this.#open();
    await this.#fileSystem.writeFile(path(this.#root, value), data, { parents: true, mode: "replace" });
  }

  /** Removes only the exact value leaf and treats a concurrent/missing delete as complete. */
  async remove(value: string): Promise<void> {
    this.#assertWritable();
    if (!await this.#existing()) return;
    try {
      await this.#fileSystem.remove(path(this.#root, value));
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }

  /** Projects filesystem modification time without an advisory existence precondition. */
  async meta(value: string): Promise<KeyValueMetaType | null> {
    if (!await this.#existing()) return null;
    const file = path(this.#root, value);
    try {
      const valueStat = await this.#fileSystem.stat(file);
      return valueStat.kind === "file" ? { modified: new Date(valueStat.lastModified) } : null;
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  /**
   * Lists logical keys below one encoded hierarchy directory.
   *
   * Traversal remains lazy in the filesystem layer. This method materializes
   * only the final key strings because the ecosystem KV contract returns an
   * array rather than an iterator.
   */
  async keys(base?: string, options: { readonly maxDepth?: number } = {}): Promise<string[]> {
    if (!await this.#existing()) return [];
    const baseDirectory = base === undefined ? this.#root : directory(this.#root, base);
    const output: string[] = [];
    try {
      for await (
        const entry of this.#fileSystem.walk(baseDirectory, {
          includeFiles: true,
          includeDirectories: false,
        })
      ) {
        const value = key(this.#root, entry.path);
        if (value === null) continue;
        if (options.maxDepth !== undefined && depth(value) > options.maxDepth) continue;
        output.push(value);
      }
    } catch (error) {
      // Listing is not a snapshot. If another owner removes the subtree while
      // it is being enumerated, return the values observed before disappearance
      // instead of turning an advisory race into a filesystem exception.
      if (!missing(error)) throw error;
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
  async clear(base?: string, options: { readonly preserveExact?: boolean } = {}): Promise<void> {
    this.#assertWritable();
    // Snapshot logical membership and remove only validated owned leaves. Foreign
    // files and malformed codec-looking directories are never recursive cleanup.
    const values = await this.keys(base);
    for (const value of values) {
      if (options.preserveExact && value === base) continue;
      await this.remove(value);
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
export function createKeyValueBridge(
  fileSystem: FileSystemType,
  options: KeyValueBridgeOptionsType = {},
): KeyValueBridgeType {
  return new KeyValueBridgeImpl(fileSystem, options);
}
