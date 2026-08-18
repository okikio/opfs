import type { AdapterType } from "./definition.ts";
import { createRecordAdapter } from "./record.ts";
import {
  createSqliteDriver,
  type SqliteDatabaseType,
  type SqliteDriverOptionsType,
  type SqliteStatementType,
} from "../driver/sqlite.ts";

/** Options forwarded to the SQLite record driver. */
export type SqliteAdapterOptionsType = SqliteDriverOptionsType;

/** Minimal connected SQLite database and statement contracts consumed by the driver. */
export type { SqliteDatabaseType, SqliteStatementType };

/**
 * Creates the OPFS primitive translation over a connected SQLite record driver.
 *
 * This stores logical filesystem records in SQL rows. It does not make SQLite
 * use `FileSystemType` as its database-file VFS. See the database architecture
 * guide for that opposite direction.
 */
export async function createSqliteAdapter(
  database: SqliteDatabaseType,
  options: SqliteAdapterOptionsType = {},
): Promise<AdapterType> {
  return createRecordAdapter(await createSqliteDriver(database, options), {
    name: "sqlite",
    disposeDriver: true,
  });
}
