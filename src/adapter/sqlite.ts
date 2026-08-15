import type { AdapterType } from "./definition.ts";
import { createDb0Adapter, type Db0PrimitiveType, type Db0StatementType } from "./db0.ts";

/** Statement shape shared by Node, Bun, Deno, and other SQLite wrappers. */
export interface SqliteStatementType {
  /** Returns all matching rows. */
  all(...params: Db0PrimitiveType[]): unknown[] | Promise<unknown[]>;
  /** Returns the first matching row. */
  get(...params: Db0PrimitiveType[]): unknown | Promise<unknown>;
  /** Executes a mutation. */
  run(...params: Db0PrimitiveType[]): unknown | Promise<unknown>;
}

/** Minimal connected SQLite database contract used by the direct adapter. */
export interface SqliteDatabaseType {
  /** Compiles one SQL statement. */
  prepare(sql: string): SqliteStatementType;
  /** Closes the database when ownership is transferred. */
  close?(): void | Promise<void>;
}

/** Direct SQLite adapter options. */
export interface SqliteAdapterOptionsType {
  /** Adapter-owned table. Defaults to `opfs_entries`. */
  readonly table?: string;
  /** Creates the table before returning. Defaults to true. */
  readonly initialize?: boolean;
  /** Closes the injected database with the adapter. */
  readonly disposeDatabase?: boolean;
}

/** Converts one SQLite statement to db0's asynchronous statement contract. */
class SqliteStatement implements Db0StatementType {
  /** Runtime-specific SQLite statement borrowed from the connected database. */
  readonly #statement: SqliteStatementType;

  /** Binds one prepared statement without executing it. */
  constructor(statement: SqliteStatementType) {
    this.#statement = statement;
  }

  /** Returns all rows and normalizes synchronous wrappers to a Promise. */
  async all(...params: Db0PrimitiveType[]): Promise<unknown[]> {
    return await this.#statement.all(...params);
  }

  /** Returns the first row and normalizes synchronous wrappers to a Promise. */
  async get(...params: Db0PrimitiveType[]): Promise<unknown> {
    return await this.#statement.get(...params);
  }

  /** Executes a mutation and reports success after the wrapper returns normally. */
  async run(...params: Db0PrimitiveType[]): Promise<{ readonly success: boolean }> {
    await this.#statement.run(...params);
    return { success: true };
  }
}

/** db0-compatible SQLite database projection used only by the shared SQL record layer. */
class SqliteDatabase {
  /** db0 dialect identity consumed by {@link createDb0Adapter}. */
  readonly dialect = "sqlite" as const;
  /** Caller-owned SQLite database. */
  readonly #database: SqliteDatabaseType;
  /** Whether the db0 disposal path also closes the SQLite database. */
  readonly #disposeDatabase: boolean;

  /** Retains the connected database and explicit ownership policy. */
  constructor(database: SqliteDatabaseType, disposeDatabase: boolean) {
    this.#database = database;
    this.#disposeDatabase = disposeDatabase;
  }

  /** Prepares one statement and adapts sync/async result methods. */
  prepare(sql: string): Db0StatementType {
    return new SqliteStatement(this.#database.prepare(sql));
  }

  /** Closes the connected SQLite database only when ownership was transferred. */
  async dispose(): Promise<void> {
    if (this.#disposeDatabase) await this.#database.close?.();
  }
}

/**
 * Creates the OPFS adapter directly from a connected SQLite database.
 *
 * The SQL record implementation is intentionally shared with the db0 SQLite
 * branch instead of maintaining a second table format and upsert algorithm.
 * The caller still owns journal mode, transactions, file placement, extensions,
 * and database lifecycle unless disposal is explicitly transferred.
 */
export async function createSqliteAdapter(database: SqliteDatabaseType, options: SqliteAdapterOptionsType = {}): Promise<AdapterType> {
  return await createDb0Adapter(new SqliteDatabase(database, options.disposeDatabase ?? false), {
    ...(options.table === undefined ? {} : { table: options.table }),
    ...(options.initialize === undefined ? {} : { initialize: options.initialize }),
    disposeDatabase: true,
  });
}
