import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/sqlite-proxy";

import { createFileSystem } from "../mod.ts";
import { createDb0Adapter } from "../src/adapter/db0.ts";
import { createDrizzleAdapter } from "../src/adapter/drizzle.ts";
import { createMemoryAdapter } from "../src/adapter/memory.ts";
import { createRxDbAdapter, RxDbRecordJsonSchema } from "../src/adapter/rxdb.ts";
import { createKeyValueBridge } from "../src/bridge/kv.ts";
import { createUnstorageBridge } from "../src/bridge/unstorage.ts";
import { Db0Integration, DrizzleIntegration, RxDbIntegration, UnstorageIntegration } from "../src/integration.ts";
import { defineIntegration } from "../src/integration/definition.ts";

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

/** Minimal RxCollection-shaped store used to verify the collection-level RxDB driver. */
class FakeRxCollection {
  /** Records keyed by the OPFS path primary key. */
  #records = new Map<string, Record<string, unknown>>();

  /** Returns the RxDB query shape used by the adapter for one primary-key lookup. */
  findOne(path: string) {
    return {
      exec: async () => {
        const record = this.#records.get(path);
        return record === undefined ? null : new FakeRxDocument(record, () => this.#records.delete(path));
      },
    };
  }

  /** Returns direct children selected by their stored parent path. */
  find({ selector }: { selector: { parent: string } }) {
    return {
      exec: async () =>
        [...this.#records.values()]
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

/** Caller-owned SQLite table used to exercise the real Drizzle query builder. */
const DrizzleTestTable = sqliteTable("opfs_entries", {
  /** Canonical virtual path and logical primary key. */
  path: text("path").primaryKey(),
  /** Canonical direct parent used by directory listing. */
  parent: text("parent").notNull(),
  /** Final entry name. */
  name: text("name").notNull(),
  /** File or directory discriminator. */
  kind: text("kind").notNull(),
  /** Base64 file payload. Directories store null. */
  data: text("data"),
  /** Decoded file byte length. */
  size: integer("size").notNull(),
  /** Unix epoch milliseconds. */
  lastModified: integer("last_modified").notNull(),
  /** File media type. Directories store null. */
  mediaType: text("media_type"),
});

/** Column order Drizzle emits when selecting the complete test table. */
const DrizzleTestColumns = [
  "path",
  "parent",
  "name",
  "kind",
  "data",
  "size",
  "last_modified",
  "media_type",
] as const;

/** Physical row retained by the deterministic SQLite-proxy transport. */
type DrizzleTestRowType = Record<(typeof DrizzleTestColumns)[number], unknown>;

/** Extracts quoted identifiers from one generated SQL identifier list. */
function getSqlNames(value: string): string[] {
  return [...value.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
}

/**
 * Creates a deterministic transport under Drizzle's real SQLite proxy driver.
 *
 * The transport does not imitate Drizzle's `eq()` expression objects. Drizzle
 * itself builds SQL from the real table and condition objects, then this small
 * test database applies only the SELECT/INSERT/DELETE statements required by
 * the generic record driver. This protects the integration from changes to
 * Drizzle's private SQL-expression representation while keeping the test
 * portable across Deno, Node, and Bun.
 */
function createTestDrizzle() {
  const rows = new Map<string, DrizzleTestRowType>();
  const database = drizzle(async (sql, params) => {
    const normalized = sql.trim().toLowerCase();

    if (normalized.startsWith("select ")) {
      const condition = /"(path|parent)"\s*=\s*\?/.exec(sql)?.[1] as "path" | "parent" | undefined;
      if (condition === undefined) throw new Error(`Unexpected Drizzle SELECT: ${sql}`);
      const value = params[0];
      const selected = [...rows.values()].filter((row) => row[condition] === value);
      return { rows: selected.map((row) => DrizzleTestColumns.map((name) => row[name])) };
    }

    if (normalized.startsWith("insert ")) {
      const match = /insert\s+into\s+"[^"]+"\s*\(([^)]+)\)\s*values/i.exec(sql);
      if (match === null) throw new Error(`Unexpected Drizzle INSERT: ${sql}`);
      const names = getSqlNames(match[1] ?? "");
      const row = Object.fromEntries(names.map((name, index) => [name, params[index]])) as DrizzleTestRowType;
      rows.set(String(row.path), row);
      return { rows: [] };
    }

    if (normalized.startsWith("delete ")) {
      const condition = /"path"\s*=\s*\?/.test(sql);
      if (!condition) throw new Error(`Unexpected Drizzle DELETE: ${sql}`);
      rows.delete(String(params[0]));
      return { rows: [] };
    }

    throw new Error(`Unexpected Drizzle SQL: ${sql}`);
  });

  return { database, table: DrizzleTestTable };
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
  it("reports integration directions without pretending metadata is a bridge", () => {
    expect(UnstorageIntegration.directions.toOpfs.supported).toBe(true);
    expect(UnstorageIntegration.directions.fromOpfs.supported).toBe(true);
    for (const integration of [RxDbIntegration, Db0Integration, DrizzleIntegration]) {
      expect(integration.directions.toOpfs.supported).toBe(true);
      expect(integration.directions.fromOpfs.supported).toBe(false);
      expect(integration.directions.fromOpfs.reason?.length).toBeGreaterThan(0);
    }
  });

  it("rejects integration metadata that hides why a direction is unsupported", () => {
    expect(() =>
      defineIntegration({
        name: "invalid-integration",
        directions: { toOpfs: { supported: false }, fromOpfs: { supported: false, reason: "not implemented" } },
      })
    ).toThrow(TypeError);
  });

  it("exposes any filesystem as an unstorage driver without key collisions", async () => {
    const fileSystem = createFileSystem(createMemoryAdapter(), { coordination: "local" });
    const driver = createUnstorageBridge(fileSystem);
    expect(driver.inspect().adapter.name).toBe("memory");
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

  it("does not build KV reads or removal on advisory exists checks", async () => {
    const fileSystem = createFileSystem(createMemoryAdapter(), { coordination: "local" });
    const bridge = createKeyValueBridge(fileSystem);
    try {
      await bridge.set("prefix", "parent-value");
      await bridge.set("prefix:child", "child-value");
      await bridge.setRaw("raw", new Uint8Array([1, 2, 3]));

      // `exists()` is deliberately advisory. If the bridge reintroduces a
      // check-then-act precondition, this replacement turns the race-prone
      // extra lookup into an immediate regression failure.
      fileSystem.exists = async () => {
        throw new Error("KV bridge must not use advisory exists() as an operation precondition.");
      };

      expect(await bridge.get("prefix")).toBe("parent-value");
      expect(await bridge.get("missing")).toBeNull();
      expect(await bridge.getRaw("raw")).toEqual(new Uint8Array([1, 2, 3]));
      expect(await bridge.getRaw("missing")).toBeNull();
      expect((await bridge.meta("prefix"))?.modified).toBeInstanceOf(Date);
      expect(await bridge.meta("missing")).toBeNull();
      expect(await bridge.keys("prefix")).toContain("prefix:child");
      expect(await bridge.keys("missing")).toEqual([]);
      await bridge.remove("missing");
      await bridge.clear("missing");
      await bridge.clear("prefix", { preserveExact: true });
      expect(await bridge.get("prefix")).toBe("parent-value");
      expect(await bridge.get("prefix:child")).toBeNull();
    } finally {
      await fileSystem.close();
    }
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
    const { database, table } = createTestDrizzle();
    const fileSystem = createFileSystem(createDrizzleAdapter({ database, table }), { coordination: "local" });
    await exerciseRecordBackend(fileSystem);
  });
});
