import { bench, do_not_optimize } from "mitata";
import { expectBytes, finish, payload as createPayload, report } from "./result.ts";
import { DatabaseSync } from "node:sqlite";

import { createFileSystem } from "../mod.ts";
import { createSqliteAdapter } from "../src/adapter/sqlite.ts";
import type { SqliteDatabaseType } from "../src/driver/sqlite.ts";

/** Fixed 64 KiB payload shared by raw SQLite, adapter, and facade measurements. */
const payload = createPayload(64 * 1024);
/** Raw in-memory Node SQLite database used as the backend baseline. */
const cleanups: Array<() => void | Promise<void>> = [];
let failed = false;
let primary: unknown;
try {
  const raw = new DatabaseSync(":memory:");
  cleanups.push(() => raw.close());
  raw.exec("CREATE TABLE raw (path TEXT PRIMARY KEY, data BLOB NOT NULL)");
  /** Prepared raw SQLite replacement statement measured without adapter translation. */
  const rawSet = raw.prepare("INSERT OR REPLACE INTO raw (path, data) VALUES (?, ?)");
  /** Prepared raw SQLite read statement measured without adapter translation. */
  const rawGet = raw.prepare("SELECT data FROM raw WHERE path = ?");

  /** Dedicated in-memory SQLite database used by the direct adapter measurement. */
  const adapterDatabase = new DatabaseSync(":memory:");
  cleanups.push(() => adapterDatabase.close());
  /** Dedicated in-memory SQLite database used by the filesystem facade measurement. */
  const facadeDatabase = new DatabaseSync(":memory:");
  cleanups.push(() => facadeDatabase.close());
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
  cleanups.push(() => fileSystem.close());

  /** Exact content is checked outside the timed callbacks. */
  rawSet.run("/bench.bin", payload);
  const stored = rawGet.get("/bench.bin")?.data;
  if (!(stored instanceof Uint8Array)) throw new Error("SQLite benchmark lost its bytes.");
  expectBytes(stored, payload, "sqlite/raw");
  await adapter.writeFile("/bench.bin", payload, { mode: "replace" });
  expectBytes(await adapter.readFile("/bench.bin"), payload, "sqlite/adapter");
  await fileSystem.writeFile("/bench.bin", payload);
  expectBytes(await fileSystem.readFile("/bench.bin"), payload, "sqlite/fileSystem");

  bench("sqlite/raw BLOB: 64 KiB replace + get", () => {
    rawSet.run("/bench.bin", payload);
    do_not_optimize(rawGet.get("/bench.bin"));
  });

  bench("sqlite/adapter: 64 KiB replace + read", async () => {
    await adapter.writeFile("/bench.bin", payload, { mode: "replace" });
    do_not_optimize(await adapter.readFile("/bench.bin"));
  });

  bench("sqlite/facade: 64 KiB replace + read", async () => {
    await fileSystem.writeFile("/bench.bin", payload);
    do_not_optimize(await fileSystem.readFile("/bench.bin"));
  });

  await report();
} catch (error) {
  failed = true;
  primary = error;
  throw error;
} finally {
  await finish(cleanups, failed ? [primary] : []);
}
