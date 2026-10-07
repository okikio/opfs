import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { mkdtemp, rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";

import { createFileSystem } from "../mod.ts";
import { createDb0Adapter } from "../src/adapter/db0.ts";
import { createNodeAdapter } from "../src/adapter/node.ts";
import { createSqliteAdapter } from "../src/adapter/sqlite.ts";
import type { Db0PrimitiveType } from "../src/driver/db0.ts";
import { verifyHost, verifyWindowsNames } from "./host.ts";
import { verifySync } from "./reliability.ts";

/** Normalizes db0-style parameters to Node SQLite's narrower accepted input set. */
function toSqliteParams(params: readonly Db0PrimitiveType[]): SQLInputValue[] {
  return params.map((value) => value === undefined ? null : typeof value === "boolean" ? Number(value) : value);
}

/** Real Node SQLite database wrapped in the db0 shape used by the record driver contract. */
class SqliteDb0Database {
  /** Selects db0 SQLite SQL generation. */
  readonly dialect = "sqlite" as const;
  /** Real in-memory Node SQLite engine used for integration behavior. */
  #database = new DatabaseSync(":memory:");

  /** Adapts one Node SQLite statement to db0 get/all/run semantics. */
  prepare(sql: string) {
    const statement = this.#database.prepare(sql);
    return {
      all: async (...params: never[]) => statement.all(...params),
      get: async (...params: never[]) => statement.get(...params),
      run: async (...params: never[]) => ({ success: true, ...statement.run(...params) }),
    };
  }

  /** Closes the owned Node SQLite database. */
  async dispose(): Promise<void> {
    if (this.#database.isOpen) this.#database.close();
  }
}

describe("Node adapter", () => {
  it("preserves Windows native filename rejection and remains usable", { skip: platform() !== "win32" }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "okikio-opfs-windows-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fileSystem = createFileSystem(createNodeAdapter({ root }), { coordination: "local" });
    try {
      await verifyWindowsNames(fileSystem);
    } finally {
      await fileSystem.close();
    }
  });

  it("preserves host range, directory removal, and overwrite semantics", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "okikio-opfs-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fileSystem = createFileSystem(createNodeAdapter({ root }), { coordination: "local" });
    try {
      await verifyHost(fileSystem);
    } finally {
      await fileSystem.close();
    }
  });

  it("streams, renames, performs synchronous random access, and holds the path lock until close", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "okikio-opfs-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fileSystem = createFileSystem(createNodeAdapter({ root }), { coordination: "local" });
    try {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("stream"));
          controller.close();
        },
      });
      await fileSystem.writeFile("/nested/file.txt", stream, { parents: true });
      expect(await fileSystem.readText("/nested/file.txt")).toBe("stream");
      await fileSystem.move("/nested/file.txt", "/nested/moved.txt");
      expect(await fileSystem.exists("/nested/file.txt")).toBe(false);
      await verifySync(fileSystem, "/nested/moved.txt", "NODE");
    } finally {
      await fileSystem.close();
    }
  });

  it("executes db0 SQLite SQL against the real Node SQLite engine", async (t) => {
    const database = new SqliteDb0Database();
    t.after(() => database.dispose());
    const adapter = await createDb0Adapter(database as never, { disposeDatabase: true });
    const fileSystem = createFileSystem(adapter, { coordination: "local", disposeAdapter: true });
    try {
      await fileSystem.writeFile("/records/a.txt", "A", { parents: true });
      expect(await fileSystem.readText("/records/a.txt")).toBe("A");
      await fileSystem.writeFile("/records/a.txt", "replacement");
      expect(await fileSystem.readText("/records/a.txt")).toBe("replacement");
    } finally {
      await fileSystem.close();
    }
  });

  it("executes the direct SQLite adapter against Node's real SQLite engine", async (t) => {
    const database = new DatabaseSync(":memory:");
    t.after(() => {
      if (database.isOpen) database.close();
    });
    const adapter = await createSqliteAdapter({
      prepare(sql) {
        const statement = database.prepare(sql);
        return {
          all: (...params) => statement.all(...toSqliteParams(params)),
          get: (...params) => statement.get(...toSqliteParams(params)),
          run: (...params) => statement.run(...toSqliteParams(params)),
        };
      },
      close() {
        database.close();
      },
    }, { disposeDatabase: true });
    const fileSystem = createFileSystem(adapter, { coordination: "none", disposeAdapter: true });
    try {
      await fileSystem.writeFile("/sqlite/value.txt", "sqlite", { parents: true });
      expect(await fileSystem.readText("/sqlite/value.txt")).toBe("sqlite");
      await fileSystem.writeFile("/sqlite/value.txt", "replacement");
      expect(await fileSystem.readText("/sqlite/value.txt")).toBe("replacement");
    } finally {
      await fileSystem.close();
    }
  });
});
