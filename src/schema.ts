import { z } from "zod";

/**
 * Canonical virtual path stored and exchanged by adapters.
 *
 * Public path-taking APIs also accept relative and non-canonical input because
 * `normalizePath()` resolves it first. `PathSchema` is for already-normalized
 * values at persistence and adapter seams.
 */
export const PathSchema = z.string().refine(
  (value: string) =>
    value === "/" || (
      value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.includes("//") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value.split("/").slice(1).every((part: string) => part.length > 0 && part !== "." && part !== "..")
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
 * How one operation is provided by the selected storage stack.
 *
 * `native` means the immediate backend performs the operation directly.
 * `emulated` means the facade composes weaker primitives. `partitioned` means
 * the logical operation is preserved by splitting one value into multiple
 * provider records or blocks. `unsupported` means no safe implementation is
 * available for the selected stack.
 */
export const SupportModeSchema = z.enum(["native", "emulated", "partitioned", "unsupported"]);

/** A validated storage support mode. */
export type SupportModeType = z.output<typeof SupportModeSchema>;

/**
 * Metrics collection cost selected for one filesystem or protocol client.
 *
 * `basic` counts operations, bytes, failures, and chosen native/emulated paths.
 * `timing` also reads the monotonic clock around operations. `none` removes
 * metrics bookkeeping from hot paths when the caller is measuring raw overhead.
 */
export const MetricsModeSchema = z.enum(["none", "basic", "timing"]);

/** A validated metrics collection mode. */
export type MetricsModeType = z.output<typeof MetricsModeSchema>;

/**
 * Physical partition policy for backends with a smaller value limit than the
 * logical file size the application wants to expose.
 */
export const PartitionModeSchema = z.enum(["never", "auto", "always"]);

/** A validated physical partition policy. */
export type PartitionModeType = z.output<typeof PartitionModeSchema>;

/**
 * Inspectable physical layout used when one logical file spans provider values.
 *
 * `thresholdBytes` is the logical size where `auto` starts partitioning. When
 * omitted, callers can use `partBytes` as the conservative threshold. `stream`
 * means native stream writes use this layout so input size does not determine
 * facade memory growth.
 */
export const AdapterPartitionSchema = z.object({
  /** Partitioning policy selected for this adapter. */
  mode: PartitionModeSchema,
  /** Physical part or block size used by the layout. */
  partBytes: z.number().int().positive(),
  /** Logical size where `auto` starts partitioning when the adapter knows it. */
  thresholdBytes: z.number().int().positive().optional(),
  /** Whether streamed writes already use the partitioned layout. */
  stream: z.boolean().optional(),
  /** Maximum physical part or block count when the adapter knows it. */
  maxParts: z.number().int().positive().optional(),
  /** Stable name of the physical layout strategy. */
  layout: z.string().min(1),
}).strict();

/** A validated physical partition layout. */
export type AdapterPartitionType = z.output<typeof AdapterPartitionSchema>;

/**
 * Optional backend limits that can be inspected before work begins.
 *
 * Missing values mean the adapter cannot state a portable hard limit. They do
 * not mean unlimited. Provider-specific clients can expose additional limits
 * through their own public constants and request planners.
 */
export const AdapterLimitsSchema = z.object({
  /** Maximum logical file size accepted by this configured adapter. */
  maxFileBytes: z.number().int().positive().optional(),
  /** Maximum materialized value accepted by one physical backend record. */
  maxValueBytes: z.number().int().positive().optional(),
  /** Maximum serialized key size when the backend has one. */
  maxKeyBytes: z.number().int().positive().optional(),
  /** Minimum legal provider part/block size when multipart work is used. */
  minPartBytes: z.number().int().positive().optional(),
  /** Maximum legal provider part/block size. */
  maxPartBytes: z.number().int().positive().optional(),
  /** Maximum provider part/block count for one logical object. */
  maxParts: z.number().int().positive().optional(),
  /** Maximum useful provider concurrency known by this adapter. */
  maxConcurrency: z.number().int().positive().optional(),
  /** Maximum bytes in one transactional/batched provider mutation. */
  maxBatchBytes: z.number().int().positive().optional(),
}).strict();

/** Portable hard limits known by one configured adapter. */
export type AdapterLimitsType = z.output<typeof AdapterLimitsSchema>;

/**
 * Performance routes that the filesystem facade can deliberately bypass.
 *
 * Every field defaults to true. Disabling a route forces the semantically safe
 * fallback where one exists. This is useful for differential testing and for
 * applications that prefer a slower but more observable or more portable path.
 */
export const OptimizationSchema = z.object({
  /** Use adapter-native streaming reads instead of materialized `readFile()`. */
  streamRead: z.boolean(),
  /** Use adapter-native streaming writes when the requested mode supports them. */
  streamWrite: z.boolean(),
  /** Forward byte ranges directly instead of materializing and slicing locally. */
  rangeRead: z.boolean(),
  /** Use adapter-native/server-side copy instead of read plus write. */
  nativeCopy: z.boolean(),
  /** Use adapter-native move/rename instead of copy then remove. */
  nativeMove: z.boolean(),
}).strict();

/** Resolved performance-route policy for one filesystem facade. */
export type OptimizationType = z.output<typeof OptimizationSchema>;

/**
 * Stable adapter capability description.
 *
 * These flags describe native adapter operations, not operations that the
 * facade can emulate. `streamWriteModes` is intentionally mode-specific: an
 * object store can stream a complete replacement while append/update still
 * require a read-modify-write cycle. `nativeCopy` identifies server-side or
 * host-native copy so the facade does not move bytes through JavaScript when
 * the backend can copy them directly.
 */
export const AdapterCapabilitiesSchema = z.object({
  /** Adapter can materialize file bytes through `readFile()`. */
  read: z.boolean(),
  /** Adapter can commit materialized file bytes through `writeFile()`. */
  write: z.boolean(),
  /** Adapter can open a native/bounded provider stream without facade materialization. */
  streamRead: z.boolean(),
  /** Write modes that `writeStream()` can perform without facade materialization. */
  streamWriteModes: z.array(WriteModeSchema).readonly(),
  /** Adapter can satisfy byte ranges without reading the complete file first. */
  rangeRead: z.boolean(),
  /** Adapter can copy bytes without routing them through the filesystem facade. */
  nativeCopy: z.boolean(),
  /** Adapter can move/rename through one backend-native operation. */
  nativeMove: z.boolean(),
  /** Adapter exposes a long-lived asynchronous positional writer. */
  positionalWrite: z.boolean(),
  /** Adapter exposes a synchronous random-access file resource. */
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
  /** Persistence format version used to reject incompatible record layouts. */
  version: RecordVersionSchema,
  /** Canonical virtual path and durable logical record identity. */
  path: PathSchema,
  /** Canonical direct-parent path indexed by listing-oriented backends. */
  parent: PathSchema,
  /** Final path segment presented by directory iteration. */
  name: z.string(),
  /** Last modification time represented as Unix epoch milliseconds. */
  lastModified: z.number().int().nonnegative(),
});

/** Persisted directory record used by record-store adapters. */
export const DirectoryRecordSchema = RecordBaseSchema.extend({
  /** Discriminator that prevents a directory row from carrying file bytes. */
  kind: z.literal("directory"),
});

/** A validated persisted directory record. */
export type DirectoryRecordType = z.output<typeof DirectoryRecordSchema>;

/** Persisted file record used by record-store adapters. */
export const FileRecordSchema = RecordBaseSchema.extend({
  /** Discriminator that selects the file-record branch. */
  kind: z.literal("file"),
  /** Base64 file body used by JSON/document/SQL-compatible record stores. */
  data: z.string(),
  /** Decoded byte length retained without re-decoding `data` during stat calls. */
  size: z.number().int().nonnegative(),
  /** Media type retained by backends that can preserve file metadata. */
  mediaType: z.string(),
});

/** A validated persisted file record. */
export type FileRecordType = z.output<typeof FileRecordSchema>;

/**
 * Persisted record format shared by RxDB, unstorage, db0, and Drizzle record drivers.
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

/** Storage family owned by one backend driver. */
export const DriverKindSchema = z.enum(["file", "record", "object"]);

/** A validated backend driver family. */
export type DriverKindType = z.output<typeof DriverKindSchema>;

/** Why one driver limit exists. */
export const LimitKindSchema = z.enum(["hard", "policy", "dynamic"]);

/** A validated limit kind. */
export type LimitKindType = z.output<typeof LimitKindSchema>;

/** Layer that supplied one limit value. */
export const LimitSourceSchema = z.enum(["provider", "implementation", "user", "probe"]);

/** A validated limit source. */
export type LimitSourceType = z.output<typeof LimitSourceSchema>;

/** Unit used by one numeric limit. */
export const LimitUnitSchema = z.enum(["bytes", "count", "milliseconds", "operations"]);

/** A validated limit unit. */
export type LimitUnitType = z.output<typeof LimitUnitSchema>;

/**
 * One inspectable storage limit with explicit provenance.
 *
 * A hard provider limit is not interchangeable with a project safety policy or
 * a user-selected ceiling. `value` can be absent only for a dynamic limit whose
 * current value has not been probed.
 */
export const LimitSchema = z.object({
  /** Stable machine-readable limit code. */
  code: z.string().min(1),
  /** Whether the limit is hard, policy-driven, or dynamic. */
  kind: LimitKindSchema,
  /** Layer that supplied the limit value. */
  source: LimitSourceSchema,
  /** Unit used by the numeric value. */
  unit: LimitUnitSchema,
  /** Current numeric limit when known. */
  value: z.number().nonnegative().optional(),
  /** Human-readable context for diagnostics. */
  detail: z.string().min(1).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.value === undefined && value.kind !== "dynamic") {
    ctx.addIssue({ code: "custom", message: "Only dynamic limits can omit their current value." });
  }
});

/** A validated storage limit. */
export type LimitType = z.output<typeof LimitSchema>;

/** Current state of one driver requirement. */
export const RequirementStateSchema = z.enum(["available", "missing", "unknown"]);

/** A validated requirement state. */
export type RequirementStateType = z.output<typeof RequirementStateSchema>;

/**
 * One runtime, provider, permission, or configuration requirement.
 *
 * Definitions can report `unknown` before probing. Configured drivers should
 * prefer `available` or `missing` when the state is already known.
 */
export const RequirementSchema = z.object({
  /** Stable machine-readable requirement code. */
  code: z.string().min(1),
  /** Current known availability state. */
  state: RequirementStateSchema,
  /** Concrete reason when the requirement is missing. */
  reason: z.string().min(1).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.state === "missing" && value.reason === undefined) {
    ctx.addIssue({ code: "custom", message: "Missing requirements need a concrete reason." });
  }
});

