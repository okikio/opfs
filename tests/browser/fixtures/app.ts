import { openFileSystem, probeOpfs } from "../../../mod.ts";
import { createCacheAdapter } from "../../../src/adapter/cache.ts";
import { openIndexedDbAdapter } from "../../../src/adapter/indexeddb.ts";
import { createLocalStorageAdapter } from "../../../src/adapter/localstorage.ts";
import { createMemoryAdapter } from "../../../src/adapter/memory.ts";
import { createOpfsAdapter } from "../../../src/adapter/opfs.ts";
import { createFileSystem } from "../../../src/filesystem.ts";

/** Result returned by one real browser realm after probing and exercising OPFS. */
interface RealmResultType {
  /** Whether the browser exposes the realm or capability needed by the scenario. */
  readonly supported: boolean;
  /** Capability report captured in the same realm as the operation. */
  readonly probe?: Awaited<ReturnType<typeof probeOpfs>>;
  /** Text read back after the fixture writes through OPFS. */
  readonly value?: string;
  /** Whether a synchronous access handle opened in the tested worker realm. */
  readonly syncOpened?: boolean;
  /** Native error name reported when synchronous access was exposed but could not open. */
  readonly syncError?: string;
}

/** Browser record adapters exercised against their actual platform storage APIs. */
type BrowserAdapterType = "localstorage" | "indexeddb" | "cache";

/** Stable result returned by browser cancellation scenarios. */
interface AbortResultType {
  /** Whether this browser exposes the capability required by the scenario. */
  readonly supported: boolean;
  /** JavaScript error name observed by the caller. */
  readonly name?: string;
  /** Stable package error code observed by the caller. */
  readonly code?: string;
}

interface BenchmarkResultType {
  /** Elapsed milliseconds for direct platform storage operations. */
  readonly rawMs: number;
  /** Elapsed milliseconds for the direct `AdapterType` path. */
  readonly adapterMs: number;
  /** Elapsed milliseconds for the complete `FileSystemType` path. */
  readonly facadeMs: number;
}

/** Browser fixture API consumed by Playwright from the containing page. */
interface BrowserTestApiType {
  /** Signals that module initialization completed and Playwright can call the fixture. */
  ready: true;
  /** Probes OPFS in the Window realm without throwing for unsupported storage. */
  probe(): ReturnType<typeof probeOpfs>;
  /** Writes and reads one value through native Window OPFS. */
  roundTrip(path: string, value: string): Promise<RealmResultType>;
  /** Reads an existing Window OPFS file without creating it. */
  read(path: string): Promise<string | null>;
  /** Runs the OPFS scenario in a real DedicatedWorker. */
  dedicated(path: string, value: string): Promise<RealmResultType>;
  /** Runs the OPFS scenario in a real SharedWorker. */
  shared(path: string, value: string): Promise<RealmResultType>;
  /** Runs the OPFS scenario in a registered ServiceWorker. */
  service(path: string, value: string): Promise<RealmResultType>;
  /** Attempts an already-cancelled write and reports its normalized terminal error. */
  abort(path: string): Promise<AbortResultType>;
  /** Queues a write behind a real Web Lock and reports the normalized cancellation error. */
  queuedAbort(): Promise<AbortResultType>;
  /** Measures native OPFS against the direct OPFS adapter and facade. */
  benchmark(iterations: number, bytes: number): Promise<BenchmarkResultType | null>;
  /** Measures one browser record backend against its adapter and facade paths. */
  benchmarkAdapter(kind: BrowserAdapterType, iterations: number, bytes: number): Promise<BenchmarkResultType | null>;
  /** Proves one browser record adapter through a write/read facade round trip. */
  adapter(kind: BrowserAdapterType): Promise<string>;
  /** Races two independent IndexedDB filesystem owners through atomic append transactions. */
  indexedDbAppend(): Promise<string>;
}

declare global {
  interface Window {
    /** Playwright-facing test API installed only by this fixture page. */
    opfsTest: BrowserTestApiType;
  }
}

