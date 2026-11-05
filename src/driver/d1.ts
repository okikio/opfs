/** Borrowed Cloudflare D1 bindings with a versioned, bounded record layout. @module */
import { z } from "zod";
import { RecordMetadataSchema, RecordSchema, SqlIdentifierSchema } from "../schema.ts";
import type { RecordType } from "../schema.ts";
import type { PathType } from "../path.ts";
import { defineRecordDriver } from "./record.ts";
import type { RecordBackendType, RecordDriverType, RecordListType } from "./record.ts";

/** Implementation payload ceiling; base64 and metadata must still fit the conservative physical-row budget. */
export const D1_FILE_BYTES = 1024 * 1024;
/** Conservative implementation ceiling below D1's documented 2,000,000-byte row/string limit. */
export const D1_ROW_BYTES = 1_500_000;
/** This record profile binds only text, safe integers and null, independently of D1's wider native parameter API. */
export type D1ParameterType = string | number | null;
/** Native success is checked for reads and mutations; metadata is not interpreted as a transaction or revision receipt. */
export interface D1ResultType {
  readonly success: boolean;
  readonly results?: readonly unknown[] | null;
  readonly error?: string;
}
/** Narrow prepared-statement surface consumed by this driver. bind() returns an operation-local statement. */
export interface D1StatementType {
  bind(...values: D1ParameterType[]): D1StatementType;
  all(): Promise<D1ResultType>;
  run(): Promise<D1ResultType>;
}
/** Application-injected D1 database or session. The library neither acquires nor closes it. */
export interface D1BindingType {
  prepare(sql: string): D1StatementType;
}
/** Explicit storage layout and bounded query policies; none read ambient Worker configuration. */
export interface D1DriverOptionsType {
  /** Exclusively owned version-one table. Defaults to opfs_d1_v1; no existing table is automatically migrated. */
  readonly table?: string;
  /** Create table and direct-parent index. Defaults to true. Partial setup is not rolled back or dropped. */
  readonly initialize?: boolean;
  /** Lower the 1 MiB decoded-file profile ceiling. Zero admits empty files only. */
  readonly maxFileBytes?: number;
  /** Metadata rows per query, 1–128. Defaults to 64. Native binding allocation occurs before return validation. */
  readonly pageSize?: number;
  /** Maximum yielded records in one direct-child iteration; default 10,000, maximum 1,000,000. Overflow throws. */
  readonly maxListEntries?: number;
}
/** A native query returned failure instead of a successful result; its provider text remains available. */
export class D1Error extends Error {
  readonly providerError: string | undefined;
  constructor(operation: string, result: D1ResultType) {
    super(`D1 did not confirm ${operation}.`);
    this.name = "D1Error";
    this.providerError = result.error;
  }
}
/** An invoked mutation lacks an acknowledged outcome. The driver never automatically replays it. */
export class D1MutationError extends Error {
  readonly outcome = "unknown";
  constructor(cause: unknown) {
    super("D1 mutation outcome is unknown; inspect the exact row before retrying.", { cause });
    this.name = "D1MutationError";
  }
}
/** Physical SQL columns remain distinct from the canonical record fields and are validated before mapping. */
const RowSchema = z.strictObject({
  version: z.literal(1),
  path: z.string().max(4096),
  parent_path: z.string().max(4096),
  name: z.string().max(4096),
  kind: z.enum(["directory", "file"]),
  data: z.string().max(4 * Math.ceil(D1_FILE_BYTES / 3)).nullable(),
  size: z.number().int().nonnegative().max(D1_FILE_BYTES),
  last_modified: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  media_type: z.string().max(1024).nullable(),
});
/** Listing and stat never select payload text, so their schema has no data property. */
const RowMetadataSchema = RowSchema.omit({ data: true });
/** Bounded integer policies are captured before prepare() or schema initialization. */
function integer(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new RangeError(`Invalid D1 ${label}.`);
  return value;
}
/** Preserve literal provider identity and bound UTF-8 parameters without replacement encoding. */
function text(value: string, maximum: number): number {
  if (value.length > maximum) throw new RangeError("D1 text exceeds its byte policy.");
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) throw new TypeError("D1 text contains an unpaired surrogate.");
  }
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > maximum) throw new RangeError("D1 text exceeds its UTF-8 byte policy.");
  return bytes;
}
/** Compare UTF-8 octets, matching SQLite BINARY rather than JavaScript UTF-16 ordering for non-BMP names. */
function after(value: string, cursor: string): boolean {
  const left = new TextEncoder().encode(value);
  const right = new TextEncoder().encode(cursor);
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return left[index]! > right[index]!;
  }
  return left.length > right.length;
}
/** Native row parsing enforces schema version, canonical identity, numeric precision and complete physical bounds. */
function parse(value: unknown, payload: true, maximum: number): RecordType;
function parse(value: unknown, payload: false, maximum: number): RecordListType;
function parse(value: unknown, payload: boolean, maximum: number): RecordType | RecordListType {
  const row = payload ? RowSchema.parse(value) : RowMetadataSchema.parse(value);
  let bytes = 256;
  for (const item of [row.path, row.parent_path, row.name]) bytes += text(item, 4096);
  if (row.media_type !== null) bytes += text(row.media_type, 1024);
  if (row.kind === "file" && row.size > maximum) {
    throw new RangeError("Stored D1 file exceeds its configured byte policy.");
  }
  const base = {
    version: row.version,
    path: row.path,
    parent: row.parent_path,
    name: row.name,
    kind: row.kind,
    lastModified: row.last_modified,
  };
  if (row.kind === "directory") {
    if (row.size !== 0 || row.media_type !== null || ("data" in row && row.data !== null)) {
      throw new TypeError("D1 directory carries file fields.");
    }
    return RecordMetadataSchema.parse(base);
  }
  const file = { ...base, kind: "file", size: row.size, mediaType: row.media_type };
  if (!payload) return RecordMetadataSchema.parse(file);
  if (!("data" in row) || typeof row.data !== "string") throw new TypeError("D1 file lacks payload text.");
  bytes += row.data.length;
  if (bytes > D1_ROW_BYTES) throw new RangeError("D1 row exceeds its conservative physical-byte budget.");
  return RecordSchema.parse({ ...file, data: row.data });
}
/**
 * Open a versioned D1 table as canonical records. Each replacement is one SQL
 * UPSERT; compound filesystem operations remain cooperative read/replace.
 * Metadata listings use indexed keyset pages and never select payload columns.
 */
