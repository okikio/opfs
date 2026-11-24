/**
 * Schemas and limits for Glacier credentials, jobs, vaults, uploads and parts.
 *
 * @module
 */
import { z } from "zod";

/** Native tree leaf and minimum multipart part size. */
export const GLACIER_MIB = 1024 * 1024;

/** Provider bounds; these do not authorize materializing a 4 GiB part. */
export const GLACIER_LIMITS: Readonly<{
  maxParts: number;
  minPartBytes: number;
  maxPartBytes: number;
  maxPage: number;
  maxJobPage: number;
}> = Object.freeze({
  maxParts: 10000,
  minPartBytes: GLACIER_MIB,
  maxPartBytes: 4 * 1024 ** 3,
  maxPage: 1000,
  maxJobPage: 50,
});

/** Static credentials are caller-owned; the client performs no environment discovery. */
export const GlacierCredentialsSchema: z.ZodObject<{
  accessKeyId: z.ZodString;
  secretAccessKey: z.ZodString;
  sessionToken: z.ZodOptional<z.ZodString>;
}, z.core.$strict> = z.object({
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  sessionToken: z.string().min(1).optional(),
}).strict();

/** Access key, secret and optional session token for SigV4 signing. */
export type GlacierCredentialsType = z.infer<typeof GlacierCredentialsSchema>;

export const HashSchema: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>> = z.string().length(64).refine(
  (value) => !/[^0-9a-fA-F]/.test(value),
  "Expected a 32-byte hexadecimal digest.",
).transform((value) => value.toLowerCase());

export const SizeSchema: z.ZodNumber = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Scan without allocating a token-sized character array; malformed Unicode cannot round-trip through URI encoding. */
export function tokenText(value: string, minimum: number): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < minimum || code === 127) return false;
  }
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}

export const IdSchema: z.ZodString = z.string().min(1).refine(
  (value) => value !== "." && value !== ".." && tokenText(value, 33),
  "An identity must be well-formed Unicode, without dot segments, whitespace, or control characters.",
);

/** Pagination tokens are opaque query data; spaces are encoded, not interpreted as path separators. */
export const MarkerSchema: z.ZodString = z.string().min(1).refine(
  (value) => tokenText(value, 32),
  "A marker must be well-formed Unicode without control characters.",
);

/** Native jobs preserve action-dependent nulls rather than inventing archive metadata for inventories. */
export const GlacierJobSchema: z.ZodObject<{
  JobId: typeof IdSchema;
  Action: z.ZodEnum<
    { ArchiveRetrieval: "ArchiveRetrieval"; InventoryRetrieval: "InventoryRetrieval"; Select: "Select" }
  >;
  Completed: z.ZodBoolean;
  StatusCode: z.ZodEnum<{ InProgress: "InProgress"; Succeeded: "Succeeded"; Failed: "Failed" }>;
  ArchiveId: z.ZodOptional<z.ZodNullable<typeof IdSchema>>;
  ArchiveSizeInBytes: z.ZodOptional<z.ZodNullable<typeof SizeSchema>>;
  ArchiveSHA256TreeHash: z.ZodOptional<z.ZodNullable<typeof HashSchema>>;
  InventorySizeInBytes: z.ZodOptional<z.ZodNullable<typeof SizeSchema>>;
  RetrievalByteRange: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  SHA256TreeHash: z.ZodOptional<z.ZodNullable<typeof HashSchema>>;
  CreationDate: z.ZodOptional<z.ZodString>;
  CompletionDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  StatusMessage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  NextInventoryRetrievalMarker: z.ZodOptional<z.ZodNullable<typeof MarkerSchema>>;
}, z.core.$loose> = z.object({
  JobId: IdSchema,
  Action: z.enum(["ArchiveRetrieval", "InventoryRetrieval", "Select"]),
  Completed: z.boolean(),
  StatusCode: z.enum(["InProgress", "Succeeded", "Failed"]),
  ArchiveId: IdSchema.nullable().optional(),
  ArchiveSizeInBytes: SizeSchema.nullable().optional(),
  ArchiveSHA256TreeHash: HashSchema.nullable().optional(),
  InventorySizeInBytes: SizeSchema.nullable().optional(),
  RetrievalByteRange: z.string().nullable().optional(),
  SHA256TreeHash: HashSchema.nullable().optional(),
  CreationDate: z.string().optional(),
  CompletionDate: z.string().nullable().optional(),
  StatusMessage: z.string().nullable().optional(),
  NextInventoryRetrievalMarker: MarkerSchema.nullable().optional(),
}).passthrough();

/** Validated native description, including nullable provider observations. */
export type GlacierJobType = z.infer<typeof GlacierJobSchema>;

/** Native vault observations describe a historical inventory, not a live object listing. */
export const GlacierVaultSchema: z.ZodObject<{
  VaultARN: z.ZodString;
  VaultName: z.ZodString;
  CreationDate: z.ZodString;
  LastInventoryDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  NumberOfArchives: typeof SizeSchema;
  SizeInBytes: typeof SizeSchema;
}, z.core.$loose> = z.object({
  VaultARN: z.string().min(1),
  VaultName: z.string().min(1),
  CreationDate: z.string().min(1),
  LastInventoryDate: z.string().nullable().optional(),
  NumberOfArchives: SizeSchema,
  SizeInBytes: SizeSchema,
}).passthrough();

/** Historical vault inventory facts reported by the provider. */
export type GlacierVaultType = z.infer<typeof GlacierVaultSchema>;

/** Multipart upload scope is admitted again on every operation; no hidden live upload state is retained. */
export const GlacierUploadSchema: z.ZodObject<{
  id: typeof IdSchema;
  partSize: typeof SizeSchema;
  location: z.ZodOptional<z.ZodString>;
  requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strict> = z.object({
  id: IdSchema,
  partSize: SizeSchema.positive(),
  /** Initiation receipt metadata remains admissible when passing the returned upload to later operations. */
  location: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
}).strict();

/** Caller-persisted native upload identity and immutable layout. */
export type GlacierUploadType = z.infer<typeof GlacierUploadSchema>;

/** Each part identifies its inclusive original extent and tree hash, not a contiguous commit offset. */
export const GlacierPartSchema: z.ZodObject<{
  start: typeof SizeSchema;
  end: typeof SizeSchema;
  treeHash: typeof HashSchema;
}, z.core.$strict> = z.object({ start: SizeSchema, end: SizeSchema, treeHash: HashSchema }).strict();

/** A native part acknowledgement; its hash is not an independent download verification. */
export type GlacierPartType = z.infer<typeof GlacierPartSchema>;
