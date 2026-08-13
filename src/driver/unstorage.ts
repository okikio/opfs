import type { FileSystemType } from "../filesystem.ts";
import { joinPath, normalizePath, ROOT_PATH } from "../path.ts";

/** Metadata shape understood by unstorage drivers. */
export interface UnstorageDriverMetaType {
  /** Last access time when known. */
  readonly atime?: Date;
  /** Last modification time when known. */
  readonly mtime?: Date;
  /** Additional provider-specific metadata. */
  readonly [key: string]: string | number | boolean | object | Date | null | undefined;
}

/** Options accepted by unstorage driver methods. */
export interface UnstorageDriverTransactionOptionsType {
  /** Optional traversal depth used by getKeys. */
  readonly maxDepth?: number;
  /** Additional unstorage/provider transaction options. */
  readonly [key: string]: unknown;
}

/**
 * Driver contract compatible with unstorage's `Driver` interface.
 *
 * unstorage serializes normal values before calling `setItem()`, so this driver
 * stores those serialized strings directly as files. Raw methods preserve bytes
 * when callers opt into unstorage's experimental raw API.
 */
export interface UnstorageDriverType {
  /** Driver identifier reported through unstorage diagnostics. */
  readonly name: string;
  /** Declares that this driver applies unstorage `maxDepth` itself. */
  readonly flags: { readonly maxDepth: true };
  /** Reports whether one normalized unstorage key has a stored value file. */
  hasItem(key: string, options: UnstorageDriverTransactionOptionsType): Promise<boolean>;
  /** Returns one serialized unstorage value, or null when the key is absent. */
  getItem(key: string, options?: UnstorageDriverTransactionOptionsType): Promise<string | null>;
  /** Replaces one serialized unstorage value. */
  setItem(key: string, value: string, options: UnstorageDriverTransactionOptionsType): Promise<void>;
  /** Returns one raw byte value without unstorage serialization. */
  getItemRaw(key: string, options: UnstorageDriverTransactionOptionsType): Promise<Uint8Array | null>;
  /** Replaces one raw value without normal unstorage serialization. */
  setItemRaw(
    key: string,
    value: string | Blob | ArrayBuffer | ArrayBufferView,
    options: UnstorageDriverTransactionOptionsType,
  ): Promise<void>;
  /** Removes one value file and treats an absent key as already removed. */
  removeItem(key: string, options: UnstorageDriverTransactionOptionsType): Promise<void>;
  /** Returns filesystem-backed metadata for one value when present. */
  getMeta(key: string, options: UnstorageDriverTransactionOptionsType): Promise<UnstorageDriverMetaType | null>;
  /** Returns keys under the requested prefix while applying optional depth filtering. */
  getKeys(base: string, options: UnstorageDriverTransactionOptionsType): Promise<string[]>;
  /** Removes keys under one unstorage prefix while preserving an exact prefix value when required. */
  clear(base: string, options: UnstorageDriverTransactionOptionsType): Promise<void>;
  /** Releases the filesystem only when ownership was explicitly transferred. */
  dispose(): Promise<void>;
}

/** Options for the reverse unstorage driver. */
export interface UnstorageDriverOptionsType {
  /** Virtual directory that contains unstorage keys. Defaults to `/`. */
  readonly root?: string;
  /** Closes the injected filesystem when unstorage disposes the driver. */
  readonly disposeFileSystem?: boolean;
}

/** Prefix that distinguishes user key-segment directories from the private value file. */
const KEY_DIRECTORY_PREFIX = "key-";

/** Private file stored inside each encoded key directory. */
const KEY_VALUE_FILE_NAME = "value";

/** Encodes one unstorage key segment as one collision-free virtual directory name. */
function encodeKeySegment(value: string): string {
  const encoded = encodeURIComponent(value).replace(/~/g, "%7E").replace(/%/g, "~");
  return `${KEY_DIRECTORY_PREFIX}${encoded}`;
}

/** Reverses one adapter-owned virtual directory name into its original key segment. */
function decodeKeySegment(value: string): string | null {
  if (!value.startsWith(KEY_DIRECTORY_PREFIX)) return null;
  return decodeURIComponent(value.slice(KEY_DIRECTORY_PREFIX.length).replace(/~/g, "%"));
}

/** Splits the unstorage `:` hierarchy and protects filesystem separator characters. */
function keyParts(key: string): string[] {
  return key.split(":").filter((part) => part.length > 0).map(encodeKeySegment);
}