export async function createD1Driver(
  database: D1BindingType,
  options: D1DriverOptionsType = {},
): Promise<RecordDriverType> {
  const table = SqlIdentifierSchema.parse(options.table ?? "opfs_d1_v1");
  if (table.length > 64) throw new RangeError("D1 table identifier exceeds the 64-character profile.");
  const q = `"${table}"`;
  const maximum = integer(options.maxFileBytes ?? D1_FILE_BYTES, D1_FILE_BYTES, "file policy");
  const pageSize = integer(options.pageSize ?? 64, 128, "page size");
  if (pageSize === 0) throw new RangeError("D1 page size must be positive.");
  const maxListEntries = integer(options.maxListEntries ?? 10_000, 1_000_000, "listing entry policy");
  /** Every D1 API result must affirm success; successful Promise settlement alone is insufficient. */
  function checked(result: D1ResultType, operation: string): D1ResultType {
    if (result.success !== true) throw new D1Error(operation, result);
    return result;
  }
  if (options.initialize ?? true) {
    checked(
      await database.prepare(
        `CREATE TABLE IF NOT EXISTS ${q} (version INTEGER NOT NULL CHECK(version=1), path TEXT COLLATE BINARY PRIMARY KEY NOT NULL, parent_path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('file','directory')), data TEXT, size INTEGER NOT NULL, last_modified INTEGER NOT NULL, media_type TEXT)`,
      ).run(),
      "table initialization",
    );
    checked(
      await database.prepare(
        `CREATE INDEX IF NOT EXISTS "${table}_parent_path" ON ${q}(parent_path, path COLLATE BINARY)`,
      ).run(),
      "index initialization",
    );
  }
  const columns = "version, path, parent_path, name, kind, size, last_modified, media_type";
  const get = database.prepare(`SELECT ${columns}, data FROM ${q} WHERE path = ? LIMIT 1`);
  const stat = database.prepare(`SELECT ${columns} FROM ${q} WHERE path = ? LIMIT 1`);
  const list = database.prepare(
    `SELECT ${columns} FROM ${q} WHERE parent_path = ? AND path <> parent_path AND path > ? COLLATE BINARY ORDER BY path COLLATE BINARY LIMIT ?`,
  );
  const put = database.prepare(
    `INSERT INTO ${q} (version,path,parent_path,name,kind,data,size,last_modified,media_type) VALUES (1,?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET version=excluded.version,parent_path=excluded.parent_path,name=excluded.name,kind=excluded.kind,data=excluded.data,size=excluded.size,last_modified=excluded.last_modified,media_type=excluded.media_type`,
  );
  const remove = database.prepare(`DELETE FROM ${q} WHERE path = ?`);
  /** SELECT arrays are bounded in SQL before opaque binding allocation, then checked again at return. */
  async function rows(
    statement: D1StatementType,
    values: D1ParameterType[],
    limit: number,
  ): Promise<readonly unknown[]> {
    const result = checked(await statement.bind(...values).all(), "query");
    if (!Array.isArray(result.results) || result.results.length > limit) {
      throw new TypeError("D1 returned an unbounded or missing row array.");
    }
    return result.results;
  }
  /** Protect acknowledgement uncertainty without guessing whether a thrown binding already committed its SQL. */
  async function mutate(statement: D1StatementType, values: D1ParameterType[]): Promise<void> {
    const bound = statement.bind(...values);
    try {
      checked(await bound.run(), "mutation");
    } catch (cause) {
      throw new D1MutationError(cause);
    }
  }
  const backend: RecordBackendType = {
    async get(path) {
      text(path, 4096);
      const found = await rows(get, [path], 1);
      return found.length === 0 ? null : parse(found[0], true, maximum);
    },
    async stat(path) {
      text(path, 4096);
      const found = await rows(stat, [path], 1);
      return found.length === 0 ? null : parse(found[0], false, maximum);
    },
    async set(value) {
      const record = RecordSchema.parse(value);
      const row = {
        version: record.version,
        path: record.path,
        parent_path: record.parent,
        name: record.name,
        kind: record.kind,
        data: record.kind === "file" ? record.data : null,
        size: record.kind === "file" ? record.size : 0,
        last_modified: record.lastModified,
        media_type: record.kind === "file" ? record.mediaType : null,
      };
      parse(row, true, maximum);
      await mutate(put, [
        row.path,
        row.parent_path,
        row.name,
        row.kind,
        row.data,
        row.size,
        row.last_modified,
        row.media_type,
      ]);
    },
    async delete(path) {
      text(path, 4096);
      await mutate(remove, [path]);
    },
    async *list(parent: PathType) {
      text(parent, 4096);
      let cursor = "";
      let count = 0;
      while (true) {
        const limit = Math.min(pageSize, maxListEntries - count + 1);
        const page = await rows(list, [parent, cursor, limit], limit);
        for (const raw of page) {
          const record = parse(raw, false, maximum);
          if (record.parent !== parent || !after(record.path, cursor)) {
            throw new TypeError("D1 child page escaped its parent or did not advance.");
          }
          if (count >= maxListEntries) {
            throw new RangeError("D1 directory exceeds maxListEntries; listing is incomplete.");
          }
          cursor = record.path;
          count++;
          yield record;
        }
        if (page.length < limit) return;
      }
    },
  };
  return defineRecordDriver(backend, {
    name: "d1",
    ownership: "borrowed",
    capabilities: { replacement: "atomic", transactions: false, binary: false },
    requirements: [{ code: "cloudflare-d1-binding", state: "available" }],
    limits: [
      { code: "row-bytes", kind: "hard", source: "provider", unit: "bytes", value: 2_000_000 },
      { code: "bound-parameters", kind: "hard", source: "provider", unit: "count", value: 100 },
      { code: "statement-bytes", kind: "hard", source: "provider", unit: "bytes", value: 100_000 },

      { code: "row-bytes", kind: "hard", source: "implementation", unit: "bytes", value: D1_ROW_BYTES },
      // The generic record planner selects its first file limit; make the effective policy explicit there.
      { code: "file-bytes", kind: "policy", source: "user", unit: "bytes", value: maximum },
      { code: "file-bytes", kind: "hard", source: "implementation", unit: "bytes", value: D1_FILE_BYTES },
      { code: "list-page-entries", kind: "policy", source: "user", unit: "count", value: pageSize },
      { code: "list-entries", kind: "policy", source: "user", unit: "count", value: maxListEntries },
    ],
  });
}
