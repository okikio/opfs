import type { AdapterType } from "./definition.ts";
import { createRecordAdapter, type RecordStoreType } from "./record.ts";
import {
  Db0DialectSchema,
  RecordSchema,
  SqlIdentifierSchema,
  type Db0DialectType,
  type RecordType,
} from "../schema.ts";

/** Primitive parameter values accepted by db0 prepared statements. */
export type Db0PrimitiveType = string | number | boolean | undefined | null;

/** Prepared statement subset required from db0. */
export interface Db0StatementType {
  /** Executes a query and returns every row. */
  all(...params: Db0PrimitiveType[]): Promise<unknown[]>;
  /** Executes a query and returns the first row. */
  get(...params: Db0PrimitiveType[]): Promise<unknown>;
  /** Executes a mutation. */
  run(...params: Db0PrimitiveType[]): Promise<{ readonly success: boolean }>;
}

/**
 * Structural subset of db0's public `Database` API.
 *
 * The current db0 contract exposes the SQL dialect independently of the
 * connector. That lets this bridge support Bun SQLite, Node SQLite, D1,
 * LibSQL, PGlite, PostgreSQL/Hyperdrive, MySQL/Hyperdrive, PlanetScale, and the
 * other current connectors through four dialect implementations.
 */
export interface Db0DatabaseType {
  /** SQL dialect selected by the active connector. */
  readonly dialect: Db0DialectType;
  /** Compiles one SQL string into a reusable statement. */
  prepare(sql: string): Db0StatementType;
  /** Releases the database when ownership is explicitly transferred. */
  dispose?(): Promise<void>;
}

/** Options for the db0 record store and filesystem adapter. */
export interface Db0AdapterOptionsType {
  /** Adapter-owned table. Defaults to `opfs_entries`. */
  readonly table?: string;
  /** Creates the table before returning the adapter. Defaults to true. */
  readonly initialize?: boolean;
  /** Disposes the injected db0 Database when the adapter closes. */
  readonly disposeDatabase?: boolean;
}

/** Columns read from every db0 filesystem row. */
const DB0_ROW_COLUMNS_SQL = "path, parent_path, name, kind, data, size, last_modified, media_type";

/** Columns written by the db0 record-store bridge. */
const DB0_WRITE_COLUMNS_SQL = `id, ${DB0_ROW_COLUMNS_SQL}`;

/** Database row shape after db0 driver decoding and before record validation. */
interface Db0RowType {
  /** Canonical virtual path returned by the connector. */
  readonly path: string;
  /** Canonical direct-parent path stored in the SQL row. */
  readonly parent_path: string;
  /** Final file or directory name. */
  readonly name: string;
  /** Persisted entry discriminator before schema validation. */
  readonly kind: string;
  /** Base64 file payload, or null for directories. */
  readonly data: string | null;
  /** File byte length in the connector's integer representation. */
  readonly size: number | string | bigint;
  /** Unix epoch milliseconds in the connector's integer representation. */
  readonly last_modified: number | string | bigint;
  /** File media type, or null for directories. */
  readonly media_type: string | null;
}

/** Validates and quotes the adapter-owned table name for the selected db0 dialect. */
function quoteIdentifier(identifier: string, dialect: Db0DialectType): string {
  SqlIdentifierSchema.parse(identifier);
  return dialect === "mysql" ? `\`${identifier}\`` : `"${identifier}"`;
}

/**
 * Creates db0's portable prepared-statement placeholders.
 *
 * db0 connectors own translation to driver-native parameter syntax. Current
 * PostgreSQL and PGlite connectors, for example, translate `?` to `$1`, `$2`,
 * and so on before calling the underlying driver. Keeping `?` here lets this
 * bridge stay at the db0 Database contract instead of coupling to connectors.
 */
function placeholders(count: number): string[] {
  return Array.from({ length: count }, () => "?");
}

