import { describe, it } from "node:test";
import { expect } from "@std/expect";

import { createFileSystem } from "../mod.ts";
import { createRecordAdapter } from "../src/adapter/record.ts";
import { createCacheDriver } from "../src/driver/cache.ts";
import { Db0Backend, type Db0DatabaseType, type Db0PrimitiveType, type Db0StatementType } from "../src/driver/db0.ts";
import { createLocalStorageDriver, type LocalStorageType } from "../src/driver/localstorage.ts";
import type { RecordDriverType } from "../src/driver/record.ts";
import type { FileRecordType } from "../src/schema.ts";

/** Authored three-byte record; expected decoded bytes do not come from a candidate read. */
function record(path: string): FileRecordType {
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

/** Connector row admission without SQL text coupling; native SQLite has a separate suite. */
function backend(size: unknown, modified: unknown): Db0Backend {
  const row = {
    path: "/value",
    parent_path: "/",
    name: "value",
    kind: "file",
    data: "YWJj",
    size,
    last_modified: modified,
    media_type: "text/plain",
  };
  const statement: Db0StatementType = {
    all: () => Promise.resolve([row]),
    get: () => Promise.resolve(row),
    run: () => Promise.resolve({ success: true }),
  };
  const database: Db0DatabaseType = { dialect: "sqlite", prepare: () => statement };
  return new Db0Backend(database, statement, statement, statement, statement, false);
}

/** JSON persistence stand-in for portable tests; actual Web Storage is tested in a browser. */
class Storage implements LocalStorageType {
  readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

/** Proves list/read refuse a ghost child while durable source identity remains untouched. */
async function refusal(driver: RecordDriverType, saved: () => string | undefined): Promise<void> {
  const original = saved();
  await expect(driver.get("/a")).rejects.toBeInstanceOf(TypeError);
  await expect(Array.fromAsync(driver.list("/"))).rejects.toBeInstanceOf(TypeError);
  expect(await driver.get("/b")).toBeNull();
  const fs = createFileSystem(createRecordAdapter(driver));
  try {
    await expect(Array.fromAsync(fs.readDir("/"))).rejects.toMatchObject({ cause: expect.any(TypeError) });
  } finally {
    await fs.close();
  }
  expect(saved()).toBe(original);
}

describe("durable record admission", () => {
  it("owns the complete db0 write image before native asynchronous path hashing", async () => {
    const writes: Db0PrimitiveType[][] = [];
    const statement: Db0StatementType = {
      all: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      run: (...values) => {
        writes.push(values);
        return Promise.resolve({ success: true });
      },
    };
    const database: Db0DatabaseType = { dialect: "sqlite", prepare: () => statement };
    const store = new Db0Backend(database, statement, statement, statement, statement, false);
    const input = record("/value");
    const pending = store.set(input);
    // Native SubtleCrypto hashing yields to the caller. This source remains
    // caller-owned; its later mutation must not change the admitted write.
    Object.assign(input, {
      path: "/later",
      name: "later",
      data: "ZA==",
      size: 1,
      lastModified: 8,
      mediaType: "application/octet-stream",
    });
    await pending;
    expect(writes.length).toBe(1);
    expect(writes[0]?.slice(1)).toEqual(["/value", "/", "value", "file", "YWJj", "3", "7", "text/plain"]);
    expect(input.path).toBe("/later");
  });

  for (const field of ["size", "last_modified"] as const) {
    for (
      const invalid of [
        "3junk",
        "3.5",
        "3e0",
        "+3",
        "-0",
        " 3",
        "3 ",
        "",
        "0x3",
        "Infinity",
        "9007199254740992",
        9007199254740992,
        9007199254740992n,
        -1,
        -1n,
        NaN,
        Infinity,
        true,
        null,
      ]
    ) {
      it(`rejects complete ${field} input ${typeof invalid}:${String(invalid)}`, async () => {
        const store = backend(field === "size" ? invalid : 3, field === "last_modified" ? invalid : 7);
        await expect(store.get("/value")).rejects.toBeInstanceOf(TypeError);
        await expect(Array.fromAsync(store.list("/"))).rejects.toBeInstanceOf(TypeError);
      });
    }
  }

  for (const size of [3, 3n, "3", "003"]) {
    for (
      const modified of [
        0,
        0n,
        "0",
        "000",
        Number.MAX_SAFE_INTEGER,
        BigInt(Number.MAX_SAFE_INTEGER),
        String(Number.MAX_SAFE_INTEGER),
      ]
    ) {
      it(`retains whole ${typeof size}:${String(size)} bytes and ${typeof modified}:${String(modified)} timestamp`, async () => {
        const store = backend(size, modified);
        const expected = { ...record("/value"), lastModified: Number(modified) };
        expect(await store.get("/value")).toEqual(expected);
        expect(await Array.fromAsync(store.list("/"))).toEqual([expected]);
      });
    }
  }

  it("admits the safe size boundary before matching the independent decoded payload length", async () => {
    // A safe integer is still refused when it lies about this three-byte body.
    await expect(backend(String(Number.MAX_SAFE_INTEGER), 7).get("/value")).rejects.toThrow();
  });

  it("rejects same-parent Web Storage identity corruption without moving the persisted record", async () => {
    const storage = new Storage();
    const driver = createLocalStorageDriver(storage);
    await driver.set(record("/a"));
    expect(await driver.get("/a")).toEqual(record("/a"));
    expect((await Array.fromAsync(driver.list("/"))).map((entry) => entry.path)).toEqual(["/a"]);
    storage.setItem("opfs:%2Fa", JSON.stringify(record("/b")));
    await refusal(driver, () => storage.getItem("opfs:%2Fa") ?? undefined);
    await driver.set(record("/a"));
    expect(await driver.get("/a")).toEqual(record("/a"));
    expect((await Array.fromAsync(driver.list("/"))).map((entry) => entry.path)).toEqual(["/a"]);
  });

  it("rejects same-parent Cache identity corruption while foreign keys remain outside ownership", async () => {
    const values = new Map<string, string>();
    const cache = {
      keys: () => Promise.resolve([...values.keys()].map((url) => new Request(url))),
      match: (input: Request) =>
        Promise.resolve(values.has(input.url) ? new Response(values.get(input.url)) : undefined),
      put: async (input: Request, body: Response) => {
        values.set(input.url, await body.text());
      },
      delete: (input: Request) => Promise.resolve(values.delete(input.url)),
    } as unknown as Cache;
    const driver = createCacheDriver(cache);
    await driver.set(record("/a"));
    expect(await driver.get("/a")).toEqual(record("/a"));
    values.set("https://outside.invalid/opfs/%2Fforeign", "not JSON");
    expect((await Array.fromAsync(driver.list("/"))).map((entry) => entry.path)).toEqual(["/a"]);
    values.set("https://opfs.invalid/opfs/%2Fa", JSON.stringify(record("/b")));
    await refusal(driver, () => values.get("https://opfs.invalid/opfs/%2Fa"));
    await driver.set(record("/a"));
    expect(await driver.get("/a")).toEqual(record("/a"));
    expect((await Array.fromAsync(driver.list("/"))).map((entry) => entry.path)).toEqual(["/a"]);
  });
});
