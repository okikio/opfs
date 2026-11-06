import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { probeOpfs } from "../../mod.ts";
import { createCacheAdapter } from "../../src/adapter/cache.ts";
import { openIndexedDbAdapter } from "../../src/adapter/indexeddb.ts";
import { createLocalStorageAdapter } from "../../src/adapter/localstorage.ts";
import { createOpfsAdapter } from "../../src/adapter/opfs.ts";
import { createCacheDriver } from "../../src/driver/cache.ts";
import { openIndexedDbDriver } from "../../src/driver/indexeddb.ts";
import { createLocalStorageDriver } from "../../src/driver/localstorage.ts";
import { createOpfsDriver } from "../../src/driver/opfs.ts";
import { createFileSystem } from "../../src/filesystem.ts";
import type { AdapterType } from "../../src/adapter/definition.ts";
import type { RecordDriverType } from "../../src/driver/record.ts";
import type { BenchmarkResultType, BrowserAdapterType } from "../../tests/browser/fixtures/api.ts";
import { close as closeFixture } from "../../tests/close.ts";
import { within } from "../../tests/gate.ts";

/** Every measured layer performs the same byte replacement and fully consumed read. */
type LaneType = () => Promise<Uint8Array>;
/** Owned fixture resources are released even when setup, an oracle, or timing fails. */
type CleanupType = () => Promise<void>;

/**
 * Record drivers store metadata plus base64, so both conversions belong in the
 * direct-driver timing. Raw storage lanes retain their native byte representation.
 */
function recordLane(driver: RecordDriverType, bytes: Uint8Array): LaneType {
  return async () => {
    await driver.set({
      version: 1,
      path: "/value.bin",
      parent: "/",
      name: "value.bin",
      kind: "file",
      lastModified: Date.now(),
      size: bytes.byteLength,
      mediaType: "",
      data: encodeBase64(bytes),
    });
    const value = await driver.get("/value.bin");
    if (value?.kind !== "file") throw new Error("Browser record driver lost its file.");
    return decodeBase64(value.data);
  };
}

/** Native requests retain their actual browser errors. */
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

/** IndexedDB completion, rather than request dispatch, is the durable timing boundary. */
function commit(value: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    value.oncomplete = () => resolve();
    value.onabort = () => reject(value.error ?? new Error("IndexedDB transaction aborted."));
    value.onerror = () => reject(value.error ?? new Error("IndexedDB transaction failed."));
  });
}

/** Early rejection cannot prevent other owned resources from closing. */
async function close(cleanups: CleanupType[], primary: readonly unknown[] = []): Promise<void> {
  await closeFixture(cleanups.toReversed(), primary);
}

