import { defineRecordDriver, type RecordBackendType, type RecordDriverType } from "./record.ts";
import { type PathType, splitPath } from "../path.ts";
import { PathSchema, RecordSchema } from "../schema.ts";

/**
 * Options for a Cache API-backed record driver.
 *
 * The prefix reserves one synthetic request namespace inside the injected cache
 * so filesystem records do not collide with ordinary application responses.
 */
export interface CacheDriverOptionsType {
  /** Private URL namespace used as Cache keys. */
  readonly prefix?: string;
  /** Prevents mutations. */
  readonly readOnly?: boolean;
}

/**
 * Encodes one path into a synthetic HTTPS request URL that never needs network access.
 *
 * Cache Storage keys are requests, not arbitrary strings. The driver therefore
 * uses a private synthetic origin purely as a reversible namespace.
 */
function request(prefix: string, path: PathType): Request {
  return new Request(`https://opfs.invalid/${encodeURIComponent(prefix)}/${encodeURIComponent(path)}`);
}

/**
 * Decodes a driver-owned Cache request URL.
 *
 * Invalid or foreign requests are ignored so the injected cache can contain
 * unrelated application entries without corrupting filesystem listing.
 */
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
class CacheBackend implements RecordBackendType {
  /** Cache borrowed from the caller. */
  readonly #cache: Cache;
  /** Private synthetic URL namespace for this filesystem. */
  readonly #prefix: string;

  /** Binds one cache and one stable synthetic namespace. */
  constructor(cache: Cache, options: CacheDriverOptionsType) {
    this.#cache = cache;
    this.#prefix = options.prefix ?? "opfs";
  }

  /** Reads and validates one cached JSON record. */
  async get(path: PathType) {
    const response = await this.#cache.match(request(this.#prefix, path));
    return response === undefined ? null : RecordSchema.parse(await response.json());
  }

  /** Replaces one cached JSON record. */
  async set(record: Parameters<RecordBackendType["set"]>[0]): Promise<void> {
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

/**
 * Creates a Cache Storage record driver over one injected `Cache`.
 *
 * This backend is honest about its contract: responses are cached JSON records,
 * not durable files. Browser quota, eviction, and opaque persistence policy all
 * remain provider facts that callers can inspect but not override.
 */
export function createCacheDriver(cache: Cache, options: CacheDriverOptionsType = {}): RecordDriverType {
  const backend = new CacheBackend(cache, options);
  return defineRecordDriver(backend, {
    name: "cache",
    ownership: "borrowed",
    capabilities: { replacement: "atomic", transactions: false, binary: false },
    requirements: [{ code: "cache-storage", state: "available" }],
    limits: [{
      code: "quota-bytes",
      kind: "dynamic",
      source: "probe",
      unit: "bytes",
      detail: "Browser Cache Storage quota and eviction policy are runtime-dependent.",
    }],
    optimizations: [],
    readOnly: options.readOnly ?? false,
  });
}
