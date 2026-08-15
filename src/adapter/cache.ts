import type { AdapterType } from "./definition.ts";
import { createRecordAdapter, type RecordStoreType } from "./record.ts";
import { splitPath, type PathType } from "../path.ts";
import { PathSchema, RecordSchema } from "../schema.ts";

/** Options for a Cache API-backed filesystem adapter. */
export interface CacheAdapterOptionsType {
  /** Private URL namespace used as Cache keys. */
  readonly prefix?: string;
  /** Prevents mutations. */
  readonly readOnly?: boolean;
}

/** Encodes one path into a synthetic HTTPS request URL that never needs network access. */
function request(prefix: string, path: PathType): Request {
  return new Request(`https://opfs.invalid/${encodeURIComponent(prefix)}/${encodeURIComponent(path)}`);
}

/** Decodes an adapter-owned Cache request URL. */
function getPath(prefix: string, value: Request): PathType | null {
  const url = new URL(value.url);
  const parts = url.pathname.slice(1).split("/");
  if (parts.length !== 2) return null;
  try {
    if (decodeURIComponent(parts[0] ?? "") !== prefix) return null;
    return PathSchema.parse(decodeURIComponent(parts[1] ?? ""));
  } catch {
    return null;
  }
}

/**
 * Record-store projection over one injected Cache API `Cache`.
 *
 * Records are JSON Responses under synthetic HTTPS request URLs. No request is
 * sent to the network. Quota, eviction, persistence, and lifetime remain
 * browser Cache Storage policy and are not upgraded into filesystem durability
 * guarantees by this class.
 */
class CacheRecordStore implements RecordStoreType {
  /** Cache borrowed from the caller. */
  readonly #cache: Cache;
  /** Private synthetic URL namespace for this filesystem. */
  readonly #prefix: string;

  /** Binds one cache and one stable synthetic namespace. */
  constructor(cache: Cache, options: CacheAdapterOptionsType) {
    this.#cache = cache;
    this.#prefix = options.prefix ?? "opfs";
  }

  /** Reads and validates one cached JSON record. */
  async get(path: PathType) {
    const response = await this.#cache.match(request(this.#prefix, path));
    return response === undefined ? null : RecordSchema.parse(await response.json());
  }

  /** Replaces one cached JSON record. */
  async set(record: Parameters<RecordStoreType["set"]>[0]): Promise<void> {
    await this.#cache.put(
      request(this.#prefix, record.path),
      new Response(JSON.stringify(record), { headers: { "content-type": "application/json" } }),
    );
  }

  /** Removes one exact synthetic request key. */
  async delete(path: PathType): Promise<void> {
    await this.#cache.delete(request(this.#prefix, path));
  }

  /** Scans cache keys and yields direct children in the reserved namespace. */
  async *list(parent: PathType) {
    const parentDepth = splitPath(parent).length;
    for (const cacheRequest of await this.#cache.keys()) {
      const path = getPath(this.#prefix, cacheRequest);
      if (path === null || splitPath(path).length !== parentDepth + 1) continue;
      const response = await this.#cache.match(cacheRequest);
      if (response === undefined) continue;
      const record = RecordSchema.parse(await response.json());
      if (record.parent === parent) yield record;
    }
  }
}

/** Creates a record store over one injected Cache API `Cache`. */
export function createCacheRecordStore(cache: Cache, options: CacheAdapterOptionsType = {}): RecordStoreType {
  return new CacheRecordStore(cache, options);
}

/** Creates an OPFS-shaped adapter over an existing Cache API `Cache`. */
export function createCacheAdapter(cache: Cache, options: CacheAdapterOptionsType = {}): AdapterType {
  return createRecordAdapter(createCacheRecordStore(cache, options), {
    name: "cache",
    readOnly: options.readOnly ?? false,
  });
}
