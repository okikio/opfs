import { createFileSystem } from "../../../mod.ts";
import { createRecordAdapter } from "../../../src/adapter/record.ts";
import { createCacheDriver } from "../../../src/driver/cache.ts";
import { createLocalStorageDriver } from "../../../src/driver/localstorage.ts";
import type { RecordDriverType } from "../../../src/driver/record.ts";
import { FileSystemError } from "../../../src/error.ts";
import type { FileRecordType } from "../../../src/schema.ts";
import { withReleases } from "../../close.ts";

/** Independently authored data and record identities used in actual browser persistence. */
function value(path: string): FileRecordType {
  return {
    version: 1,
    path,
    parent: "/",
    name: path.slice(1),
    kind: "file",
    data: "YWJj",
    size: 3,
    lastModified: 7,
    mediaType: "text/plain",
  };
}

/** Observes a specific public refusal without converting an unexpected fault into success. */
async function refused(work: () => Promise<unknown>, facade = false): Promise<boolean> {
  try {
    await work();
    return false;
  } catch (error) {
    if (facade ? error instanceof FileSystemError && error.cause instanceof TypeError : error instanceof TypeError) {
      return true;
    }
    throw error;
  }
}

/** Browser observations remain serializable; Playwright owns the independent expected result. */
export interface RecordObservationType {
  readonly before: readonly number[];
  readonly listedBefore: readonly string[];
  readonly getRefused: boolean;
  readonly listRefused: boolean;
  readonly facadeRefused: boolean;
  readonly missing: unknown;
  readonly persistedUnchanged: boolean;
  readonly repaired: readonly number[];
  readonly listedAfter: readonly string[];
  readonly foreign: string | null;
}

/** Exercises the actual stored JSON at an unchanged physical key, then explicit repair. */
async function observe(
  driver: RecordDriverType,
  corrupt: () => Promise<void>,
  persisted: () => Promise<string | null>,
  foreign: () => Promise<string | null>,
): Promise<RecordObservationType> {
  return await withReleases(async (releases) => {
    const fs = createFileSystem(createRecordAdapter(driver));
    releases.push(() => fs.close());
    await fs.writeFile("/a", "abc");
    const before = [...await fs.readFile("/a")];
    const listedBefore = (await Array.fromAsync(driver.list("/"))).map((record) => record.path);
    await corrupt();
    const saved = await persisted();
    const getRefused = await refused(() => driver.get("/a"));
    const listRefused = await refused(() => Array.fromAsync(driver.list("/")));
    const facadeRefused = await refused(() => Array.fromAsync(fs.readDir("/")), true);
    const missing = await driver.get("/b");
    const persistedUnchanged = await persisted() === saved;
    // Explicitly restoring the private record is application recovery, not a read-side migration.
    await driver.set(value("/a"));
    const repaired = [...await fs.readFile("/a")];
    const listedAfter = (await Array.fromAsync(driver.list("/"))).map((record) => record.path);
    return {
      before,
      listedBefore,
      getRefused,
      listRefused,
      facadeRefused,
      missing,
      persistedUnchanged,
      repaired,
      listedAfter,
      foreign: await foreign(),
    };
  });
}

/** Uses real Cache Storage or localStorage in the already-admitted browser fixture origin. */
export async function run(kind: "cache" | "localstorage"): Promise<RecordObservationType> {
  const prefix = `opfs-record-${crypto.randomUUID()}`;
  if (kind === "localstorage") {
    const key = `${prefix}:%2Fa`;
    const unrelated = `${prefix}-foreign`;
    return await withReleases(async (releases) => {
      releases.push(() => localStorage.removeItem(key));
      releases.push(() => localStorage.removeItem(unrelated));
      localStorage.setItem(unrelated, "caller-owned");
      return await observe(
        createLocalStorageDriver(localStorage, { prefix }),
        () => {
          localStorage.setItem(key, JSON.stringify(value("/b")));
          return Promise.resolve();
        },
        () => Promise.resolve(localStorage.getItem(key)),
        () => Promise.resolve(localStorage.getItem(unrelated)),
      );
    });
  }
  return await withReleases(async (releases) => {
    const cache = await caches.open(prefix);
    releases.push(() => caches.delete(prefix));
    const key = new Request(`https://opfs.invalid/${prefix}/%2Fa`);
    const unrelated = new Request(`https://outside.invalid/${prefix}/foreign`);
    await cache.put(unrelated, new Response("caller-owned"));
    return await observe(
      createCacheDriver(cache, { prefix }),
      () => cache.put(key, Response.json(value("/b"))),
      async () => (await cache.match(key))?.text() ?? null,
      async () => (await cache.match(unrelated))?.text() ?? null,
    );
  });
}
