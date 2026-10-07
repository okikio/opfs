import { defineRecordDriver, type RecordBackendType, type RecordDriverType } from "./record.ts";
import type { AnyColumn } from "drizzle-orm";
import { Column, eq, is } from "drizzle-orm";
import { RecordSchema, type RecordType } from "../schema.ts";

/**
 * Column data contract retained from a caller's dialect-specific Drizzle table.
 *
 * Drizzle stores its inferred value type in the compile-time `_` field. This
 * small projection preserves string/number constraints without exposing every
 * SQL dialect's declarations to applications importing this driver. The driver
 * accepts actual Drizzle columns at runtime; a matching plain SQL wrapper does
 * not become a column merely by satisfying this structural type.
 */
export interface DrizzleColumnType<Value> {
  /** Compile-time value type supplied by the caller's schema builder. */
  readonly _: { readonly data: Value };
  /** SQL expression produced by the actual Drizzle column. */
  getSQL(): object;
}

/**
 * Required Drizzle table columns.
 *
 * Define these columns with the dialect-specific Drizzle schema builder used by
 * the application. The driver intentionally does not own DDL because Drizzle
 * is dialect-specific and column definitions differ across SQLite, PostgreSQL,
 * MySQL, SingleStore, and driver-specific integrations.
 */
export interface DrizzleTableType {
  /** Unique canonical path column. */
  readonly path: DrizzleColumnType<string>;
  /** Canonical direct-parent path column. */
  readonly parent: DrizzleColumnType<string>;
  /** Final entry name column. */
  readonly name: DrizzleColumnType<string>;
  /** File/directory discriminator column. */
  readonly kind: DrizzleColumnType<string>;
  /** Base64 file payload column. Directory rows store null. */
  readonly data: DrizzleColumnType<string>;
  /** Decoded file size column using a JavaScript-number mode. */
  readonly size: DrizzleColumnType<number>;
  /** Unix epoch millisecond column using a JavaScript-number mode. */
  readonly lastModified: DrizzleColumnType<number>;
  /** File media-type column. Directory rows store null. */
  readonly mediaType: DrizzleColumnType<string>;
}

/** Row shape expected from the supplied Drizzle table. */
export interface DrizzleRowType {
  /** Canonical virtual path stored in the caller table. */
  readonly path: string;
  /** Canonical direct-parent path used for directory queries. */
  readonly parent: string;
  /** Final file or directory name. */
  readonly name: string;
  /** Persisted file/directory discriminator. */
  readonly kind: "file" | "directory";
  /** Base64 file payload, or null for directories. */
  readonly data: string | null;
  /** Decoded file byte length. Directories use zero. */
  readonly size: number;
  /** Unix epoch milliseconds for the logical record. */
  readonly lastModified: number;
  /** File media type, or null for directories. */
  readonly mediaType: string | null;
}

/** Options for the Drizzle-backed record driver. */
export interface DrizzleDriverOptionsType<TDatabase extends object, TTable extends DrizzleTableType> {
  /** Connected Drizzle database from any supported driver. */
  readonly database: TDatabase;
  /** Caller-defined dialect-specific table with the required columns. */
  readonly table: TTable;
}

/** Small thenable contract shared by Drizzle query builders used by this driver. */
interface QueryPromiseType<T> extends PromiseLike<T> {}

/** Selection stage that can apply a row limit. */
interface SelectLimitType {
  /** Limits the selected row count without changing the row shape. */
  limit(count: number): QueryPromiseType<readonly DrizzleRowType[]>;
}

/** Selection stage that accepts a Drizzle SQL condition. */
interface SelectWhereType {
  /** Applies one Drizzle SQL condition to the current selection. */
  where(condition: object): SelectLimitType & QueryPromiseType<readonly DrizzleRowType[]>;
}

/** Selection stage that binds the caller-provided table. */
interface SelectFromType {
  /** Binds the caller-owned table to the selection. */
  from(table: object): SelectWhereType;
}

/** Delete builder subset required for path replacement and removal. */
interface DeleteType {
  /** Restricts deletion to rows selected by the supplied condition. */
  where(condition: object): QueryPromiseType<unknown>;
}

/** Insert builder subset required to persist one normalized row. */
interface InsertValuesType {
  /** Inserts one normalized filesystem row. */
  values(value: DrizzleRowType): QueryPromiseType<unknown>;
}
/**
 * Runtime CRUD surface common to the Drizzle database objects supported here.
 *
 * This is intentionally smaller than Drizzle's public generic types. Dialect
 * schema and driver types remain owned by the caller instead of being erased
 * into a false universal database type.
 */
interface DrizzleRuntimeType {
  /** Starts an unprojected row selection. */
  select(): SelectFromType;
  /** Starts one insert against the caller-owned table. */
  insert(table: object): InsertValuesType;
  /** Starts one deletion against the caller-owned table. */
  delete(table: object): DeleteType;
}

