import { describe, it } from "node:test";
import { expect } from "@std/expect";

import { createFileSystem } from "../mod.ts";
import { createSqliteAdapter, type SqliteStatementType } from "../src/adapter/sqlite.ts";

/**
 * Portable SQLite-shaped test double. Real Node SQLite execution lives in
 * node.test.ts; this suite protects the runtime-neutral prepare/get/all/run
 * translation shared by other SQLite wrappers.
 */
class MemorySqlite {
  /** Logical SQLite rows keyed by the adapter record identity. */
  readonly rows = new Map<string, Record<string, unknown>>();
  /** Prepared SQL retained so tests can verify schema/upsert decisions. */
  readonly sql: string[] = [];
  /** Records whether adapter-owned disposal closed the database. */
  closed = false;

  /** Implements the small prepared-statement surface consumed by `createSqliteAdapter()`. */
  prepare(sql: string): SqliteStatementType {
    this.sql.push(sql);
    if (sql.startsWith("CREATE TABLE")) return { all: () => [], get: () => undefined, run: () => undefined };
    if (sql.startsWith("SELECT") && sql.includes("WHERE id")) {
      return { all: () => [], get: (id) => this.rows.get(String(id)), run: () => undefined };
    }
    if (sql.startsWith("SELECT") && sql.includes("WHERE parent_path")) {
      return {
        all: (parent) => [...this.rows.values()].filter((row) => row.parent_path === parent),
        get: () => undefined,
        run: () => undefined,
      };
    }
    if (sql.startsWith("INSERT")) {
      return {
        all: () => [],
        get: () => undefined,
        run: (...values) => {
          const [id, path, parentPath, name, kind, data, size, lastModified, mediaType] = values;
          this.rows.set(String(id), {
            path,
            parent_path: parentPath,
            name,
            kind,
            data,
            size,
            last_modified: lastModified,
            media_type: mediaType,
          });
        },
      };
    }
    if (sql.startsWith("DELETE")) {
      return { all: () => [], get: () => undefined, run: (id) => { this.rows.delete(String(id)); } };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }

  /** Marks the test database closed. */
  close(): void {
    this.closed = true;
  }
}

describe("direct SQLite adapter", () => {
  it("reports an injected SQLite database as borrowed unless disposal is transferred", async () => {
    const borrowed = await createSqliteAdapter(new MemorySqlite());
    const owned = await createSqliteAdapter(new MemorySqlite(), { disposeDatabase: true });

    expect(borrowed.driver.inspect().ownership).toBe("borrowed");
    expect(owned.driver.inspect().ownership).toBe("owned");
  });

  it("reuses the SQLite db0 record contract and explicit ownership", async () => {
    const database = new MemorySqlite();
    const adapter = await createSqliteAdapter(database, { disposeDatabase: true });
    const fileSystem = createFileSystem(adapter, { coordination: "none", disposeAdapter: true });

    await fileSystem.writeFile("/db/value.txt", "value", { parents: true });
    expect(await fileSystem.readText("/db/value.txt")).toBe("value");
    expect(database.sql.some((sql) => sql.startsWith("CREATE TABLE"))).toBe(true);
    expect(database.sql.some((sql) => sql.includes("ON CONFLICT"))).toBe(true);

    await fileSystem.close();
    expect(database.closed).toBe(true);
  });
});