/** Maps an unstorage key prefix to the directory that contains its value and descendants. */
function keyDirectory(root: string, key: string): string {
  return joinPath(root, ...keyParts(key));
}

/** Maps an unstorage key to its dedicated private value file. */
function keyPath(root: string, key: string): string {
  return joinPath(keyDirectory(root, key), KEY_VALUE_FILE_NAME);
}

/** Maps one adapter-owned value file back to the original unstorage key hierarchy. */
function pathKey(root: string, path: string): string | null {
  const relative = normalizePath(path).slice(root === ROOT_PATH ? 1 : root.length + 1);
  if (relative.length === 0) return null;
  const parts = relative.split("/");
  if (parts.pop() !== KEY_VALUE_FILE_NAME) return null;

  const decoded: string[] = [];
  for (const part of parts) {
    const value = decodeKeySegment(part);
    if (value === null) return null;
    decoded.push(value);
  }
  return decoded.join(":");
}

/** Counts unstorage hierarchy separators for maxDepth filtering. */
function getKeyDepth(key: string): number {
  let depth = 0;
  for (const character of key) if (character === ":") depth += 1;
  return depth;
}

/**
 * Creates an unstorage driver backed by this package's filesystem facade.
 *
 * This is the reverse direction of `createUnstorageAdapter()`: an application
 * can mount a Deno/Bun/Node/OPFS/RxDB/db0/Drizzle-backed filesystem inside
 * unstorage and continue using unstorage's normal key API. The injected
 * filesystem remains caller-owned unless `disposeFileSystem` is true.
 *
 * @example
 * ```ts
 * const storage = createStorage({ driver: createUnstorageDriver(fileSystem) });
 * await storage.setItem("cache:result", { ready: true });
 * ```
 */
export function createUnstorageDriver(
  fileSystem: FileSystemType,
  options: UnstorageDriverOptionsType = {},
): UnstorageDriverType {
  const root = normalizePath(options.root ?? ROOT_PATH);
  return {
    name: "@okikio/opfs",
    flags: { maxDepth: true },
    async hasItem(key) {
      return await fileSystem.exists(keyPath(root, key), { kind: "file" });
    },
    async getItem(key) {
      const path = keyPath(root, key);
      return await fileSystem.exists(path, { kind: "file" }) ? await fileSystem.readText(path) : null;
    },
    async setItem(key, value) {
      await fileSystem.writeFile(keyPath(root, key), value, { parents: true, mode: "replace" });
    },
    async getItemRaw(key) {
      const path = keyPath(root, key);
      return await fileSystem.exists(path, { kind: "file" }) ? await fileSystem.readFile(path) : null;
    },
    async setItemRaw(key, value) {
      await fileSystem.writeFile(keyPath(root, key), value, { parents: true, mode: "replace" });
    },
    async removeItem(key) {
      const path = keyPath(root, key);
      if (await fileSystem.exists(path, { kind: "file" })) await fileSystem.remove(path);
    },
    async getMeta(key) {
      const path = keyPath(root, key);
      if (!(await fileSystem.exists(path, { kind: "file" }))) return null;
      const stat = await fileSystem.stat(path);
      return stat.kind === "file" ? { mtime: new Date(stat.lastModified) } : null;
    },
    async getKeys(base, transactionOptions) {
      const directory = keyDirectory(root, base);
      if (!(await fileSystem.exists(directory, { kind: "directory" }))) return [];
      const maxDepth = transactionOptions.maxDepth;
      const exactBase = base.replace(/:+$/g, "");
      const excludesExactBase = base.endsWith(":") && exactBase.length > 0;
      const output: string[] = [];
      for await (const entry of fileSystem.walk(directory, {
        includeFiles: true,
        includeDirectories: false,
      })) {
        const key = pathKey(root, entry.path);
        if (key === null || (excludesExactBase && key === exactBase)) continue;
        if (maxDepth !== undefined && getKeyDepth(key) > maxDepth) continue;
        output.push(key);
      }
      return output;
    },
    async clear(base) {
      const directory = keyDirectory(root, base);
      if (!(await fileSystem.exists(directory, { kind: "directory" }))) return;
      const preserveExactValue = base.endsWith(":") && keyParts(base).length > 0;
      if (!preserveExactValue) {
        await fileSystem.emptyDir(directory);
        return;
      }
      for await (const entry of fileSystem.readDir(directory)) {
        if (entry.kind === "directory") await fileSystem.remove(entry.path, { recursive: true });
      }
    },
    async dispose() {
      if (options.disposeFileSystem) await fileSystem.close();
    },
  };
}