/** Normalizes BIGINT driver results and rejects values outside JavaScript safe-integer range. */
function toNumber(value: number | string | bigint, field: string): number {
  const normalized = typeof value === "bigint"
    ? Number(value)
    : typeof value === "string"
    ? Number.parseInt(value, 10)
    : value;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new TypeError(`db0 returned invalid ${field} '${String(value)}'.`);
  }
  return normalized;
}

/** Converts a connector-dependent db0 row into the validated record-store format. */
function parseRow(value: unknown): RecordType {
  if (typeof value !== "object" || value === null) throw new TypeError("db0 returned a non-object filesystem row.");
  const row = value as Db0RowType;
  if (row.kind === "directory") {
    return RecordSchema.parse({
      version: 1,
      path: row.path,
      parent: row.parent_path,
      name: row.name,
      kind: "directory",
      lastModified: toNumber(row.last_modified, "last_modified"),
    });
  }
  return RecordSchema.parse({
    version: 1,
    path: row.path,
    parent: row.parent_path,
    name: row.name,
    kind: "file",
    data: row.data ?? "",
    size: toNumber(row.size, "size"),
    lastModified: toNumber(row.last_modified, "last_modified"),
    mediaType: row.media_type ?? "",
  });
}

/**
 * Hashes the full path into a fixed-width primary key.
 *
 * MySQL cannot portably use an arbitrary-length TEXT path as a primary key. A
 * SHA-256 id keeps the indexed key fixed while the original path remains stored
 * and queryable in its own column.
 */
