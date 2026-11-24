/**
 * Stat, receipt, option and upload types for the GCS client.
 *
 * @module
 */
import type { GcsStorageClassSchema } from "./metadata.ts";
import { z } from "zod";
import type {
  ObjectBackendType,
  ObjectCopyOptionsType,
  ObjectGetOptionsType,
  ObjectListOptionsType,
  ObjectListType,
  ObjectPutOptionsType,
  ObjectReceiptType,
  ObjectStatType,
  RevisionType,
} from "../../driver/object.ts";
import type { FetchType, RequestMetricsType, RequestPolicyType } from "../../request.ts";

/** An explicitly requested native object storage class. */
export type GcsStorageClassType = z.infer<typeof GcsStorageClassSchema>;

/** Provider-reported native facts remain separate from caller-defined object metadata. */
export interface GcsStatType extends ObjectStatType {
  /** Provider-reported class, including unknown or legacy values. */
  readonly storageClass?: string;
  /** Provider metadata version for this key and generation; never a byte revision. */
  readonly metageneration?: string;
  /** Unverified whole stored-object CRC32C, as canonical big-endian four-byte Base64. */
  readonly crc32c?: string;
}

/** Attributable upload or copy receipt, retaining reported native metadata without checksum verification. */
export interface GcsReceiptType extends ObjectReceiptType, GcsStatType {}

/** One native object-list page, retaining each object's reported native metadata. */
export interface GcsListType extends ObjectListType {
  readonly objects: readonly (GcsStatType & { readonly key: string })[];
}

/** Metadata observation options; a metadata guard also requires a positive generation revision. */
export interface GcsHeadOptionsType {
  /** Selects the object generation; decimal text is retained without numeric coercion. */
  readonly revision?: RevisionType;
  /** Requires this metadata version together with the selected generation. */
  readonly ifMetagenerationMatch?: string;
  readonly signal?: AbortSignal;
}

/** Byte reads can require a metadata version without replacing their generation authority. */
export interface GcsGetOptionsType extends ObjectGetOptionsType {
  /** Requires a positive generation revision; an empty local read evaluates no server condition. */
  readonly ifMetagenerationMatch?: string;
}

/** Deletion conditions apply to the same generation and metadata observation. */
export interface GcsDeleteOptionsType extends GcsHeadOptionsType {}

/** Rewrite source and destination metadata conditions each require their corresponding generation. */
export interface GcsCopyOptionsType extends ObjectCopyOptionsType {
  /** Destination metadata match, paired with revision; cannot be used with create-only intent. */
  readonly ifMetagenerationMatch?: string;
  /** Source metadata match, paired with sourceRevision. */
  readonly ifSourceMetagenerationMatch?: string;
}

/** Provider upload intent. Omitting the class retains the bucket's native default. */
export interface GcsPutOptionsType extends ObjectPutOptionsType {
  /** Destination metadata match sent at session initiation, paired with a positive generation revision. */
  readonly ifMetagenerationMatch?: string;
  /** Requested class must be confirmed by the final publication acknowledgement. */
  readonly storageClass?: GcsStorageClassType;
}

/** Explicit configuration; the application owns token acquisition and refresh. */
export interface GcsClientOptionsType {
  /** Bucket name; each client addresses one bucket. */
  readonly bucket: string;
  /** Bearer token or refresh callback; omitted for public objects or an injected emulator. */
  readonly token?: string | (() => string | Promise<string>);
  /** Service origin. Defaults to https://storage.googleapis.com. */
  readonly endpoint?: string | URL;
  /** Transport acquired only when constructing this client, never on import. */
  readonly fetch?: FetchType;
  /** Read/status retry policy. Mutating requests are never blindly replayed. */
  readonly request?: RequestPolicyType;
  /** Stream upload buffer. Defaults to 8 MiB; must be a positive 256 KiB multiple. */
  readonly chunkSize?: number;
  /** Maximum rewrite requests for one copy. Defaults to 1024. */
  readonly maxRewriteRequests?: number;
}

