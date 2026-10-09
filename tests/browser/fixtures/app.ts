import { openFileSystem, probeOpfs } from "../../../mod.ts";
import { createCacheAdapter } from "../../../src/adapter/cache.ts";
import { openIndexedDbAdapter } from "../../../src/adapter/indexeddb.ts";
import { createLocalStorageAdapter } from "../../../src/adapter/localstorage.ts";
import { createMemoryAdapter } from "../../../src/adapter/memory.ts";
import { createFileSystem } from "../../../src/filesystem.ts";
import { reliability } from "./reliability.ts";
import { within } from "../../gate.ts";
import { close, withReleases } from "../../close.ts";

import type { AbortResultType, BrowserAdapterType, BrowserTestApiType, RealmResultType } from "./api.ts";

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
    return await within(
      new Promise<RealmResultType>((resolve, reject) => {
        instance.onmessage = ({ data }) => {
          if (typeof data?.error === "string") reject(new Error(data.error));
          else resolve(data as RealmResultType);
        };
        instance.onerror = reject;
        instance.postMessage({ path, value });
      }),
      "DedicatedWorker result",
    );
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
    return await within(
      new Promise<RealmResultType>((resolve, reject) => {
        instance.onerror = reject;
        instance.port.onmessage = ({ data }) => {
          if (typeof data?.error === "string") reject(new Error(data.error));
          else resolve(data as RealmResultType);
        };
        instance.port.onmessageerror = reject;
        instance.port.postMessage({ path, value });
      }),
      "SharedWorker result",
    );
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
  const channel = new MessageChannel();
  try {
    await within(navigator.serviceWorker.ready, "ServiceWorker activation");
    const active = registration.active ?? registration.waiting ?? registration.installing;
    if (active === null) throw new Error("Service worker registration did not expose a worker.");
    const result = new Promise<RealmResultType>((resolve, reject) => {
      channel.port1.onmessage = ({ data }) => {
        if (typeof data?.error === "string") reject(new Error(data.error));
        else resolve(data as RealmResultType);
      };
      channel.port1.onmessageerror = reject;
    });
    active.postMessage({ path, value }, [channel.port2]);
    return await within(result, "ServiceWorker message result");
  } finally {
    channel.port1.close();
    channel.port2.close();
    await registration.unregister();
  }
}

