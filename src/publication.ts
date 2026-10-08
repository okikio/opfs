import type { ObjectCopyOptionsType, ObjectPutOptionsType, ObjectStatType } from "./driver/object.ts";

/** Owns publication policy before asynchronous source or credential work starts.
 * Header construction and acknowledgement attribution consume the same snapshot.
 * The signal remains borrowed: its later cancellation is intentionally observable.
 */
export function putOptions(options: ObjectPutOptionsType): ObjectPutOptionsType {
  return {
    ...options,
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
    ...(options.sourceIfModifiedSince === undefined
      ? {}
      : { sourceIfModifiedSince: new Date(options.sourceIfModifiedSince.getTime()) }),
    ...(options.sourceIfUnmodifiedSince === undefined
      ? {}
      : { sourceIfUnmodifiedSince: new Date(options.sourceIfUnmodifiedSince.getTime()) }),
  };
}
