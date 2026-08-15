import { describe, it } from "node:test";
import { expect } from "@std/expect";

import { createFileSystem } from "../mod.ts";
import { createDb0Adapter } from "../src/adapter/db0.ts";
import { createDrizzleAdapter } from "../src/adapter/drizzle.ts";
import { createMemoryAdapter } from "../src/adapter/memory.ts";
import { createRxDbAdapter, RxDbRecordJsonSchema } from "../src/adapter/rxdb.ts";
import { createUnstorageAdapter } from "../src/adapter/unstorage.ts";
import { createKeyValueDriver } from "../src/driver/kv.ts";
import { createUnstorageDriver } from "../src/driver/unstorage.ts";
import { Db0Bridge, DrizzleBridge, KeyValueBridge, RxDbBridge, UnstorageBridge } from "../src/bridge.ts";
import { defineBridge } from "../src/bridge/definition.ts";

/** In-memory unstorage-shaped resource used to verify forward adapter semantics and disposal ownership. */
class MemoryUnstorage {
  /** Stored unstorage values keyed exactly as the adapter writes them. */
  #values = new Map<string, unknown>();
  /** Records whether explicit database ownership was disposed. */
  disposed = false;

  /** Returns one cloned value so tests cannot pass through shared object identity. */
  async getItem(key: string): Promise<unknown> {
    return structuredClone(this.#values.get(key) ?? null);
  }

  /** Replaces one key with a cloned value. */
  async setItem(key: string, value: unknown): Promise<void> {
    this.#values.set(key, structuredClone(value));
  }

  /** Removes one exact unstorage key. */
  async removeItem(key: string): Promise<void> {
    this.#values.delete(key);
  }

  /** Lists keys under the requested unstorage prefix. */
  async getKeys(base = ""): Promise<string[]> {
    return [...this.#values.keys()].filter((key) => key.startsWith(base));
  }

  /** Marks the database disposed for adapter-ownership assertions. */
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

/** Minimal RxDocument-shaped value that preserves JSON reads and incremental removal. */
class FakeRxDocument {
  /** Current stored record represented by this document. */
  readonly record: Record<string, unknown>;
  /** Collection callback that removes this document by primary key. */
  readonly remove: () => void;

  /** Creates a document view over one stored record and its removal operation. */
  constructor(record: Record<string, unknown>, remove: () => void) {
    this.record = record;
    this.remove = remove;
  }

  /** Returns a detached JSON representation like RxDocument.toJSON(). */
  toJSON(): Record<string, unknown> {
    return structuredClone(this.record);
  }

  /** Removes this document through the collection callback. */
  async incrementalRemove(): Promise<void> {
    this.remove();
  }
}

/** Minimal RxCollection-shaped store used to verify the collection-level RxDB bridge. */
class FakeRxCollection {
  /** Records keyed by the OPFS path primary key. */
  #records = new Map<string, Record<string, unknown>>();

  /** Returns the RxDB query shape used by the adapter for one primary-key lookup. */
  findOne(path: string) {
    return {
      exec: async () => {
        const record = this.#records.get(path);
        return record === undefined
          ? null
          : new FakeRxDocument(record, () => this.#records.delete(path));
      },
    };
  }

  /** Returns direct children selected by their stored parent path. */
  find({ selector }: { selector: { parent: string } }) {
    return {
      exec: async () => [...this.#records.values()]
        .filter((record) => record.parent === selector.parent)
        .map((record) => new FakeRxDocument(record, () => this.#records.delete(String(record.path)))),
    };
  }

  /** Replaces one record using RxDB incremental-upsert semantics. */
  async incrementalUpsert(record: Record<string, unknown>): Promise<void> {
    this.#records.set(String(record.path), structuredClone(record));
  }
}

/** db0-shaped database double that records generated SQL for every supported dialect branch. */
class FakeDb0Database {
  /** Dialect exposed to db0 SQL generation. */
  readonly dialect: "sqlite" | "libsql" | "postgresql" | "mysql";
  /** Logical rows keyed by the adapter hash identity. */
  #rows = new Map<string, Record<string, unknown>>();
  /** SQL statements prepared by the adapter, retained for dialect assertions. */
  readonly prepared: string[] = [];
  /** Records whether explicit database ownership was disposed. */
  disposed = false;

  /** Selects the db0 dialect branch exercised by this database double. */
  constructor(dialect: "sqlite" | "libsql" | "postgresql" | "mysql") {
    this.dialect = dialect;
  }

  /** Creates the small statement contract required by the db0 adapter. */
  prepare(sql: string) {
    this.prepared.push(sql);
    const rows = this.#rows;
    if (sql.startsWith("CREATE TABLE")) {
      return { all: async () => [], get: async () => undefined, run: async () => ({ success: true }) };
    }
    if (sql.startsWith("SELECT") && sql.includes("WHERE id")) {
      return {
        all: async () => [],
        get: async (id: string) => rows.get(id),
        run: async () => ({ success: true }),
      };
    }
    if (sql.startsWith("SELECT") && sql.includes("WHERE parent_path")) {
      return {
        all: async (parent: string) => [...rows.values()].filter((row) => row.parent_path === parent),
        get: async () => undefined,
        run: async () => ({ success: true }),
      };
    }
    if (sql.startsWith("INSERT")) {
      return {
        all: async () => [],
        get: async () => undefined,
        run: async (...values: unknown[]) => {
          const [id, path, parentPath, name, kind, data, size, lastModified, mediaType] = values;
          rows.set(String(id), {
            path,
            parent_path: parentPath,
            name,
            kind,
            data,
            size,
            last_modified: lastModified,
            media_type: mediaType,
          });
          return { success: true };
        },
      };
    }
    if (sql.startsWith("DELETE")) {
      return {
        all: async () => [],
        get: async () => undefined,
        run: async (id: string) => {
          rows.delete(id);
          return { success: true };
        },
      };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }

  /** Marks the database disposed for adapter-ownership assertions. */
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

/** Creates a minimal Drizzle CRUD surface and caller-owned table mapping for bridge tests. */
function createFakeDrizzle() {
  const table = {
    path: { name: "path" },
    parent: { name: "parent" },
    name: { name: "name" },
    kind: { name: "kind" },
    data: { name: "data" },
    size: { name: "size" },
    lastModified: { name: "lastModified" },
    mediaType: { name: "mediaType" },
  };
  const rows: Array<Record<string, unknown>> = [];
  const database = {
    select() {
      return {
        from() {
          return {
            where(condition: { column: { name: string }; value: unknown }) {
              const selected = () => rows
                .filter((row) => row[condition.column.name] === condition.value)
                .map((row) => ({ ...row }));
              return {
                then(resolve: (value: Record<string, unknown>[]) => unknown, reject: (reason: unknown) => unknown) {
                  return Promise.resolve(selected()).then(resolve, reject);
                },
                limit(count: number) {
                  return Promise.resolve(selected().slice(0, count));
                },
              };
            },
          };
        },
      };
    },
    delete() {
      return {
        where(condition: { column: { name: string }; value: unknown }) {
          for (let index = rows.length - 1; index >= 0; index -= 1) {
            if (rows[index]?.[condition.column.name] === condition.value) rows.splice(index, 1);
          }
          return Promise.resolve();
        },
      };
    },
    insert() {
      return {
        values(value: Record<string, unknown>) {
          rows.push({ ...value });
          return Promise.resolve();
        },
      };
    },
  };
  return { database, table };
}

/** Exercises the common record-backed filesystem contract against one ecosystem adapter. */
async function exerciseRecordBackend(fileSystem: ReturnType<typeof createFileSystem>): Promise<void> {
  await fileSystem.writeFile("/records/a.txt", "A", { parents: true });
  await fileSystem.writeFile("/records/b.txt", "B", { parents: true });
  expect(await fileSystem.readText("/records/a.txt")).toBe("A");
  const names: string[] = [];
  for await (const entry of fileSystem.readDir("/records")) names.push(entry.name);
  names.sort();
  expect(names).toEqual(["a.txt", "b.txt"]);
  await fileSystem.move("/records/a.txt", "/records/c.txt");
  expect(await fileSystem.exists("/records/a.txt")).toBe(false);
  expect(await fileSystem.readText("/records/c.txt")).toBe("A");
}

describe("ecosystem adapters", () => {
  it("reports bridge directions and concrete unsupported reasons", () => {
    expect(UnstorageBridge.directions.toOpfs.supported).toBe(true);
    expect(UnstorageBridge.directions.fromOpfs.supported).toBe(true);

    for (const bridge of [RxDbBridge, Db0Bridge, DrizzleBridge]) {
      expect(bridge.directions.toOpfs.supported).toBe(true);
      expect(bridge.directions.fromOpfs.supported).toBe(false);
      expect(bridge.directions.fromOpfs.reason?.length).toBeGreaterThan(0);
    }
    expect(KeyValueBridge.directions.toOpfs.supported).toBe(false);
    expect(KeyValueBridge.directions.toOpfs.reason?.length).toBeGreaterThan(0);
    expect(KeyValueBridge.directions.fromOpfs.supported).toBe(true);
  });

  it("rejects a third-party bridge that hides why a direction is unsupported", () => {
    expect(() => defineBridge({
      name: "invalid-bridge",
      directions: {
        toOpfs: { supported: false },
        fromOpfs: { supported: false },
      },
    })).toThrow();
  });

  it("uses the high-level unstorage contract and explicit disposal ownership", async () => {
    const storage = new MemoryUnstorage();
    const adapter = createUnstorageAdapter(storage as never, { disposeStorage: true });
    const fileSystem = createFileSystem(adapter, { coordination: "local", disposeAdapter: true });
    await exerciseRecordBackend(fileSystem);
    await fileSystem.close();
    expect(storage.disposed).toBe(true);
  });

  it("exposes any filesystem through the reusable key-value driver", async () => {
    const fileSystem = createFileSystem(createMemoryAdapter(), { coordination: "none" });
    const driver = createKeyValueDriver(fileSystem);
    expect(driver.inspect().adapter).toBe("memory");
    expect(driver.plan({ operation: "write", source: "stream", mode: "replace", size: 1024 }).support).toBe("emulated");
    await driver.set("prefix", "parent-value");
    await driver.set("prefix:child", "child-value");
    await driver.setRaw("binary", new Uint8Array([1, 2, 3]));

    expect(await driver.get("prefix")).toBe("parent-value");
    expect(await driver.get("prefix:child")).toBe("child-value");
    expect([...(await driver.getRaw("binary"))!]).toEqual([1, 2, 3]);
    expect(await driver.keys()).toEqual(expect.arrayContaining(["prefix", "prefix:child", "binary"]));
    expect(driver.getMetrics().operations.write?.count).toBeGreaterThan(0);

    await driver.clear("prefix", { preserveExact: true });
    expect(await driver.get("prefix")).toBe("parent-value");
    expect(await driver.get("prefix:child")).toBe(null);
    await fileSystem.close();
  });

  it("exposes any filesystem as an unstorage driver without key collisions", async () => {
    const fileSystem = createFileSystem(createMemoryAdapter(), { coordination: "local" });
    const driver = createUnstorageDriver(fileSystem);
    expect(driver.inspect().adapter).toBe("memory");
    expect(driver.plan({ operation: "write", source: "bytes", mode: "replace", size: 3 }).supported).toBe(true);
    await driver.setItem("prefix", "parent-value", {});
    await driver.setItem("prefix:child", "child-value", {});
    await driver.setItem("odd% key/part:item?", "encoded", {});
    await driver.setItem("odd~25:item", "tilde", {});
    expect(await driver.getItem("prefix")).toBe("parent-value");
    expect(await driver.getItem("prefix:child")).toBe("child-value");
    expect(await driver.getItem("odd% key/part:item?")).toBe("encoded");
    expect(await driver.getItem("odd~25:item")).toBe("tilde");
    const keys = await driver.getKeys("", { maxDepth: 4 });
    expect(keys).toContain("prefix");
    expect(keys).toContain("prefix:child");
    await driver.clear("prefix:", {});
    expect(await driver.getItem("prefix")).toBe("parent-value");
    expect(await driver.getItem("prefix:child")).toBe(null);
  });

  it("targets RxCollection above the selected RxStorage engine", async () => {
    expect(RxDbRecordJsonSchema.primaryKey).toBe("path");
    expect(RxDbRecordJsonSchema.indexes).toEqual(["parent"]);
    const fileSystem = createFileSystem(createRxDbAdapter(new FakeRxCollection() as never), { coordination: "local" });
    await exerciseRecordBackend(fileSystem);
  });

  for (const dialect of ["sqlite", "libsql", "postgresql", "mysql"] as const) {
    it(`executes db0 record operations for ${dialect}`, async () => {
      const database = new FakeDb0Database(dialect);
      const adapter = await createDb0Adapter(database as never, { disposeDatabase: true });
      const fileSystem = createFileSystem(adapter, { coordination: "local", disposeAdapter: true });
      await exerciseRecordBackend(fileSystem);
      await fileSystem.close();
      expect(database.disposed).toBe(true);
      expect(database.prepared.some((sql) => sql.startsWith("CREATE TABLE"))).toBe(true);
      expect(database.prepared.some((sql) => sql.includes("?"))).toBe(true);
      if (dialect === "mysql") {
        expect(database.prepared.some((sql) => sql.includes("ON DUPLICATE KEY UPDATE"))).toBe(true);
      }
    });
  }

  it("uses the common Drizzle CRUD surface with a caller-owned table", async () => {
    const { database, table } = createFakeDrizzle();
    const fileSystem = createFileSystem(createDrizzleAdapter({ database, table } as never), { coordination: "local" });
    await exerciseRecordBackend(fileSystem);
  });
});
