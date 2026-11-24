/**
 * Shared request rules for object providers that use ETags.
 *
 * The S3, R2, Azure, Swift, HTTP and WebDAV clients call these helpers so a revision always becomes a real
 * `If-Match` precondition and a request in flight is never changed by later caller mutation. A new ETag-based client can
 * use them to get the same guarantees.
 *
 * @module
 */
import type { ObjectCopyOptionsType, ObjectPutOptionsType, ObjectStatType, RevisionType } from "./driver/object.ts";

/**
 * Returns the ETag a conditional request must match, from a revision, an explicit `ifMatch`, or both.
 *
 * Call it where a provider builds `If-Match`: `const ifMatch = resolveETag(options.revision, options.ifMatch);`.
 * A revision of another kind, an empty ETag, or two different values throw `TypeError`, so a precondition is
 * never silently dropped.
 */
export function resolveETag(revision?: RevisionType, ifMatch?: string): string | undefined {
  if (revision === undefined) return ifMatch;
  if (revision.kind !== "etag" || revision.value.length === 0) {
    throw new TypeError("This protocol requires a nonempty ETag revision.");
  }
  if (ifMatch !== undefined && ifMatch !== revision.value) throw new TypeError("Conflicting ETag preconditions.");
  return revision.value;
}

/**
 * Returns a private copy of put options with any revision resolved into `ifMatch`, for ETag providers.
 *
 * Call it first in an ETag provider's put, before a source read or credential request, and use only the
 * result afterwards: `options = resolveETagPut(options);`. Revision errors then surface before any work.
 */
export function resolveETagPut(options: ObjectPutOptionsType): ObjectPutOptionsType {
  const ifMatch = resolveETag(options.revision, options.ifMatch);
  return { ...snapshotPut(options), ...(ifMatch === undefined ? {} : { ifMatch }) };
}

/**
 * Returns a private copy of copy options with both revisions resolved into `ifMatch` and `sourceIfMatch`.
 *
 * Call it first in an ETag provider's copy: `options = resolveETagCopy(options);`.
 */
export function resolveETagCopy(options: ObjectCopyOptionsType): ObjectCopyOptionsType {
  const ifMatch = resolveETag(options.revision, options.ifMatch);
  const sourceIfMatch = resolveETag(options.sourceRevision, options.sourceIfMatch);
  return {
    ...snapshotCopy(options),
    ...(ifMatch === undefined ? {} : { ifMatch }),
    ...(sourceIfMatch === undefined ? {} : { sourceIfMatch }),
  };
}

/**
 * Returns a private copy of put options, so later caller mutation cannot change a request in flight.
 *
 * Call it once before asynchronous source or credential work and build headers and acknowledgements from the
 * copy: `const request = snapshotPut(options);`. Revision and metadata objects are copied too. The signal
 * stays borrowed, so a later cancellation is still observed.
 */
export function snapshotPut(options: ObjectPutOptionsType): ObjectPutOptionsType {
  return {
    ...options,
    ...(options.revision === undefined ? {} : { revision: { ...options.revision } }),
    ...(options.metadata === undefined ? {} : { metadata: { ...options.metadata } }),
  };
}

/**
 * Returns put options whose media type and metadata are exactly the normalized values sent as headers.
 *
 * Call it after header normalization: `options = applyProperties(options, properties);`. A property missing
 * from `properties` is removed rather than kept from caller input. Preconditions, declared size and the
 * borrowed signal are unchanged.
 */
export function applyProperties(
  options: ObjectPutOptionsType,
  properties: Pick<ObjectStatType, "mediaType" | "metadata">,
): ObjectPutOptionsType {
  const { mediaType: _mediaType, metadata: _metadata, ...policy } = options;
  return {
    ...policy,
    ...(properties.mediaType === undefined ? {} : { mediaType: properties.mediaType }),
    ...(properties.metadata === undefined ? {} : { metadata: properties.metadata }),
  };
}

/** Copies mutable Date conditions as well as scalar policy before reading a source. */
function snapshotCopy(options: ObjectCopyOptionsType): ObjectCopyOptionsType {
  return {
    ...options,
    ...(options.revision === undefined ? {} : { revision: { ...options.revision } }),
    ...(options.sourceRevision === undefined ? {} : { sourceRevision: { ...options.sourceRevision } }),
    ...(options.sourceIfModifiedSince === undefined
      ? {}
      : { sourceIfModifiedSince: new Date(options.sourceIfModifiedSince.getTime()) }),
    ...(options.sourceIfUnmodifiedSince === undefined
      ? {}
      : { sourceIfUnmodifiedSince: new Date(options.sourceIfUnmodifiedSince.getTime()) }),
  };
}