/** A validated driver requirement. */
export type RequirementType = z.output<typeof RequirementSchema>;

/** Ownership state for one configured driver backend resource. */
export const DriverOwnershipSchema = z.enum(["none", "borrowed", "owned"]);

/** A validated configured-driver backend ownership state. */
export type DriverOwnershipType = z.output<typeof DriverOwnershipSchema>;

/**
 * One independently controllable driver optimization.
 *
 * `changesBehavior` means request count, failure timing, storage layout,
 * consistency, atomicity, or another observable property can differ when the
 * optimization is enabled. Such optimizations must be disableable.
 */
export const DriverOptimizationSchema = z.object({
  /** Stable machine-readable optimization code. */
  code: z.string().min(1),
  /** Current enabled state. */
  enabled: z.boolean(),
  /** Whether this optimization changes observable behavior. */
  changesBehavior: z.boolean(),
  /** Whether callers can turn this optimization off. */
  disableable: z.boolean(),
  /** Human-readable detail for diagnostics or documentation. */
  detail: z.string().min(1).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.changesBehavior && !value.disableable) {
    ctx.addIssue({ code: "custom", message: "Behavior-changing optimizations must be disableable." });
  }
});

/** A validated driver optimization declaration. */
export type DriverOptimizationType = z.output<typeof DriverOptimizationSchema>;
