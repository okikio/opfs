import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type { Db0PrimitiveType } from "../src/driver/db0.ts";
import { createSqliteDriver } from "../src/driver/sqlite.ts";
import { createRecordAdapter } from "../src/adapter/record.ts";
import { createFileSystem } from "../mod.ts";
import { withReleases } from "./close.ts";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { createDrizzleDriver } from "../src/driver/drizzle.ts";
import type { RecordDriverType } from "../src/driver/record.ts";

/**
 * Real SQLite deliberately retains connector integer text in caller-owned columns.
 * SQLite INTEGER affinity would normalize some malformed text before the library
 * could observe it; TEXT models the string BIGINT contract at the actual boundary.
 */
function table(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE entries (id TEXT PRIMARY KEY, path TEXT NOT NULL, parent_path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, data TEXT, size TEXT NOT NULL, last_modified TEXT NOT NULL, media_type TEXT)",
  );
}

/** Narrows the admitted SQLite wrapper parameters at its genuine native boundary. */
function parameters(values: readonly Db0PrimitiveType[]): SQLInputValue[] {
  return values.map((value) => value === undefined ? null : typeof value === "boolean" ? Number(value) : value);
}

describe("SQLite persisted integer metadata", () => {
  for (const field of ["size", "last_modified"] as const) {
    for (const invalid of ["3junk", "3.5", "3e0", "+3", "-0", " 3", "3 ", "", "0x3", "9007199254740992"]) {
      it(`refuses persisted ${field} ${JSON.stringify(invalid)} through get/list/facade`, async () =>
        await withReleases(async (releases) => {
          const db = new DatabaseSync(":memory:");
          releases.push(() => db.close());
          table(db);
          const driver = await createSqliteDriver({
            prepare(sql) {
              const statement = db.prepare(sql);
              return {
                all: (...values) => statement.all(...parameters(values)),
                get: (...values) => statement.get(...parameters(values)),
                run: (...values) => statement.run(...parameters(values)),
              };
            },
          }, { table: "entries", initialize: false });
          const fs = createFileSystem(createRecordAdapter(driver));
          releases.push(() => fs.close());
          await fs.writeFile("/value", "abc");
          expect([...await fs.readFile("/value")]).toEqual([97, 98, 99]);
          const before = db.prepare("SELECT path, data FROM entries").get();
          // The identifier is one of the two authored literals, never external input.
          db.prepare(`UPDATE entries SET ${field} = ? WHERE path = ?`).run(invalid, "/value");
          await expect(driver.get("/value")).rejects.toBeInstanceOf(TypeError);
          await expect(Array.fromAsync(driver.list("/"))).rejects.toBeInstanceOf(TypeError);
          await expect(fs.readFile("/value")).rejects.toMatchObject({ cause: expect.any(TypeError) });
          expect(db.prepare("SELECT path, data FROM entries").get()).toEqual(before);
          db.prepare(`UPDATE entries SET ${field} = ? WHERE path = ?`).run(
            field === "size" ? "003" : "9007199254740991",
            "/value",
          );
          expect([...await fs.readFile("/value")]).toEqual([97, 98, 99]);
          expect((await Array.fromAsync(driver.list("/"))).map((entry) => entry.path)).toEqual(["/value"]);
        }));
    }
  }
});

/** Checks the fixture transport's real SQLite parameter boundary without a cast. */
function inputs(values: readonly unknown[]): SQLInputValue[] {
  return values.map((value) => {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
      return value;
    }
    throw new TypeError("The SQLite scenario admits scalar SQL parameters only.");
  });
}

/** Real Drizzle expressions and row mapping over a native Node SQLite database. */
function drizzleDatabase(db: DatabaseSync) {
  return drizzle((sql, values, method) => {
    const statement = db.prepare(sql);
    statement.setReturnArrays(true);
    if (method === "run") {
      statement.run(...inputs(values));
      return Promise.resolve({ rows: [] });
    }
    const rows = method === "get" ? statement.get(...inputs(values)) ?? [] : statement.all(...inputs(values));
    // Native return-array mode is required by SQLite proxy's documented contract.
    if (!Array.isArray(rows)) throw new TypeError("Native SQLite did not return array rows.");
    return Promise.resolve({ rows });
  });
}

/** Caller-defined table retains the nullable SQL file columns without weakening logical records. */
const NativeTable = sqliteTable("records", {
  path: text("path").primaryKey(),
  parent: text("parent").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  data: text("data"),
  size: integer("size").notNull(),
  lastModified: integer("last_modified").notNull(),
  mediaType: text("media_type"),
});

describe("SQLite persisted record kinds and file fields", () => {
  for (const lane of ["db0", "drizzle"] as const) {
    for (
      const [field, invalid] of [["kind", "unknown"], ["kind", "File"], ["kind", "directory "], ["data", null], [
        "media_type",
        null,
      ]] as const
    ) {
      it(`${lane} refuses stored ${field} ${JSON.stringify(invalid)} without inventing an empty file`, async () =>
        await withReleases(async (releases) => {
          const db = new DatabaseSync(":memory:");
          releases.push(() => db.close());
          let driver: RecordDriverType;
          let name: "entries" | "records";
          if (lane === "db0") {
            table(db);
            name = "entries";
            driver = await createSqliteDriver({
              prepare(sql) {
                const statement = db.prepare(sql);
                return {
                  all: (...values) => statement.all(...parameters(values)),
                  get: (...values) => statement.get(...parameters(values)),
                  run: (...values) => statement.run(...parameters(values)),
                };
              },
            }, { table: name, initialize: false });
          } else {
            name = "records";
            db.exec(
              "CREATE TABLE records (path TEXT PRIMARY KEY, parent TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, data TEXT, size INTEGER NOT NULL, last_modified INTEGER NOT NULL, media_type TEXT)",
            );
            driver = createDrizzleDriver({ database: drizzleDatabase(db), table: NativeTable });
          }
          const fs = createFileSystem(createRecordAdapter(driver));
          releases.push(() => fs.close());
          await fs.writeFile("/value", new Uint8Array());
          expect([...await fs.readFile("/value")]).toEqual([]);
          db.prepare(`UPDATE ${name} SET ${field} = ? WHERE path = ?`).run(invalid, "/value");
          const saved = db.prepare(`SELECT * FROM ${name} WHERE path = ?`).get("/value");
          await expect(driver.get("/value")).rejects.toThrow();
          await expect(Array.fromAsync(driver.list("/"))).rejects.toThrow();
          await expect(fs.stat("/value")).rejects.toMatchObject({ cause: expect.any(Error) });
          expect(db.prepare(`SELECT * FROM ${name} WHERE path = ?`).get("/value")).toEqual(saved);
          db.prepare(`UPDATE ${name} SET ${field} = ? WHERE path = ?`).run(field === "kind" ? "file" : "", "/value");
          expect([...await fs.readFile("/value")]).toEqual([]);
          expect((await Array.fromAsync(driver.list("/"))).map((entry) => entry.path)).toEqual(["/value"]);
        }));
    }
  }
});
