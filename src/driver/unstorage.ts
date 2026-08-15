import type { InspectionType } from "../capability.ts";
import type { FileSystemType } from "../filesystem.ts";
import type { MetricsType } from "../metrics.ts";
import type { PlanInputType, PlanType } from "../plan.ts";
import { createKeyValueDriver } from "./kv.ts";

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

/** Driver contract compatible with unstorage's stable Driver surface used here. */
export interface UnstorageDriverType {
  /** Returns the exact filesystem capabilities, limits, and partition policy behind this driver. */
  inspect(): InspectionType;
  /** Preflights one underlying filesystem operation without touching storage. */
  plan(input: PlanInputType): PlanType;
  /** Returns current filesystem metrics without exposing mutable counters. */
  getMetrics(): MetricsType;
  /** Stable driver identity reported to unstorage. */
  readonly name: string;
  /** Declares native interpretation of unstorage's `maxDepth` listing option. */
  readonly flags: { readonly maxDepth: true };
  /** Tests whether one exact unstorage key has a value. */
  hasItem(key: string, options: UnstorageDriverTransactionOptionsType): Promise<boolean>;
  /** Reads one value as UTF-8 text. */
  getItem(key: string, options?: UnstorageDriverTransactionOptionsType): Promise<string | null>;
  /** Replaces one value from UTF-8 text. */
  setItem(key: string, value: string, options: UnstorageDriverTransactionOptionsType): Promise<void>;
  /** Reads one value without text decoding. */
  getItemRaw(key: string, options: UnstorageDriverTransactionOptionsType): Promise<Uint8Array | null>;
  /** Replaces one value from raw byte-compatible input. */
  setItemRaw(key: string, value: string | Blob | ArrayBuffer | ArrayBufferView, options: UnstorageDriverTransactionOptionsType): Promise<void>;
  /** Removes one exact value while preserving descendants. */
  removeItem(key: string, options: UnstorageDriverTransactionOptionsType): Promise<void>;
  /** Returns filesystem-backed metadata for one exact value. */
  getMeta(key: string, options: UnstorageDriverTransactionOptionsType): Promise<UnstorageDriverMetaType | null>;
  /** Lists colon-delimited descendant keys below one base prefix. */
  getKeys(base: string, options: UnstorageDriverTransactionOptionsType): Promise<string[]>;
  /** Removes descendants below one base prefix according to unstorage clear semantics. */
  clear(base: string, options: UnstorageDriverTransactionOptionsType): Promise<void>;
  /** Releases filesystem ownership only when creation explicitly transferred it. */
  dispose(): Promise<void>;
}

/** Options for the reverse unstorage driver. */
export interface UnstorageDriverOptionsType {
  /** Virtual directory that contains unstorage keys. Defaults to `/`. */
  readonly root?: string;
  /** Closes the injected filesystem when unstorage disposes the driver. */
  readonly disposeFileSystem?: boolean;
}

/**
 * unstorage-compatible view over the generic filesystem key-value driver.
 *
 * The class owns only unstorage naming and `maxDepth` translation. Key
 * encoding, prefix collisions, filesystem ownership, and value persistence
 * remain in {@link KeyValueDriverType}.
 */
class UnstorageDriver implements UnstorageDriverType {
  /** Stable driver name reported to unstorage. */
  readonly name = "@okikio/opfs";
  /** Declares that this driver interprets unstorage's `maxDepth` option. */
  readonly flags = { maxDepth: true } as const;
  /** Generic KV projection that owns filesystem mapping and optional disposal. */
  readonly #driver: ReturnType<typeof createKeyValueDriver>;

  /** Creates one unstorage projection over the already-configured filesystem. */
  constructor(fileSystem: FileSystemType, options: UnstorageDriverOptionsType) {
    this.#driver = createKeyValueDriver(fileSystem, options);
  }

  /** Returns the effective capability and limit report of the backing filesystem. */
  inspect(): InspectionType {
    return this.#driver.inspect();
  }

  /** Uses the backing filesystem planner without duplicating storage policy in the unstorage layer. */
  plan(input: PlanInputType): PlanType {
    return this.#driver.plan(input);
  }

  /** Returns the backing filesystem's detached metrics snapshot. */
  getMetrics(): MetricsType {
    return this.#driver.getMetrics();
  }

  /** Tests one exact unstorage key. */
  async hasItem(key: string, _options: UnstorageDriverTransactionOptionsType): Promise<boolean> {
    return await this.#driver.has(key);
  }

  /** Reads one UTF-8 unstorage value or `null` when absent. */
  async getItem(key: string, _options?: UnstorageDriverTransactionOptionsType): Promise<string | null> {
    return await this.#driver.get(key);
  }

  /** Replaces one UTF-8 unstorage value. */
  async setItem(key: string, value: string, _options: UnstorageDriverTransactionOptionsType): Promise<void> {
    await this.#driver.set(key, value);
  }

  /** Reads one raw unstorage value without text transcoding. */
  async getItemRaw(key: string, _options: UnstorageDriverTransactionOptionsType): Promise<Uint8Array | null> {
    return await this.#driver.getRaw(key);
  }

  /** Replaces one raw unstorage value. */
  async setItemRaw(
    key: string,
    value: string | Blob | ArrayBuffer | ArrayBufferView,
    _options: UnstorageDriverTransactionOptionsType,
  ): Promise<void> {
    await this.#driver.setRaw(key, value);
  }

  /** Removes only the exact unstorage key. */
  async removeItem(key: string, _options: UnstorageDriverTransactionOptionsType): Promise<void> {
    await this.#driver.remove(key);
  }

  /** Projects filesystem modification time into unstorage metadata. */
  async getMeta(key: string, _options: UnstorageDriverTransactionOptionsType): Promise<UnstorageDriverMetaType | null> {
    const meta = await this.#driver.meta(key);
    return meta === null || meta.modified === undefined ? null : { mtime: meta.modified };
  }

  /**
   * Lists keys with unstorage's trailing-colon descendant semantics.
   *
   * A base such as `foo:` excludes the exact `foo` value while retaining
   * descendants. The generic KV layer deliberately does not own that
   * unstorage-specific rule.
   */
  async getKeys(base: string, options: UnstorageDriverTransactionOptionsType): Promise<string[]> {
    const exactBase = base.replace(/:+$/g, "");
    const excludesExactBase = base.endsWith(":") && exactBase.length > 0;
    const values = await this.#driver.keys(base, options.maxDepth === undefined ? undefined : { maxDepth: options.maxDepth });
    return excludesExactBase ? values.filter((key) => key !== exactBase) : values;
  }

  /** Removes a key subtree while preserving the exact base for trailing-colon calls. */
  async clear(base: string, _options: UnstorageDriverTransactionOptionsType): Promise<void> {
    await this.#driver.clear(base, { preserveExact: base.endsWith(":") && base.replace(/:+$/g, "").length > 0 });
  }

  /** Releases optional filesystem ownership through the generic driver. */
  async dispose(): Promise<void> {
    await this.#driver.dispose();
  }
}

/**
 * Creates an unstorage driver backed by this package's filesystem facade.
 *
 * This is the reverse direction of `createUnstorageAdapter()`. The generic
 * key-value driver owns the collision-safe filesystem mapping, while the
 * unstorage class translates method names and `maxDepth` behavior.
 */
export function createUnstorageDriver(
  fileSystem: FileSystemType,
  options: UnstorageDriverOptionsType = {},
): UnstorageDriverType {
  return new UnstorageDriver(fileSystem, options);
}