/** Verifies that an already-aborted signal prevents a Window OPFS write from committing. */
async function abortOpfsWrite(path: string): Promise<AbortResultType> {
  const probe = await probeOpfs();
  if (!probe.rootAvailable) return { supported: false };
  const fileSystem = await openFileSystem();
  const controller = new AbortController();
  controller.abort(new DOMException("test abort", "AbortError"));
  try {
    await fileSystem.writeFile(path, "original", { parents: true });
    try {
      await fileSystem.writeFile(path, "never", { parents: true, signal: controller.signal });
      return { supported: true, name: "committed" };
    } catch (error) {
      const code = typeof error === "object" && error !== null && typeof Reflect.get(error, "code") === "string"
        ? Reflect.get(error, "code") as string
        : undefined;
      // Exercise creation separately: a rejected replacement alone would not
      // detect a file created before the initial signal check.
      try {
        await fileSystem.writeFile(`${path}.new`, "never", { signal: controller.signal });
      } catch (creation) {
        if (Reflect.get(Object(creation), "code") !== "aborted") throw creation;
      }
      return {
        supported: true,
        name: error instanceof Error ? error.name : String(error),
        ...(code === undefined ? {} : { code }),
        preserved: await fileSystem.readText(path),
        published: await fileSystem.exists(`${path}.new`),
      };
    }
  } finally {
    try {
      await fileSystem.remove(path);
      if (await fileSystem.exists(`${path}.new`)) await fileSystem.remove(`${path}.new`);
    } finally {
      await fileSystem.close();
    }
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
  const fileSystem = createFileSystem(createMemoryAdapter(), {
    coordination: "web-locks",
    lockPrefix: prefix,
  });
  const controller = new AbortController();
  let write: Promise<void> | undefined;
  let failed = false;
  let primary: unknown;
  try {
    await within(entered.promise, "blocking Web Lock admission");
    write = fileSystem.writeFile(path, "never", { signal: controller.signal });
    // Handle rejection even when waiting for queue observation fails first.
    void write.catch(() => {});
    await waitForPendingWebLock(lockName);
    controller.abort(new DOMException("queued browser lock test", "AbortError"));
    await within(write, "queued Web Lock cancellation");
    return { supported: true, name: "committed" };
  } catch (error) {
    const code = typeof error === "object" && error !== null && typeof Reflect.get(error, "code") === "string"
      ? Reflect.get(error, "code") as string
      : undefined;
    if (code !== "aborted") {
      failed = true;
      primary = error;
      throw error;
    }
    return {
      supported: true,
      name: error instanceof Error ? error.name : String(error),
      ...(code === undefined ? {} : { code }),
    };
  } finally {
    controller.abort("test cleanup");
    release.resolve();
    await close([
      () => within(Promise.allSettled(write === undefined ? [blocker] : [blocker, write]), "Web Lock fixture cleanup"),
      () => fileSystem.close(),
    ], failed ? [primary] : []);
  }
}

/** Removes a fixture-owned IndexedDB database after every connection has closed. */
async function deleteIndexedDb(name: string): Promise<void> {
  await within(
    new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      // close() marks a connection pending until outstanding transactions end.
      // A transient blocked event is not failure; the bounded success event
      // proves the owned connection actually closed and deletion completed.
    }),
    "IndexedDB fixture deletion",
  );
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
  return await withReleases(async (releases) => {
    releases.push(() => deleteIndexedDb(name));
    const firstAdapter = await openIndexedDbAdapter({ name });
    releases.push(async () => {
      await firstAdapter.dispose?.();
    });
    const first = createFileSystem(firstAdapter, { coordination: "none" });
    releases.push(() => first.close());
    const secondAdapter = await openIndexedDbAdapter({ name });
    releases.push(async () => {
      await secondAdapter.dispose?.();
    });
    const second = createFileSystem(secondAdapter, { coordination: "none" });
    releases.push(() => second.close());
    await first.writeFile("/shared.txt", "base");
    await Promise.all([
      first.writeFile("/shared.txt", "A", { mode: "append" }),
      second.writeFile("/shared.txt", "B", { mode: "append" }),
    ]);
    return await first.readText("/shared.txt");
  });
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
    const adapter = await openIndexedDbAdapter({ name: id });
    let fileSystem: ReturnType<typeof createFileSystem> | undefined;
    let failed = false;
    let primary: unknown;
    try {
      fileSystem = createFileSystem(adapter, { disposeAdapter: true });
      await fileSystem.writeFile(path, kind, { parents: true });
      return await fileSystem.readText(path);
    } catch (error) {
      failed = true;
      primary = error;
      throw error;
    } finally {
      await close([
        async () => {
          if (fileSystem === undefined) await adapter.dispose?.();
          else await fileSystem.close();
        },
        () => deleteIndexedDb(id),
      ], failed ? [primary] : []);
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

/** Fixture API installed on this page without augmenting browser globals for other source files. */
const opfsTest = {
  ready: true,
  probe: probeOpfs,
  roundTrip: roundTripOpfs,
  read: readOpfs,
  dedicated: async (path, value) => await runDedicatedWorker(new URL("./dedicated.ts", import.meta.url), path, value),
  shared: async (path, value) => await runSharedWorker(new URL("./shared.ts", import.meta.url), path, value),
  service: runServiceWorker,
  abort: abortOpfsWrite,
  queuedAbort: abortQueuedWebLock,
  benchmark: async (iterations, bytes) =>
    await (await import("../../../bench/browser/fixture.ts")).benchmarkOpfs(iterations, bytes),
  benchmarkAdapter: async (kind, iterations, bytes) =>
    await (await import("../../../bench/browser/fixture.ts")).benchmarkAdapter(kind, iterations, bytes),
  adapter: roundTripAdapter,
  indexedDbAppend,
  providerBody: async (options) => await (await import("./provider.ts")).providerBody(options),
} satisfies BrowserTestApiType;

Object.assign(window, { opfsTest });
Object.assign(window, { opfsReliability: reliability });
