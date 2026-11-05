import type {
  ObjectCopyOptionsType,
  ObjectPutOptionsType,
  ObjectRevisionType,
  ObjectStatType,
} from "./driver/object.ts";

/** ETag protocols must never silently discard a different provider's revision. */
export function objectETag(revision?: ObjectRevisionType, ifMatch?: string): string | undefined {
  if (revision === undefined) return ifMatch;
  if (revision.kind !== "etag" || revision.value.length === 0) {
    throw new TypeError("This protocol requires a nonempty ETag revision.");
  }
  if (ifMatch !== undefined && ifMatch !== revision.value) throw new TypeError("Conflicting ETag preconditions.");
  return revision.value;
}

/** Resolves revision admission before S3/Azure acquire a source or credentials. */
export function etagPutOptions(options: ObjectPutOptionsType): ObjectPutOptionsType {
  const ifMatch = objectETag(options.revision, options.ifMatch);
  return { ...putOptions(options), ...(ifMatch === undefined ? {} : { ifMatch }) };
}

/** Resolves both sides of an ETag-based provider copy before source reads. */
export function etagCopyOptions(options: ObjectCopyOptionsType): ObjectCopyOptionsType {
  const ifMatch = objectETag(options.revision, options.ifMatch);
  const sourceIfMatch = objectETag(options.sourceRevision, options.sourceIfMatch);
  return {
    ...copyOptions(options),
    ...(ifMatch === undefined ? {} : { ifMatch }),
    ...(sourceIfMatch === undefined ? {} : { sourceIfMatch }),
  };
}

/** Owns publication policy before asynchronous source or credential work starts.
 * Header construction and acknowledgement attribution consume the same snapshot.
 * The signal remains borrowed: its later cancellation is intentionally observable.
 */
export function putOptions(options: ObjectPutOptionsType): ObjectPutOptionsType {
  return {
    ...options,
    ...(options.revision === undefined ? {} : { revision: { ...options.revision } }),
    ...(options.metadata === undefined ? {} : { metadata: { ...options.metadata } }),
  };
}

/** Attributes only normalized properties applied to the publication headers.
 * Missing header properties are omitted, rather than retained from caller input.
 * Preconditions, declared size, and the borrowed cancellation signal retain their policy.
 */
export function putProperties(
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
export function copyOptions(options: ObjectCopyOptionsType): ObjectCopyOptionsType {
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