/** Secret resumable-upload authority; protect it like a credential. */
export interface GcsUploadType {
  /** Provider session URI; do not log or expose it to other callers. */
  readonly url: string;
  /** Destination object key, retained for acknowledgement attribution. */
  readonly key: string;
  /** Expected complete encoded length, when known. */
  readonly size?: number;
  /** Expected final native class; preserve this intent when persisting the session. */
  readonly storageClass?: GcsStorageClassType;
}

/** Server-confirmed continuation or attributable final publication. */
export type GcsUploadStatusType =
  | Readonly<{ complete: false; offset: number }>
  | Readonly<{ complete: true; offset: number; receipt: GcsReceiptType }>;

/** One bounded upload extent. Nonfinal extents must follow GCS alignment rules. */
export interface GcsUploadWriteOptionsType {
  /** Server-confirmed offset, not merely the bytes previously sent. */
  readonly offset: number;
  /** Complete encoded object size when known. */
  readonly total?: number;
  /** Declares this extent to be the final one; requires a complete total. */
  readonly final?: boolean;
  readonly signal?: AbortSignal;
}

/** GCS-native operations remain usable without a filesystem adapter. */
export interface GcsClientType extends ObjectBackendType {
  /** Returns counts of requests, retries, failures and responses so far. */
  getMetrics(): RequestMetricsType;
  /**
   * Reads an object's metadata, or returns `null` when the object does not exist.
   * @param key Object name in the bucket.
   * @param options Generation preconditions and cancellation.
   */
  head(key: string, options?: GcsHeadOptionsType): Promise<GcsStatType | null>;
  /**
   * Downloads an object as a stream.
   * @param key Object name in the bucket.
   * @param options Range, generation preconditions and cancellation.
   */
  get(key: string, options?: GcsGetOptionsType): Promise<ReadableStream<Uint8Array>>;
  /**
   * Deletes an object.
   * @param key Object name in the bucket.
   * @param options Generation preconditions and cancellation.
   */
  delete(key: string, options?: GcsDeleteOptionsType): Promise<void>;
  /**
   * Lists one page of objects.
   * @param options Prefix, delimiter, page size and cursor.
   */
  list(options: ObjectListOptionsType): Promise<GcsListType>;
  /**
   * Uploads an object through one resumable upload session. A stream is sent in chunks.
   * @param key Object name in the bucket.
   * @param body The object's bytes.
   * @param options Content type, metadata, preconditions and cancellation.
   */
  put(key: string, body: Uint8Array | ReadableStream<Uint8Array>, options?: GcsPutOptionsType): Promise<GcsReceiptType>;
  /**
   * Starts a resumable upload and returns its session.
   * @param key Object name in the bucket.
   * @param options Content type, metadata, preconditions and cancellation.
   */
  createUpload(key: string, options?: GcsPutOptionsType): Promise<GcsUploadType>;
  /**
   * Asks how many bytes a resumable upload has stored.
   * @param upload The upload session.
   * @param signal Cancels the request.
   */
  queryUpload(upload: GcsUploadType, signal?: AbortSignal): Promise<GcsUploadStatusType>;
  /** Sends the next chunk of a resumable upload. */
  writeUpload(
    upload: GcsUploadType,
    body: Uint8Array,
    options: GcsUploadWriteOptionsType,
  ): Promise<GcsUploadStatusType>;
  /**
   * Cancels a resumable upload. The object is not created.
   * @param upload The upload session.
   * @param signal Cancels the request.
   */
  cancelUpload(upload: GcsUploadType, signal?: AbortSignal): Promise<void>;
  /**
   * Copies an object inside the service.
   * @param source Name of the object to copy.
   * @param destination Name of the new object.
   * @param options Preconditions and cancellation.
   */
  copy(source: string, destination: string, options?: GcsCopyOptionsType): Promise<GcsReceiptType>;
}
