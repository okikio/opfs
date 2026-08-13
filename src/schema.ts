import { z } from "zod";

/**
 * Canonical virtual path stored and exchanged by adapters.
 *
 * Public path-taking APIs also accept relative and non-canonical input because
 * `normalizePath()` resolves it first. `PathSchema` is for already-normalized
 * values at persistence and adapter seams.
 */
export const PathSchema = z.string().refine(
  (value) => value === "/" || (
    value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("//") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").slice(1).every((part) => part.length > 0 && part !== "." && part !== "..")
  ),
  "Expected a canonical virtual filesystem path.",
);

/** A validated canonical virtual filesystem path. */
export type PathType = z.output<typeof PathSchema>;

/** Stable non-empty diagnostic name assigned to one adapter implementation. */
export const AdapterNameSchema = z.string().min(1);

/** A validated adapter diagnostic name. */
export type AdapterNameType = z.output<typeof AdapterNameSchema>;

/**
 * Valid entry kinds exposed by the filesystem facade and every adapter.
 *
 * The package uses the same two kinds as the File System API. Adapters must not
 * invent a third kind for links, database rows, or provider-specific objects.
 */
export const EntryKindSchema = z.enum(["file", "directory"]);

/** A validated filesystem entry kind. */
export type EntryKindType = z.output<typeof EntryKindSchema>;

/**
 * Execution contexts that can host browser storage access.
 *
 * `worker` is used only when the runtime exposes a generic worker shape but the
 * library cannot prove whether it is dedicated, shared, or service-worker
 * execution. `unknown` means that no supported browser execution context was
 * detected.
 */
export const OpfsContextSchema = z.enum([
  "window",
  "dedicated-worker",
  "shared-worker",
  "service-worker",
  "worker",
  "unknown",
]);

/** A validated browser execution context classification. */
export type OpfsContextType = z.output<typeof OpfsContextSchema>;

/**
 * Mutation coordination policies supported by {@link createFileSystem}.
 *
 * `auto` uses Web Locks when the current realm exposes them. Otherwise it uses
 * an in-realm FIFO lock. `none` disables library coordination and transfers all
 * concurrency responsibility to the caller or adapter.
 */
export const CoordinationModeSchema = z.enum(["auto", "web-locks", "local", "none"]);

/** A validated mutation coordination policy. */
export type CoordinationModeType = z.output<typeof CoordinationModeSchema>;

/**
 * Write modes shared by the facade and adapters.
 *
 * `replace` starts from an empty file. `append` starts at the current end.
 * `update` preserves existing bytes and starts at the requested byte offset.
 */
export const WriteModeSchema = z.enum(["replace", "append", "update"]);

/** A validated file write mode. */
export type WriteModeType = z.output<typeof WriteModeSchema>;

/**
 * Stable adapter capability description.
 *
 * These flags describe native adapter operations, not operations that the
 * facade can emulate. For example, a database adapter can still expose
 * `openReadStream()` through the facade while `streamRead` remains `false`.
 */
export const AdapterCapabilitiesSchema = z.object({
  read: z.boolean(),
  write: z.boolean(),
  streamRead: z.boolean(),
  streamWrite: z.boolean(),
  rangeRead: z.boolean(),
  nativeMove: z.boolean(),
  syncAccess: z.boolean(),
});

/** Native operations implemented by one adapter. */
export type AdapterCapabilitiesType = z.output<typeof AdapterCapabilitiesSchema>;

/**
 * Stable error categories exposed by the package.
 *
 * Adapters map runtime-specific failures into these categories so consumers do
 * not need separate branches for DOMException, Deno, Bun, Node, SQL, and
 * document-database error classes.
 */
export const ErrorCodeSchema = z.enum([
  "unavailable",
  "not-found",
  "already-exists",
  "type-mismatch",
  "invalid-path",
  "invalid-operation",
  "not-supported",
  "locked",
  "quota-exceeded",
  "permission-denied",
  "aborted",
  "too-large",
  "unknown",
]);

/** A validated package error category. */
export type ErrorCodeType = z.output<typeof ErrorCodeSchema>;

/** Version stored with record-backed filesystem entries. */
export const RecordVersionSchema = z.literal(1);

/** Persisted record format version. */
export type RecordVersionType = z.output<typeof RecordVersionSchema>;

/**
 * Fields shared by every persisted record-store entry.
 *
 * The virtual path is the durable identity. `parent` is stored separately so
 * document and SQL backends can list one directory without scanning every
 * record or reconstructing parents from strings.
 */
const RecordBaseSchema = z.object({
  version: RecordVersionSchema,
  path: PathSchema,
  parent: PathSchema,
  name: z.string(),
  lastModified: z.number().int().nonnegative(),
});

/** Persisted directory record used by record-store adapters. */
export const DirectoryRecordSchema = RecordBaseSchema.extend({
  kind: z.literal("directory"),
});

/** A validated persisted directory record. */
export type DirectoryRecordType = z.output<typeof DirectoryRecordSchema>;

/** Persisted file record used by record-store adapters. */
export const FileRecordSchema = RecordBaseSchema.extend({
  kind: z.literal("file"),
  data: z.string(),
  size: z.number().int().nonnegative(),
  mediaType: z.string(),
});

/** A validated persisted file record. */
export type FileRecordType = z.output<typeof FileRecordSchema>;

/**
 * Persisted record format shared by RxDB, unstorage, db0, and Drizzle bridges.
 *
 * File bytes use base64 text because every target ecosystem can preserve JSON
 * strings. This costs about one third more storage than raw bytes. Native file
 * adapters do not use this format.
 */
export const RecordSchema = z.discriminatedUnion("kind", [DirectoryRecordSchema, FileRecordSchema]);

/** A validated record-store filesystem entry. */
export type RecordType = z.output<typeof RecordSchema>;

/** SQL dialects currently exposed by db0's public Database contract. */
export const Db0DialectSchema = z.enum(["mysql", "postgresql", "sqlite", "libsql"]);

/** A validated db0 SQL dialect. */
export type Db0DialectType = z.output<typeof Db0DialectSchema>;

/** Safe unqualified SQL identifier used for adapter-owned table names. */
export const SqlIdentifierSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

/** A validated unqualified SQL identifier. */
export type SqlIdentifierType = z.output<typeof SqlIdentifierSchema>;
