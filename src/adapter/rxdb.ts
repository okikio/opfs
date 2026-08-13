import type { AdapterType } from "./definition.ts";
import { createRecordAdapter, type RecordStoreType } from "./record.ts";
import { FileSystemError } from "../error.ts";
import { RecordSchema, type RecordType } from "../schema.ts";

/**
 * Maximum canonical path length encoded in the exported RxDB primary/index schema.
 *
 * RxDB requires `maxLength` on indexed string fields. Keeping one constant makes
 * runtime validation and the exported collection schema agree exactly.
 */
const RXDB_PATH_MAX_LENGTH = 4096;

/** RxDB document methods used by the bridge. */
export interface RxDbDocumentType {
  /** Returns document data without RxDB revision metadata. */
  toJSON(withRevisionAndAttachments?: false): unknown;
  /** Removes the latest revision safely when concurrent writes are possible. */
  incrementalRemove(): Promise<unknown>;
}

/** RxDB query result shape used by the bridge. */
export interface RxDbQueryType<T> {
  /** Executes the query against the collection's configured RxStorage. */
  exec(): Promise<T>;
}

/**
 * Structural subset of RxCollection used by this adapter.
 *
 * RxDB collections sit above `RxStorage`, so the same bridge works when the
 * database was created with memory, IndexedDB, OPFS, filesystem, SQLite,
 * DenoKV, MongoDB, or another compatible RxStorage implementation.
 */
export interface RxDbCollectionType {
  /** Finds one document by its primary `path`. */
  findOne(primary: string): RxDbQueryType<RxDbDocumentType | null>;
  /** Finds records by the indexed `parent` field. */
  find(query: { readonly selector: { readonly parent: string } }): RxDbQueryType<RxDbDocumentType[]>;
  /** Inserts or incrementally replaces one path record. */
  incrementalUpsert(record: RecordType): Promise<unknown>;
}

/**
 * RxJSONSchema to use for the collection supplied to {@link createRxDbAdapter}.
 *
 * `path` is the primary key and `parent` is indexed because directory reads are
 * direct-parent queries. File bytes remain base64 strings to keep documents
 * structured-cloneable across every RxStorage transport.
 */
export const RxDbRecordJsonSchema = Object.freeze({
  title: "OPFS filesystem record",
  description: "One canonical file or directory record used by the @okikio/opfs RxDB adapter.",
  version: 0,
  primaryKey: "path",
  type: "object",
  properties: {
    version: {
      type: "number",
      description: "@okikio/opfs record format version. This is independent of the RxDB schema version.",
      minimum: 1,
      maximum: 1,
      multipleOf: 1,
    },
    path: {
      type: "string",
      description: "Canonical virtual filesystem path and RxDB primary key.",
      maxLength: RXDB_PATH_MAX_LENGTH,
    },
    parent: {
      type: "string",
      description: "Canonical direct-parent path used for directory listing queries.",
      maxLength: RXDB_PATH_MAX_LENGTH,
    },
    name: {
      type: "string",
      description: "Final file or directory name without parent path components.",
    },
    kind: {
      type: "string",
      description: "Filesystem entry discriminator.",
      enum: ["file", "directory"],
    },
    data: {
      type: "string",
      description: "Base64 file bytes. Required only when kind is file.",
    },
    size: {
      type: "number",
      description: "Decoded file byte length. Required only when kind is file.",
      minimum: 0,
      multipleOf: 1,
    },
    lastModified: {
      type: "number",
      description: "Last-modified Unix epoch milliseconds.",
      minimum: 0,
      multipleOf: 1,
    },
    mediaType: {
      type: "string",
      description: "File media type, or an empty string when unknown. Required only when kind is file.",
    },
  },
  required: ["version", "path", "parent", "name", "kind", "lastModified"],
  oneOf: [
    {
      properties: { kind: { enum: ["directory"] } },
      required: ["kind"],
    },
    {
      properties: { kind: { enum: ["file"] } },
      required: ["kind", "data", "size", "mediaType"],
    },
  ],
  indexes: ["parent"],
} as const);

/** Rejects paths that the exported RxDB indexed-string schema cannot store. */
function assertRxDbPath(path: string): void {
  if (path.length <= RXDB_PATH_MAX_LENGTH) return;
  throw new FileSystemError(
    "invalid-path",
    "rxdb",
    path,
    `RxDB adapter paths cannot exceed ${RXDB_PATH_MAX_LENGTH} characters.`,
  );
}

/**
 * Creates the record-store projection over an existing RxDB collection.
 *
 * This is the lower-level integration point used by {@link createRxDbAdapter}.
 * The collection remains caller-owned. Reads validate every document through
 * {@link RecordSchema}; writes use RxDB incremental operations so the bridge does
 * not replace RxDB's own revision/concurrency semantics.
 *
 * @example Reuse the record store inside another adapter wrapper.
 * ```ts
 * const store = createRxDbRecordStore(database.files);
 * const adapter = createRecordAdapter(store, { name: "rxdb" });
 * ```
 */
export function createRxDbRecordStore(collection: RxDbCollectionType): RecordStoreType {
  return {
    async get(path) {
      assertRxDbPath(path);
      const document = await collection.findOne(path).exec();
      return document === null ? null : RecordSchema.parse(document.toJSON());
    },
    async set(record) {
      assertRxDbPath(record.path);
      assertRxDbPath(record.parent);
      await collection.incrementalUpsert(record);
    },
    async delete(path) {
      assertRxDbPath(path);
      const document = await collection.findOne(path).exec();
      if (document !== null) await document.incrementalRemove();
    },
    async *list(parent) {
      assertRxDbPath(parent);
      const documents = await collection.find({ selector: { parent } }).exec();
      for (const document of documents) yield RecordSchema.parse(document.toJSON());
    },
  };
}

/**
 * Creates an OPFS-shaped adapter over an RxDB collection.
 *
 * The collection is borrowed. Closing this adapter never closes the RxDatabase
 * because the database can own many unrelated collections and replications. The
 * collection must use {@link RxDbRecordJsonSchema}.
 *
 * @example
 * ```ts
 * await database.addCollections({ files: { schema: RxDbRecordJsonSchema } });
 * const fs = createFileSystem(createRxDbAdapter(database.files));
 * ```
 */
export function createRxDbAdapter(collection: RxDbCollectionType): AdapterType {
  return createRecordAdapter(createRxDbRecordStore(collection), { name: "rxdb" });
}