/** Writes and reads one value through the Window realm OPFS facade. */
async function roundTripOpfs(path: string, value: string): Promise<RealmResultType> {
  const probe = await probeOpfs();
  if (!probe.rootAvailable) return { supported: true, probe };
  const fileSystem = await openFileSystem();
  try {
    await fileSystem.writeFile(path, value, { parents: true });
    return { supported: true, probe, value: await fileSystem.readText(path) };
  } finally {
    await fileSystem.close();
  }
}

/** Reads one Window OPFS path while preserving a non-creating lookup. */
async function readOpfs(path: string): Promise<string | null> {
  const probe = await probeOpfs();
  if (!probe.rootAvailable) return null;
  const fileSystem = await openFileSystem();
  try {
    return await fileSystem.exists(path, { kind: "file" }) ? await fileSystem.readText(path) : null;
  } finally {
    await fileSystem.close();
  }
}

/** Runs the fixture in one real DedicatedWorker and disposes it after the result. */
async function runDedicatedWorker(url: URL, path: string, value: string): Promise<RealmResultType> {
  if (typeof Worker !== "function") return { supported: false };
  const instance = new Worker(url, { type: "module" });
  try {
    return await new Promise((resolve, reject) => {
      instance.onmessage = ({ data }) => resolve(data as RealmResultType);
      instance.onerror = reject;
      instance.postMessage({ path, value });
    });
  } finally {
    instance.terminate();
  }
}

/** Runs the fixture in one real SharedWorker and closes the borrowed message port after the result. */
async function runSharedWorker(url: URL, path: string, value: string): Promise<RealmResultType> {
  if (typeof SharedWorker !== "function") return { supported: false };
  const instance = new SharedWorker(url, { type: "module" });
  instance.port.start();
  try {
    return await new Promise((resolve, reject) => {
      instance.port.onmessage = ({ data }) => resolve(data as RealmResultType);
      instance.port.onmessageerror = reject;
      instance.port.postMessage({ path, value });
    });
  } finally {
    instance.port.close();
  }
}

/** Registers a real ServiceWorker and waits for its OPFS result through a MessageChannel. */
async function runServiceWorker(path: string, value: string): Promise<RealmResultType> {
  if (!("serviceWorker" in navigator)) return { supported: false };
  const registration = await navigator.serviceWorker.register(
    new URL("./service.ts", import.meta.url),
    { type: "module", scope: "/tests/browser/fixtures/" },
  );
  await navigator.serviceWorker.ready;
  const active = registration.active ?? registration.waiting ?? registration.installing;
  if (active === null) throw new Error("Service worker registration did not expose a worker.");
  const channel = new MessageChannel();
  const result = new Promise<RealmResultType>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Service worker test timed out.")), 10_000);
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timer);
      resolve(data as RealmResultType);
    };
  });
  active.postMessage({ path, value }, [channel.port2]);
  return await result;
}

/** Verifies that an already-aborted signal prevents a Window OPFS write from committing. */
async function abortOpfsWrite(path: string): Promise<AbortResultType> {
  const probe = await probeOpfs();
  if (!probe.rootAvailable) return { supported: false };
  const fileSystem = await openFileSystem();
  const controller = new AbortController();
  controller.abort(new DOMException("test abort", "AbortError"));
  try {
    try {
      await fileSystem.writeFile(path, "never", { parents: true, signal: controller.signal });
      return { supported: true, name: "committed" };
    } catch (error) {
      const code = typeof error === "object" && error !== null && typeof Reflect.get(error, "code") === "string"
        ? Reflect.get(error, "code") as string
        : undefined;
      return {
        supported: true,
        name: error instanceof Error ? error.name : String(error),
        ...(code === undefined ? {} : { code }),
      };
    }
  } finally {
    await fileSystem.close();
  }
}