/** Validates the three CRUD builders required at runtime before any data is touched. */
function getRuntime(database: object): DrizzleRuntimeType {
  const candidate = database as Partial<DrizzleRuntimeType>;
  if (
    typeof candidate.select !== "function" ||
    typeof candidate.insert !== "function" ||
    typeof candidate.delete !== "function"
  ) {
    throw new TypeError("Drizzle database must expose select(), insert(), and delete().");
  }
  return candidate as DrizzleRuntimeType;
}

/** Rejects missing or imitation columns before the caller's database is queried. */
function checkTable(table: DrizzleTableType): void {
  for (const name of ["path", "parent", "name", "kind", "data", "size", "lastModified", "mediaType"] as const) {
    const column = table[name];
    if (!is(column, Column) || typeof column.getSQL !== "function") {
      throw new TypeError(`Drizzle table ${name} must be an actual Drizzle column.`);
    }
  }
}

/**
 * Narrows the owned public projection only at Drizzle's expression boundary.
 *
 * Construction validates actual columns with Drizzle's cross-copy `is()`
 * contract. The cast restores upstream metadata needed by the `eq()` overload;
 * it does not turn caller-supplied plain objects into trusted columns. Upstream
 * dialect types stay private and therefore disappear from emitted declarations.
 */
function condition(column: DrizzleColumnType<string>, value: string): object {
  return eq(column as AnyColumn<{ data: string }>, value);
}

/** Converts a Drizzle row to the validated record format and restores version 1. */
function toRecord(row: DrizzleRowType): RecordType {
  if (row.kind === "directory") {
    return RecordSchema.parse({
      version: 1,
      path: row.path,
      parent: row.parent,
      name: row.name,
      kind: "directory",
      lastModified: row.lastModified,
    });
  }
  return RecordSchema.parse({
    version: 1,
    path: row.path,
    parent: row.parent,
    name: row.name,
    kind: "file",
    data: row.data ?? "",
    size: row.size,
    lastModified: row.lastModified,
    mediaType: row.mediaType ?? "",
  });
}

/** Converts the shared record format into the caller table's logical row shape. */
function toRow(record: RecordType): DrizzleRowType {
  if (record.kind === "directory") {
    return {
      path: record.path,
      parent: record.parent,
      name: record.name,
      kind: "directory",
      data: null,
      size: 0,
      lastModified: record.lastModified,
      mediaType: null,
    };
  }
  return {
    path: record.path,
    parent: record.parent,
    name: record.name,
    kind: "file",
    data: record.data,
    size: record.size,
    lastModified: record.lastModified,
    mediaType: record.mediaType,
  };
}

/**
 * Record-store projection over Drizzle's common CRUD builder surface.
 *
 * The caller owns both database and dialect-specific table. The class does not
 * create DDL or hide cross-process atomicity: replacement is delete-then-insert
 * because there is no one portable upsert form across all Drizzle dialects.
 */
class DrizzleBackend implements RecordBackendType {
  /** Runtime CRUD subset validated from the connected database. */
  readonly #database: DrizzleRuntimeType;
  /** Caller-owned table containing the required logical columns. */
  readonly #table: DrizzleTableType;

  /** Validates the database surface once and retains the caller table. */
  constructor(database: object, table: DrizzleTableType) {
    checkTable(table);
    this.#database = getRuntime(database);
    this.#table = table;
  }

  /** Selects one path row and restores the versioned filesystem record. */
  async get(path: Parameters<RecordBackendType["get"]>[0]) {
    const rows = await this.#database.select().from(this.#table).where(condition(this.#table.path, path)).limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  /** Replaces one path through the portable delete-then-insert sequence. */
  async set(record: RecordType): Promise<void> {
    await this.#database.delete(this.#table).where(condition(this.#table.path, record.path));
    await this.#database.insert(this.#table).values(toRow(record));
  }

  /** Deletes one exact path row. */
  async delete(path: Parameters<RecordBackendType["delete"]>[0]): Promise<void> {
    await this.#database.delete(this.#table).where(condition(this.#table.path, path));
  }

  /** Selects all rows whose indexed/logical parent equals the requested path. */
  async *list(parent: Parameters<RecordBackendType["list"]>[0]) {
    const rows = await this.#database.select().from(this.#table).where(condition(this.#table.parent, parent));
    for (const row of rows) yield toRecord(row);
  }
}

/** Creates an independently useful record driver over a Drizzle database/table mapping. */
export function createDrizzleDriver<TDatabase extends object, TTable extends DrizzleTableType>(
  options: DrizzleDriverOptionsType<TDatabase, TTable>,
): RecordDriverType {
  return defineRecordDriver(new DrizzleBackend(options.database, options.table), {
    name: "drizzle",
    ownership: "borrowed",
    capabilities: { replacement: "best-effort", transactions: false, binary: false },
    requirements: [{ code: "drizzle-database", state: "available" }],
    optimizations: [],
  });
}
