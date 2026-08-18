import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createFileSystem } from "../mod.ts";
import { createDb0Adapter } from "../src/adapter/db0.ts";
import { createNodeAdapter } from "../src/adapter/node.ts";
import { createSqliteAdapter } from "../src/adapter/sqlite.ts";

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
    this.#database.close();
  }
}

describe("Node adapter", () => {
  it("streams, renames, performs synchronous random access, and holds the path lock until close", async () => {
    const root = await mkdtemp(join(tmpdir(), "okikio-opfs-"));
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
      const sync = await fileSystem.openSyncFile("/nested/moved.txt");
      sync.writeAll(new TextEncoder().encode("NODE"), { at: 0 });
      sync.flush();
      let queued = false;
      const write = fileSystem.writeFile("/nested/moved.txt", "after-sync").then(() => {
        queued = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(queued).toBe(false);
      sync.close();
      await write;
      expect(await fileSystem.readText("/nested/moved.txt")).toBe("after-sync");
    } finally {
      await fileSystem.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("executes db0 SQLite SQL against the real Node SQLite engine", async () => {
    const database = new SqliteDb0Database();
    const adapter = await createDb0Adapter(database as never, { disposeDatabase: true });
    const fileSystem = createFileSystem(adapter, { coordination: "local", disposeAdapter: true });
    try {
      await fileSystem.writeFile("/records/a.txt", "A", { parents: true });
      expect(await fileSystem.readText("/records/a.txt")).toBe("A");
    } finally {
      await fileSystem.close();
    }
  });

  it("executes the direct SQLite adapter against Node's real SQLite engine", async () => {
    const database = new DatabaseSync(":memory:");
    const adapter = await createSqliteAdapter({
      prepare(sql) {
        const statement = database.prepare(sql);
        return {
          all: (...params) => statement.all(...params),
          get: (...params) => statement.get(...params),
          run: (...params) => statement.run(...params),
        };
      },
      close() { database.close(); },
    }, { disposeDatabase: true });
    const fileSystem = createFileSystem(adapter, { coordination: "none", disposeAdapter: true });
    try {
      await fileSystem.writeFile("/sqlite/value.txt", "sqlite", { parents: true });
      expect(await fileSystem.readText("/sqlite/value.txt")).toBe("sqlite");
    } finally {
      await fileSystem.close();
    }
  });
});
