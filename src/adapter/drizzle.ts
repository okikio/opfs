import { eq, type AnyColumn } from "drizzle-orm";
import type { AdapterType } from "./definition.ts";
import { createRecordAdapter, type RecordStoreType } from "./record.ts";
import { RecordSchema, type RecordType } from "../schema.ts";

/**
 * Required Drizzle table columns.
 *
 * Define these columns with the dialect-specific Drizzle schema builder used by
 * the application. The adapter intentionally does not own DDL because Drizzle
 * is dialect-specific and column definitions differ across SQLite, PostgreSQL,
 * MySQL, SingleStore, and driver-specific integrations.
 */
export interface DrizzleTableType {
  /** Unique canonical path column. */
  readonly path: AnyColumn<{ data: string }>;
  /** Canonical direct-parent path column. */
  readonly parent: AnyColumn<{ data: string }>;
  /** Final entry name column. */
  readonly name: AnyColumn<{ data: string }>;
  /** File/directory discriminator column. */
  readonly kind: AnyColumn<{ data: string }>;
  /** Base64 file payload column. Directory rows store null. */
  readonly data: AnyColumn<{ data: string }>;
  /** Decoded file size column using a JavaScript-number mode. */
  readonly size: AnyColumn<{ data: number }>;
  /** Unix epoch millisecond column using a JavaScript-number mode. */
  readonly lastModified: AnyColumn<{ data: number }>;
  /** File media-type column. Directory rows store null. */
  readonly mediaType: AnyColumn<{ data: string }>;
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

/** Options for the Drizzle-backed adapter. */
export interface DrizzleAdapterOptionsType<TDatabase extends object, TTable extends DrizzleTableType> {
  /** Connected Drizzle database from any supported driver. */
  readonly database: TDatabase;
  /** Caller-defined dialect-specific table with the required columns. */
  readonly table: TTable;
}

/** Small thenable contract shared by Drizzle query builders used by this bridge. */
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
class DrizzleRecordStore implements RecordStoreType {
  /** Runtime CRUD subset validated from the connected database. */
  readonly #database: DrizzleRuntimeType;
  /** Caller-owned table containing the required logical columns. */
  readonly #table: DrizzleTableType;

  /** Validates the database surface once and retains the caller table. */
  constructor(database: object, table: DrizzleTableType) {
    this.#database = getRuntime(database);
    this.#table = table;
  }

  /** Selects one path row and restores the versioned filesystem record. */
  async get(path: Parameters<RecordStoreType["get"]>[0]) {
    const rows = await this.#database.select().from(this.#table).where(eq(this.#table.path, path)).limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  /** Replaces one path through the portable delete-then-insert sequence. */
  async set(record: RecordType): Promise<void> {
    await this.#database.delete(this.#table).where(eq(this.#table.path, record.path));
    await this.#database.insert(this.#table).values(toRow(record));
  }

  /** Deletes one exact path row. */
  async delete(path: Parameters<RecordStoreType["delete"]>[0]): Promise<void> {
    await this.#database.delete(this.#table).where(eq(this.#table.path, path));
  }

  /** Selects all rows whose indexed/logical parent equals the requested path. */
  async *list(parent: Parameters<RecordStoreType["list"]>[0]) {
    const rows = await this.#database.select().from(this.#table).where(eq(this.#table.parent, parent));
    for (const row of rows) yield toRecord(row);
  }
}

/**
 * Creates a record store over a connected Drizzle database and caller table.
 *
 * Applications with multiple writing processes must add database-level
 * serialization when they need cross-process atomic replacement.
 */
export function createDrizzleRecordStore<TDatabase extends object, TTable extends DrizzleTableType>(
  options: DrizzleAdapterOptionsType<TDatabase, TTable>,
): RecordStoreType {
  return new DrizzleRecordStore(options.database, options.table);
}

/**
 * Creates an OPFS-shaped adapter over a Drizzle database and caller-owned table.
 *
 * The table must make `path` unique and provide every property in
 * {@link DrizzleTableType}. The adapter never disposes the database.
 */
export function createDrizzleAdapter<TDatabase extends object, TTable extends DrizzleTableType>(
  options: DrizzleAdapterOptionsType<TDatabase, TTable>,
): AdapterType {
  return createRecordAdapter(createDrizzleRecordStore(options), { name: "drizzle" });
}