/** Creates one controllable promise gate for browser lifecycle tests. */
function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Waits until the browser reports one request in the Web Locks pending queue. */
async function waitForPendingWebLock(name: string): Promise<void> {
  const deadline = performance.now() + 1000;
  while (performance.now() < deadline) {
    const snapshot = await navigator.locks.query();
    if (snapshot.pending?.some((lock) => lock.name === name)) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Web Locks did not report '${name}' as pending.`);
}

/**
 * Aborts a filesystem write while its exclusive file lock is queued in the browser.
 *
 * The blocker uses the exact lock name requested by the facade. This exercises
 * the browser's real `navigator.locks.request()` rejection rather than a test
 * double, which protects the normalization path that differs between local and
 * Web Locks coordination.
 */
async function abortQueuedWebLock(): Promise<AbortResultType> {
  if (navigator.locks === undefined) return { supported: false };
  const prefix = `test:web-lock-abort:${crypto.randomUUID()}`;
  const path = "/queued.txt";
  const entered = deferred();
  const release = deferred();
  const lockName = `${prefix}:file:${path}`;
  const blocker = navigator.locks.request(lockName, { mode: "exclusive" }, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;

  const fileSystem = createFileSystem(createMemoryAdapter(), {
    coordination: "web-locks",
    lockPrefix: prefix,
  });
  const controller = new AbortController();
  const write = fileSystem.writeFile(path, "never", { signal: controller.signal });
  await waitForPendingWebLock(lockName);
  controller.abort(new DOMException("queued browser lock test", "AbortError"));

  try {
    await write;
    return { supported: true, name: "committed" };
  } catch (error) {
    const code = typeof error === "object" && error !== null && typeof Reflect.get(error, "code") === "string"
      ? Reflect.get(error, "code") as string
      : undefined;
    return {
      supported: true,
      name: error instanceof Error ? error.name : String(error),
      ...(code === undefined ? {} : { code }),
    };
  } finally {
    release.resolve();
    await blocker;
    await fileSystem.close();
  }
}

/**
 * Measures one logical benchmark batch with enough repetitions to exceed coarse browser timers.
 *
 * Some WebKit contexts quantize `performance.now()` enough that a very fast
 * localStorage batch can report exactly zero milliseconds. Repeating the same
 * batch until the accumulated sample spans several milliseconds preserves the
 * benchmark unit (milliseconds per requested batch) while preventing timer
 * resolution from becoming a false benchmark failure.
 */
async function measure(run: () => void | Promise<void>, minimumMs = 5): Promise<number> {
  let batches = 0;
  const start = performance.now();
  let elapsed = 0;
  do {
    await run();
    batches += 1;
    elapsed = performance.now() - start;
  } while (elapsed < minimumMs && batches < 1024);

  if (elapsed <= 0) {
    throw new Error("The browser performance timer did not advance during the benchmark sample.");
  }
  return elapsed / batches;
}

/** Measures raw OPFS, direct adapter, and facade overhead in the same browser realm. */
async function benchmarkOpfs(iterations: number, bytes: number): Promise<BenchmarkResultType | null> {
  const probe = await probeOpfs();
  if (!probe.rootAvailable) return null;
  const payload = new Uint8Array(bytes);
  const root = await navigator.storage.getDirectory();
  const rawName = `bench-raw-${crypto.randomUUID()}.bin`;
  const adapterName = `bench-adapter-${crypto.randomUUID()}.bin`;
  const facadeName = `bench-facade-${crypto.randomUUID()}.bin`;
  const rawFile = await root.getFileHandle(rawName, { create: true });

  const rawMs = await measure(async () => {
    for (let index = 0; index < iterations; index += 1) {
      const writable = await rawFile.createWritable();
      await writable.write(payload);
      await writable.close();
      await (await rawFile.getFile()).arrayBuffer();
    }
  });

  const direct = createOpfsAdapter(root);
  const adapterMs = await measure(async () => {
    for (let index = 0; index < iterations; index += 1) {
      await direct.writeFile(`/${adapterName}`, payload, { mode: "replace" });
      await direct.readFile(`/${adapterName}`);
    }
  });

  const fileSystem = await openFileSystem({ coordination: "none", metrics: "none" });
  let facadeMs = 0;
  try {
    facadeMs = await measure(async () => {
      for (let index = 0; index < iterations; index += 1) {
        await fileSystem.writeFile(`/${facadeName}`, payload);
        await fileSystem.readFile(`/${facadeName}`);
      }
    });
  } finally {
    await fileSystem.close();
    await root.removeEntry(rawName).catch(() => undefined);
    await root.removeEntry(adapterName).catch(() => undefined);
    await root.removeEntry(facadeName).catch(() => undefined);
  }
  return { rawMs, adapterMs, facadeMs };
}

/** Waits for one IndexedDB request and preserves its native failure. */
function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

/** Waits until all writes in one IndexedDB transaction commit. */
function idbTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });
}

/** Opens one raw IndexedDB database used only by the benchmark baseline. */
function openRawIndexedDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("entries");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed."));
  });
}

/** Measures one browser record backend through raw, adapter, and facade paths. */
async function benchmarkAdapter(
  kind: BrowserAdapterType,
  iterations: number,
  bytes: number,
): Promise<BenchmarkResultType | null> {
  const payload = new Uint8Array(bytes);
  const id = crypto.randomUUID();
  const path = "/bench/value.bin";

  if (kind === "localstorage") {
    const rawKey = `opfs-bench:${id}:raw`;
    const rawValue = "x".repeat(bytes);
    const rawMs = await measure(() => {
      for (let index = 0; index < iterations; index += 1) {
        localStorage.setItem(rawKey, rawValue);
        localStorage.getItem(rawKey);
      }
    });

    const direct = createLocalStorageAdapter(localStorage, { prefix: `adapter-${id}` });
    await direct.createDir("/bench");
    const adapterMs = await measure(async () => {
      for (let index = 0; index < iterations; index += 1) {
        await direct.writeFile(path, payload, { mode: "replace" });
        await direct.readFile(path);
      }
    });

    const fileSystem = createFileSystem(createLocalStorageAdapter(localStorage, { prefix: `facade-${id}` }), {
      coordination: "none",
      metrics: "none",
    });
    try {
      await fileSystem.ensureDir("/bench");
      const facadeMs = await measure(async () => {
        for (let index = 0; index < iterations; index += 1) {
          await fileSystem.writeFile(path, payload);
          await fileSystem.readFile(path);
        }
      });
      return { rawMs, adapterMs, facadeMs };
    } finally {
      localStorage.removeItem(rawKey);
      await fileSystem.close();
    }
  }

  if (kind === "indexeddb") {
    if (typeof indexedDB === "undefined") return null;
    const rawName = `opfs-bench-raw-${id}`;
    const rawDatabase = await openRawIndexedDb(rawName);
    const rawMs = await measure(async () => {
      for (let index = 0; index < iterations; index += 1) {
        const write = rawDatabase.transaction("entries", "readwrite");
        write.objectStore("entries").put(payload, "value");
        await idbTransaction(write);
        const read = rawDatabase.transaction("entries", "readonly");
        const readCommitted = idbTransaction(read);
        await idbRequest(read.objectStore("entries").get("value"));
        await readCommitted;
      }
    });

    const adapterName = `opfs-bench-adapter-${id}`;
    const direct = await openIndexedDbAdapter({ name: adapterName });
    await direct.createDir("/bench");
    const adapterMs = await measure(async () => {
      for (let index = 0; index < iterations; index += 1) {
        await direct.writeFile(path, payload, { mode: "replace" });
        await direct.readFile(path);
      }
    });

    const facadeName = `opfs-bench-facade-${id}`;
    const fileSystem = createFileSystem(await openIndexedDbAdapter({ name: facadeName }), {
      coordination: "none",
      metrics: "none",
      disposeAdapter: true,
    });
    try {
      await fileSystem.ensureDir("/bench");
      const facadeMs = await measure(async () => {
        for (let index = 0; index < iterations; index += 1) {
          await fileSystem.writeFile(path, payload);
          await fileSystem.readFile(path);
        }
      });
      return { rawMs, adapterMs, facadeMs };
    } finally {
      rawDatabase.close();
      await direct.dispose?.();
      await fileSystem.close();
      indexedDB.deleteDatabase(rawName);
      indexedDB.deleteDatabase(adapterName);
      indexedDB.deleteDatabase(facadeName);
    }
  }

  if (typeof caches === "undefined") return null;
  const rawName = `opfs-bench-raw-${id}`;
  const rawCache = await caches.open(rawName);
  const rawRequest = new Request(`https://opfs.invalid/bench/${id}`);
  const rawMs = await measure(async () => {
    for (let index = 0; index < iterations; index += 1) {
      await rawCache.put(rawRequest, new Response(payload));
      const response = await rawCache.match(rawRequest);
      await response?.arrayBuffer();
    }
  });

  const adapterName = `opfs-bench-adapter-${id}`;
  const adapterCache = await caches.open(adapterName);
  const direct = createCacheAdapter(adapterCache, { prefix: id });
  await direct.createDir("/bench");
  const adapterMs = await measure(async () => {
    for (let index = 0; index < iterations; index += 1) {
      await direct.writeFile(path, payload, { mode: "replace" });
      await direct.readFile(path);
    }
  });

  const facadeName = `opfs-bench-facade-${id}`;
  const facadeCache = await caches.open(facadeName);
  const fileSystem = createFileSystem(createCacheAdapter(facadeCache, { prefix: id }), {
    coordination: "none",
    metrics: "none",
  });
  try {
    await fileSystem.ensureDir("/bench");
    const facadeMs = await measure(async () => {
      for (let index = 0; index < iterations; index += 1) {
        await fileSystem.writeFile(path, payload);
        await fileSystem.readFile(path);
      }
    });
    return { rawMs, adapterMs, facadeMs };
  } finally {
    await fileSystem.close();
    await caches.delete(rawName);
    await caches.delete(adapterName);
    await caches.delete(facadeName);
  }
}

/**
 * Races append writes through two independent IndexedDB connections.
 *
 * A generic record adapter would read the same starting bytes in both owners and
 * then let the last complete-record replacement win. The IndexedDB driver owns
 * append/update in one readwrite transaction, so both appended bytes survive in
 * whichever serial order IndexedDB grants the two transactions.
 */
async function indexedDbAppend(): Promise<string> {
  const name = `opfs-indexeddb-append-${crypto.randomUUID()}`;
  const first = createFileSystem(await openIndexedDbAdapter({ name }), {
    coordination: "none",
    disposeAdapter: true,
  });
  const second = createFileSystem(await openIndexedDbAdapter({ name }), {
    coordination: "none",
    disposeAdapter: true,
  });
  try {
    await first.writeFile("/shared.txt", "base");
    await Promise.all([
      first.writeFile("/shared.txt", "A", { mode: "append" }),
      second.writeFile("/shared.txt", "B", { mode: "append" }),
    ]);
    return await first.readText("/shared.txt");
  } finally {
    await first.close();
    await second.close();
    indexedDB.deleteDatabase(name);
  }
}

/** Runs one real browser record adapter through a filesystem write/read facade round trip. */
async function roundTripAdapter(kind: BrowserAdapterType): Promise<string> {
  const id = crypto.randomUUID();
  const path = `/adapters/${id}.txt`;
  if (kind === "localstorage") {
    const fileSystem = createFileSystem(createLocalStorageAdapter(localStorage, { prefix: id }));
    try {
      await fileSystem.writeFile(path, kind, { parents: true });
      return await fileSystem.readText(path);
    } finally {
      await fileSystem.close();
    }
  }

  if (kind === "indexeddb") {
    const fileSystem = createFileSystem(await openIndexedDbAdapter({ name: id }), { disposeAdapter: true });
    try {
      await fileSystem.writeFile(path, kind, { parents: true });
      return await fileSystem.readText(path);
    } finally {
      await fileSystem.close();
      indexedDB.deleteDatabase(id);
    }
  }

  const cache = await caches.open(id);
  try {
    const fileSystem = createFileSystem(createCacheAdapter(cache, { prefix: id }));
    try {
      await fileSystem.writeFile(path, kind, { parents: true });
      return await fileSystem.readText(path);
    } finally {
      await fileSystem.close();
    }
  } finally {
    await caches.delete(id);
  }
}

window.opfsTest = {
  ready: true,
  probe: probeOpfs,
  roundTrip: roundTripOpfs,
  read: readOpfs,
  dedicated: async (path, value) => await runDedicatedWorker(new URL("./dedicated.ts", import.meta.url), path, value),
  shared: async (path, value) => await runSharedWorker(new URL("./shared.ts", import.meta.url), path, value),
  service: runServiceWorker,
  abort: abortOpfsWrite,
  queuedAbort: abortQueuedWebLock,
  benchmark: benchmarkOpfs,
  benchmarkAdapter,
  adapter: roundTripAdapter,
  indexedDbAppend,
};
