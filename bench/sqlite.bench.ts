import { bench, run } from "mitata";
import { DatabaseSync } from "node:sqlite";

import { createFileSystem } from "../mod.ts";
import { createSqliteAdapter } from "../src/adapter/sqlite.ts";
import type { SqliteDatabaseType } from "../src/driver/sqlite.ts";

/** Fixed 64 KiB payload shared by raw SQLite, adapter, and facade measurements. */
const payload = new Uint8Array(64 * 1024);
/** Raw in-memory Node SQLite database used as the backend baseline. */
const raw = new DatabaseSync(":memory:");
raw.exec("CREATE TABLE raw (path TEXT PRIMARY KEY, data BLOB NOT NULL)");
/** Prepared raw SQLite replacement statement measured without adapter translation. */
const rawSet = raw.prepare("INSERT OR REPLACE INTO raw (path, data) VALUES (?, ?)");
/** Prepared raw SQLite read statement measured without adapter translation. */
const rawGet = raw.prepare("SELECT data FROM raw WHERE path = ?");

/** Dedicated in-memory SQLite database used by the direct adapter measurement. */
const adapterDatabase = new DatabaseSync(":memory:");
/** Dedicated in-memory SQLite database used by the filesystem facade measurement. */
const facadeDatabase = new DatabaseSync(":memory:");
/**
 * The benchmark uses Node's built-in synchronous SQLite wrapper directly.
 *
 * The runtime contract is compatible with the project adapter, but its public
 * Node type surface is wider than the small structural subset documented by the
 * driver, so the benchmark narrows it locally.
 */
const adapterSqlite = adapterDatabase as unknown as SqliteDatabaseType;
/** Narrowed SQLite contract used by the facade benchmark path. */
const facadeSqlite = facadeDatabase as unknown as SqliteDatabaseType;
/** Direct SQLite adapter measured without facade semantics. */
const adapter = await createSqliteAdapter(adapterSqlite);
/** Filesystem facade backed by SQLite with coordination disabled. */
const fileSystem = createFileSystem(await createSqliteAdapter(facadeSqlite), {
  coordination: "none",
  metrics: "none",
});

bench("sqlite/raw BLOB: 64 KiB replace + get", () => {
  rawSet.run("/bench.bin", payload);
  rawGet.get("/bench.bin");
});

bench("sqlite/adapter: 64 KiB replace + read", async () => {
  await adapter.writeFile("/bench.bin", payload, { mode: "replace" });
  await adapter.readFile("/bench.bin");
});

bench("sqlite/facade: 64 KiB replace + read", async () => {
  await fileSystem.writeFile("/bench.bin", payload);
  await fileSystem.readFile("/bench.bin");
});

try {
  await run();
} finally {
  await fileSystem.close();
  raw.close();
  adapterDatabase.close();
  facadeDatabase.close();
}