async function getPathId(path: string): Promise<string> {
  const bytes = new TextEncoder().encode(path);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

/** Builds only the small DDL subset verified across db0's four public dialects. */
function getCreateTableSql(table: string, dialect: Db0DialectType): string {
  const q = quoteIdentifier(table, dialect);
  const integer = dialect === "postgresql" || dialect === "mysql" ? "BIGINT" : "INTEGER";
  const columns = dialect === "mysql"
    ? [
      "id VARCHAR(64) NOT NULL PRIMARY KEY",
      "path TEXT NOT NULL",
      "parent_path TEXT NOT NULL",
      "name TEXT NOT NULL",
      "kind VARCHAR(16) NOT NULL",
      "data LONGTEXT NULL",
      `size ${integer} NOT NULL`,
      `last_modified ${integer} NOT NULL`,
      "media_type TEXT NULL",
    ]
    : [
      "id TEXT NOT NULL PRIMARY KEY",
      "path TEXT NOT NULL",
      "parent_path TEXT NOT NULL",
      "name TEXT NOT NULL",
      "kind TEXT NOT NULL",
      "data TEXT NULL",
      `size ${integer} NOT NULL`,
      `last_modified ${integer} NOT NULL`,
      "media_type TEXT NULL",
    ];
  return `CREATE TABLE IF NOT EXISTS ${q} (${columns.join(", ")})`;
}

/** Builds one atomic row replacement using each dialect's native upsert form. */
function getUpsertSql(table: string, dialect: Db0DialectType): string {
  const q = quoteIdentifier(table, dialect);
  const values = placeholders(9).join(", ");
  const assignments = dialect === "mysql"
    ? [
      "path=VALUES(path)",
      "parent_path=VALUES(parent_path)",
      "name=VALUES(name)",
      "kind=VALUES(kind)",
      "data=VALUES(data)",
      "size=VALUES(size)",
      "last_modified=VALUES(last_modified)",
      "media_type=VALUES(media_type)",
    ]
    : [
      "path=excluded.path",
      "parent_path=excluded.parent_path",
      "name=excluded.name",
      "kind=excluded.kind",
      "data=excluded.data",
      "size=excluded.size",
      "last_modified=excluded.last_modified",
      "media_type=excluded.media_type",
    ];
  const conflict = dialect === "mysql"
    ? `ON DUPLICATE KEY UPDATE ${assignments.join(", ")}`
    : `ON CONFLICT (id) DO UPDATE SET ${assignments.join(", ")}`;
  return `INSERT INTO ${q} (${DB0_WRITE_COLUMNS_SQL}) VALUES (${values}) ${conflict}`;
}

/**
 * Opens the db0-backed record store and optionally creates its portable schema.
 *
 * The table uses a SHA-256 path id as its primary key. This avoids MySQL's
 * indexed-TEXT restrictions while preserving arbitrary path lengths in the
 * separate `path` column. Directory queries use `parent_path` and can be indexed
 * by an application migration if its workload needs it. Initialization uses only
 * the SQL subset selected for db0's four current public dialect values.
 *
 * The Database is borrowed unless `disposeDatabase` is true. Callers that manage
 * schema migrations centrally can set `initialize: false` after creating the
 * required table themselves.
 *
 * @example Open only the record-store layer.
 * ```ts
 * const store = await openDb0RecordStore(database, {
 *   table: "opfs_entries",
 *   initialize: true,
 * });
 * ```
 */
export async function openDb0RecordStore(
  database: Db0DatabaseType,
  options: Db0AdapterOptionsType = {},
): Promise<RecordStoreType> {
  const dialect = Db0DialectSchema.parse(database.dialect);
  const table = SqlIdentifierSchema.parse(options.table ?? "opfs_entries");
  const q = quoteIdentifier(table, dialect);
  if (options.initialize ?? true) {
    const result = await database.prepare(getCreateTableSql(table, dialect)).run();
    if (!result.success) {
      throw new Error(`db0 did not confirm initialization of table '${table}'.`);
    }
  }

  const idPlaceholder = placeholders(1)[0];
  const parentPlaceholder = placeholders(1)[0];
  const selectById = database.prepare(
    `SELECT ${DB0_ROW_COLUMNS_SQL} FROM ${q} WHERE id = ${idPlaceholder}`,
  );
  const selectChildren = database.prepare(
    `SELECT ${DB0_ROW_COLUMNS_SQL} FROM ${q} WHERE parent_path = ${parentPlaceholder}`,
  );
  const upsert = database.prepare(getUpsertSql(table, dialect));
  const remove = database.prepare(`DELETE FROM ${q} WHERE id = ${idPlaceholder}`);

  return {
    async get(path) {
      const row = await selectById.get(await getPathId(path));
      return row == null ? null : parseRow(row);
    },
    async set(record) {
      const params: Db0PrimitiveType[] = [
        await getPathId(record.path),
        record.path,
        record.parent,
        record.name,
        record.kind,
        record.kind === "file" ? record.data : null,
        record.kind === "file" ? record.size : 0,
        record.lastModified,
        record.kind === "file" ? record.mediaType : null,
      ];
      const result = await upsert.run(...params);
      if (!result.success) {
        throw new Error(`db0 did not confirm the write for '${record.path}'.`);
      }
    },
    async delete(path) {
      const result = await remove.run(await getPathId(path));
      if (!result.success) {
        throw new Error(`db0 did not confirm removal for '${path}'.`);
      }
    },
    async *list(parent) {
      const rows = await selectChildren.all(parent);
      for (const row of rows) yield parseRow(row);
    },
    async dispose() {
      if (options.disposeDatabase) await database.dispose?.();
    },
  };
}

/**
 * Creates an OPFS-shaped adapter over a db0 Database.
 *
 * The bridge supports db0's `sqlite`, `libsql`, `postgresql`, and `mysql`
 * dialect values. The underlying connector remains owned by db0. The database
 * is borrowed unless `disposeDatabase` is true.
 *
 * @example
 * ```ts
 * const adapter = await createDb0Adapter(database, {
 *   table: "opfs_entries",
 *   initialize: true,
 * });
 * const fs = createFileSystem(adapter);
 * ```
 */
export async function createDb0Adapter(
  database: Db0DatabaseType,
  options: Db0AdapterOptionsType = {},
): Promise<AdapterType> {
  return createRecordAdapter(await openDb0RecordStore(database, options), {
    name: "db0",
    disposeStore: true,
  });
}