/** Each layer has an independent namespace, checked bytes, warmup, and rotated sample order. */
async function run(kind: BrowserAdapterType | "opfs", iterations: number, size: number): Promise<BenchmarkResultType> {
  const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 31 + 17) % 251);
  const id = `bench-${crypto.randomUUID()}`;
  const cleanups: CleanupType[] = [];
  const samples = {
    rawMs: [] as number[],
    driverMs: [] as number[],
    adapterMs: [] as number[],
    facadeMs: [] as number[],
    measuredMs: [] as number[],
  };
  let primary: unknown;
  let failed = false;
  try {
    let raw: LaneType;
    let driver: LaneType;
    let direct: AdapterType;
    let facade: AdapterType;
    let measured: AdapterType;
    if (kind === "opfs") {
      const root = await navigator.storage.getDirectory();
      const file = await root.getFileHandle(`${id}-raw`, { create: true });
      cleanups.push(() => root.removeEntry(`${id}-raw`));
      raw = async () => {
        const writable = await file.createWritable();
        try {
          await writable.write(bytes);
          await writable.close();
        } catch (error) {
          await writable.abort().catch(() => undefined);
          throw error;
        }
        return new Uint8Array(await (await file.getFile()).arrayBuffer());
      };
      // Separate native directories preserve each layer's ownership and simplify complete cleanup.
      const driverRoot = await root.getDirectoryHandle(`${id}-driver`, { create: true });
      cleanups.push(() => root.removeEntry(`${id}-driver`, { recursive: true }));
      const native = createOpfsDriver(driverRoot);
      driver = async () => {
        await native.writeFile("/value.bin", bytes, { mode: "replace" });
        return await native.readFile("/value.bin");
      };
      const directRoot = await root.getDirectoryHandle(`${id}-adapter`, { create: true });
      cleanups.push(() => root.removeEntry(`${id}-adapter`, { recursive: true }));
      direct = createOpfsAdapter(directRoot);
      const facadeRoot = await root.getDirectoryHandle(`${id}-facade`, { create: true });
      cleanups.push(() => root.removeEntry(`${id}-facade`, { recursive: true }));
      facade = createOpfsAdapter(facadeRoot);
      const measuredRoot = await root.getDirectoryHandle(`${id}-measured`, { create: true });
      cleanups.push(() => root.removeEntry(`${id}-measured`, { recursive: true }));
      measured = createOpfsAdapter(measuredRoot);
    } else if (kind === "localstorage") {
      const rawKey = `${id}:raw`;
      cleanups.push(async () => {
        localStorage.removeItem(rawKey);
      });
      raw = async () => {
        localStorage.setItem(rawKey, encodeBase64(bytes));
        const value = localStorage.getItem(rawKey);
        if (value === null) throw new Error("localStorage benchmark lost its value.");
        return decodeBase64(value);
      };
      const prefixes = [`${id}-driver`, `${id}-adapter`, `${id}-facade`, `${id}-measured`];
      for (const prefix of prefixes) {
        cleanups.push(async () => {
          for (const key of Object.keys(localStorage)) if (key.startsWith(`${prefix}:`)) localStorage.removeItem(key);
        });
      }
      driver = recordLane(createLocalStorageDriver(localStorage, { prefix: prefixes[0]! }), bytes);
      direct = createLocalStorageAdapter(localStorage, { prefix: prefixes[1]! });
      facade = createLocalStorageAdapter(localStorage, { prefix: prefixes[2]! });
      measured = createLocalStorageAdapter(localStorage, { prefix: prefixes[3]! });
    } else if (kind === "indexeddb") {
      const open = indexedDB.open(`${id}-raw`, 1);
      open.onupgradeneeded = () => open.result.createObjectStore("entries");
      const database = await request(open);
      cleanups.push(async () => {
        database.close();
        await within(request(indexedDB.deleteDatabase(`${id}-raw`)), "benchmark raw database deletion");
      });
      raw = async () => {
        const write = database.transaction("entries", "readwrite");
        const written = commit(write);
        write.objectStore("entries").put(bytes, "value");
        await written;
        const read = database.transaction("entries", "readonly");
        const readDone = commit(read);
        const value: unknown = await request(read.objectStore("entries").get("value"));
        await readDone;
        if (!(value instanceof Uint8Array)) throw new Error("IndexedDB benchmark lost its bytes.");
        return value;
      };
      const record = await openIndexedDbDriver({ name: `${id}-driver` });
      cleanups.push(async () => {
        await closeFixture([
          async () => {
            await record.dispose?.();
          },
          () => within(request(indexedDB.deleteDatabase(`${id}-driver`)), "benchmark driver database deletion"),
        ]);
      });
      driver = recordLane(record, bytes);
      direct = await openIndexedDbAdapter({ name: `${id}-adapter` });
      const directAdapter = direct;
      cleanups.push(async () => {
        await closeFixture([
          async () => {
            await directAdapter.dispose?.();
          },
          () => within(request(indexedDB.deleteDatabase(`${id}-adapter`)), "benchmark adapter database deletion"),
        ]);
      });
      facade = await openIndexedDbAdapter({ name: `${id}-facade` });
      const facadeAdapter = facade;
      cleanups.push(async () => {
        await closeFixture([
          async () => {
            await facadeAdapter.dispose?.();
          },
          () => within(request(indexedDB.deleteDatabase(`${id}-facade`)), "benchmark facade database deletion"),
        ]);
      });
      measured = await openIndexedDbAdapter({ name: `${id}-measured` });
      const measuredAdapter = measured;
      cleanups.push(async () => {
        await closeFixture([
          async () => {
            await measuredAdapter.dispose?.();
          },
          () => within(request(indexedDB.deleteDatabase(`${id}-measured`)), "benchmark measured database deletion"),
        ]);
      });
    } else {
      const names = [`${id}-raw`, `${id}-driver`, `${id}-adapter`, `${id}-facade`, `${id}-measured`];
      for (const name of names) {
        cleanups.push(async () => {
          await caches.delete(name);
        });
      }
      const cache = await caches.open(names[0]!);
      const key = new Request(`https://opfs.invalid/${id}`);
      raw = async () => {
        await cache.put(key, new Response(bytes));
        const response = await cache.match(key);
        if (!response) throw new Error("Cache benchmark lost its response.");
        return new Uint8Array(await response.arrayBuffer());
      };
      driver = recordLane(createCacheDriver(await caches.open(names[1]!), { prefix: id }), bytes);
      direct = createCacheAdapter(await caches.open(names[2]!), { prefix: id });
      facade = createCacheAdapter(await caches.open(names[3]!), { prefix: id });
      measured = createCacheAdapter(await caches.open(names[4]!), { prefix: id });
    }
    const fs = createFileSystem(facade, { coordination: "none", metrics: "none" });
    cleanups.push(() => fs.close());
    const instrumented = createFileSystem(measured, { coordination: "none", metrics: "basic" });
    cleanups.push(() => instrumented.close());
    if (await direct.stat("/") === null) await direct.createDir("/");
    await fs.ensureDir("/");
    await instrumented.ensureDir("/");
    const lanes: Record<keyof typeof samples, LaneType> = {
      rawMs: raw,
      driverMs: driver,
      adapterMs: async () => {
        await direct.writeFile("/value.bin", bytes, { mode: "replace" });
        return await direct.readFile("/value.bin");
      },
      facadeMs: async () => {
        await fs.writeFile("/value.bin", bytes);
        return await fs.readFile("/value.bin");
      },
      measuredMs: async () => {
        await instrumented.writeFile("/value.bin", bytes);
        return await instrumented.readFile("/value.bin");
      },
    };
    for (const [name, lane] of Object.entries(lanes)) {
      const value = await lane();
      if (value.byteLength !== bytes.byteLength || value.some((byte, index) => byte !== bytes[index])) {
        throw new Error(`${kind}/${name}: byte oracle differs.`);
      }
    }
    // Each sample spans at least 5ms so coarse browser timers do not manufacture zero latency.
    // Rotation keeps one layer from always paying the cold or late position.
    const names = Object.keys(lanes) as Array<keyof typeof samples>;
    for (let sample = 0; sample < 9; sample++) {
      for (let position = 0; position < names.length; position++) {
        const name = names[(position + sample) % names.length]!;
        let batches = 0;
        const start = performance.now();
        let elapsed = 0;
        do {
          for (let index = 0; index < iterations; index++) {
            const value = await lanes[name]();
            if (value.byteLength !== bytes.byteLength) throw new Error("Timed read was truncated.");
          }
          batches++;
          elapsed = performance.now() - start;
        } while (elapsed < 5 && batches < 1024);
        if (elapsed <= 0) throw new Error("Browser timer did not advance.");
        samples[name].push(elapsed / batches);
      }
    }
    const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;
    return {
      rawMs: median(samples.rawMs),
      driverMs: median(samples.driverMs),
      adapterMs: median(samples.adapterMs),
      facadeMs: median(samples.facadeMs),
      measuredMs: median(samples.measuredMs),
      samples,
    };
  } catch (error) {
    failed = true;
    primary = error;
    throw error;
  } finally {
    await close(cleanups, failed ? [primary] : []);
  }
}

/** Compares actual OPFS layers only when the current Window exposes its native root. */
export async function benchmarkOpfs(iterations: number, bytes: number): Promise<BenchmarkResultType | null> {
  if (!(await probeOpfs()).rootAvailable) return null;
  return await run("opfs", iterations, bytes);
}

/** Compares supported browser stores with exact binary semantics and complete owned cleanup. */
export async function benchmarkAdapter(
  kind: BrowserAdapterType,
  iterations: number,
  bytes: number,
): Promise<BenchmarkResultType | null> {
  if (kind === "indexeddb" && typeof indexedDB === "undefined") return null;
  if (kind === "cache" && typeof caches === "undefined") return null;
  return await run(kind, iterations, bytes);
}
