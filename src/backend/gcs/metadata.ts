/**
 * Size limits, object metadata and generation preconditions for the GCS client.
 *
 * GCS sends generations as decimal text. These helpers keep them as text, check
 * the preconditions a caller passes, and turn the JSON object resource into a
 * checked stat.
 *
 * @module
 */
import type { GcsReceiptType } from "./types.ts";
import { toInteger } from "../../check.ts";
import { z } from "zod";
import type { ObjectPutOptionsType, RevisionType } from "../../driver/object.ts";

/** Google Cloud Storage upload alignment, independent of caller buffering policy. */
export const GCS_CHUNK_BYTES = 256 * 1024;

/** Maximum object size supported by the JSON API, in bytes. */
export const GCS_MAX_BYTES = 5 * 1024 ** 4;

/** Object classes accepted by this upload profile; bucket-only classes are excluded. */
export const GcsStorageClassSchema: z.ZodEnum<{
  STANDARD: "STANDARD";
  NEARLINE: "NEARLINE";
  COLDLINE: "COLDLINE";
  ARCHIVE: "ARCHIVE";
}> = z.enum(["STANDARD", "NEARLINE", "COLDLINE", "ARCHIVE"]);

/** Validate known fields while preserving GCS's independently extensible JSON grammar. */
export const GcsMetadataSchema = z.object({
  name: z.string(),
  size: z.string().regex(/^\d+$/),
  generation: z.string().refine(decimal, "Expected a positive decimal string without leading zeroes."),
  metageneration: z.string().refine(decimal, "Expected a positive decimal string without leading zeroes.").optional(),
  // Four bytes leave only two data bits in the sixth Base64 character; reject noncanonical pad bits.
  crc32c: z.string().length(8).regex(/^[A-Za-z0-9+/]{5}[AQgw]==$/).optional(),
  etag: z.string().optional(),
  contentType: z.string().optional(),
  updated: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  storageClass: z.string().min(1).max(128).optional(),
}).passthrough();

/** Positive opaque decimal tokens reject every nondigit, including a final line break. */
export function decimal(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value[0] !== "0" && !/\D/.test(value);
}

/**
 * Generation conditions retain raw ASCII decimal strings, including the existing zero condition.
 * Unlike returned object identities, input conditions preserve leading zeroes; no
 * Number conversion or end-anchor exception may admit other characters or values.
 */
export function generation(revision: RevisionType | undefined): string | undefined {
  if (revision === undefined) return undefined;
  if (
    revision.kind !== "generation" || typeof revision.value !== "string" ||
    revision.value.length === 0 || /\D/.test(revision.value)
  ) {
    throw new TypeError("GCS conditions require a decimal generation revision, not an ETag.");
  }
  return revision.value;
}

/**
 * Metadata tokens identify only one object's generation, so never send an unpaired guard.
 *
 * Validate before credentials, transport or source borrowing. Decimal text remains
 * opaque; zero belongs only to generation create-only conditions, not metadata guards.
 */
export function metageneration(value: string | undefined, version: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!decimal(value)) {
    throw new TypeError("GCS metadata conditions require a positive decimal string.");
  }
  if (!decimal(version)) {
    throw new TypeError("GCS metadata conditions require a positive generation revision.");
  }
  return value;
}

/** GCS JSON writes use generation preconditions; an ETag is a different contract. */
export function condition(
  options: Pick<ObjectPutOptionsType, "revision" | "ifMatch" | "ifNoneMatch">,
): string | undefined {
  if (options.ifMatch !== undefined || (options.ifNoneMatch !== undefined && options.ifNoneMatch !== "*")) {
    throw new TypeError("GCS writes require a generation revision or ifNoneMatch: '*'.");
  }
  const value = generation(options.revision);
  if (value !== undefined && options.ifNoneMatch !== undefined) throw new TypeError("Conflicting GCS preconditions.");
  return options.ifNoneMatch === "*" ? "0" : value;
}

/** Attribute only the completely validated operation response, not a later current HEAD. */
export function metadata(value: unknown, key?: string): GcsReceiptType & { readonly key: string } {
  const data = GcsMetadataSchema.parse(value);
  if (key !== undefined && data.name !== key) throw new TypeError("GCS acknowledgement names a different object.");
  const size = Number(data.size);
  toInteger(size, "Object size", GCS_MAX_BYTES);
  const modified = data.updated === undefined ? undefined : Date.parse(data.updated);
  if (modified !== undefined && !Number.isFinite(modified)) throw new TypeError("Invalid GCS update timestamp.");
  return {
    key: data.name,
    size,
    version: data.generation,
    revision: { kind: "generation", value: data.generation },
    ...(data.storageClass === undefined ? {} : { storageClass: data.storageClass }),
    ...(data.metageneration === undefined ? {} : { metageneration: data.metageneration }),
    ...(data.crc32c === undefined ? {} : { crc32c: data.crc32c }),
    ...(data.etag === undefined ? {} : { etag: data.etag }),
    ...(data.contentType === undefined ? {} : { mediaType: data.contentType }),
    ...(modified === undefined ? {} : { lastModified: modified }),
    ...(data.metadata === undefined ? {} : { metadata: data.metadata }),
  };
}
