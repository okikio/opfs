import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/sqlite-proxy";

import { createFileSystem } from "../mod.ts";
import { createRecordAdapter } from "../src/adapter/record.ts";
import { Db0Backend, type Db0DatabaseType, type Db0StatementType } from "../src/driver/db0.ts";
import { createDrizzleDriver } from "../src/driver/drizzle.ts";
import { defineRecordDriver } from "../src/driver/record.ts";
import type { RecordDriverType } from "../src/driver/record.ts";
import { withReleases } from "./close.ts";

/** Real column objects define the selection order returned by SQLite proxy's documented row API. */
const Table = sqliteTable("entries", {
  path: text("path").primaryKey(),
  parent: text("parent").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  data: text("data"),
  size: integer("size").notNull(),
  lastModified: integer("last_modified").notNull(),
  mediaType: text("media_type"),
});

/** SQL connector input is independently authored, not a candidate round-trip. */
function row(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    path: "/value",
    parent: "/",
    name: "value",
    kind: "file",
    data: "",
    size: 0,
    lastModified: 7,
    mediaType: "",
    ...overrides,
  };
}

/** Adapter's common row conversion, isolated from SQL grammar tests. */
function driver(lane: "db0" | "drizzle", value: Record<string, unknown>): RecordDriverType {
  if (lane === "db0") {
    const converted = {
      ...value,
      parent_path: value.parent,
      last_modified: value.lastModified,
      media_type: value.mediaType,
    };
    const statement: Db0StatementType = {
      get: () => Promise.resolve(converted),
      all: () => Promise.resolve([converted]),
      run: () => Promise.resolve({ success: true }),
    };
    const database: Db0DatabaseType = { dialect: "sqlite", prepare: () => statement };
    return defineRecordDriver(new Db0Backend(database, statement, statement, statement, statement, false), {
      name: "db0-admission",
    });
  }
  const selected = ["path", "parent", "name", "kind", "data", "size", "lastModified", "mediaType"];
  // Drizzle owns expression construction and result mapping. This authored
  // transport only supplies one decoded row; real SQLite persists cases below.
  const database = drizzle(() => Promise.resolve({ rows: [selected.map((name) => value[name])] }));
  return createDrizzleDriver({ database, table: Table });
}

describe("SQL record discriminator and required fields", () => {
  for (const lane of ["db0", "drizzle"] as const) {
    for (
      const [field, invalid] of [
        ["kind", "unknown"],
        ["kind", "File"],
        ["kind", "directory "],
        ["kind", null],
        ["kind", undefined],
        ["kind", 0],
        ["kind", false],
        ["kind", {}],
        ["data", null],
        ["data", undefined],
        ["mediaType", null],
        ["mediaType", undefined],
      ] as const
    ) {
      it(`${lane} refuses ${field} ${typeof invalid}:${String(invalid)} before publishing file metadata`, async () =>
        await withReleases(async (releases) => {
          const input = row({ [field]: invalid });
          const saved = structuredClone(input);
          const source = driver(lane, input);
          await expect(source.get("/value")).rejects.toThrow();
          await expect(Array.fromAsync(source.list("/"))).rejects.toThrow();
          const fs = createFileSystem(createRecordAdapter(source));
          releases.push(() => fs.close());
          await expect(fs.stat("/value")).rejects.toMatchObject({ cause: expect.any(Error) });
          expect(input).toEqual(saved);
        }));
    }

    it(`${lane} retains genuine empty files and nullable directory columns`, async () => {
      const file = driver(lane, row({}));
      const expectedFile = { version: 1, ...row({}) };
      expect(await file.get("/value")).toEqual(expectedFile);
      const expectedMetadata = {
        version: 1,
        path: "/value",
        parent: "/",
        name: "value",
        kind: "file",
        size: 0,
        lastModified: 7,
        mediaType: "",
      };
      expect(await Array.fromAsync(file.list("/"))).toEqual([expectedMetadata]);
      const directory = driver(lane, row({ kind: "directory", data: null, mediaType: null }));
      const expectedDirectory = {
        version: 1,
        path: "/value",
        parent: "/",
        name: "value",
        kind: "directory",
        lastModified: 7,
      };
      expect(await directory.get("/value")).toEqual(expectedDirectory);
      expect(await Array.fromAsync(directory.list("/"))).toEqual([expectedDirectory]);
    });
  }
});
