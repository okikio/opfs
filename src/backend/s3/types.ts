/**
 * Option, request, upload and part types for the S3 client.
 *
 * @module
 */
import { type FetchType, type RequestMetricsType, type RequestPolicyType } from "../../request.ts";
import { type MetricsModeType } from "../../schema/mod.ts";
import type {
  ObjectBackendType,
  ObjectCopyOptionsType,
  ObjectPutOptionsType,
  ObjectReceiptType,
} from "../../driver/object.ts";

/** Validated S3 URL addressing shape. */
export type S3AddressingType = import("../../schema/types.ts").S3AddressingType;

/** Decoding policy for URL-encoded listing identities; percent is the Amazon S3 default. */
export type S3ListEncodingType = "percent" | "form";

/** Validated AWS Signature Version 4 credentials. */
export type S3CredentialsType = import("../../schema/types.ts").S3CredentialsType;

/** Credential value or refresh function used by long-lived S3 clients. */
export type S3CredentialSourceType = S3CredentialsType | (() => S3CredentialsType | Promise<S3CredentialsType>);

/** Public S3 size/count limits used by request planning and tests. */
export interface S3LimitsType {
  /** Exact multipart-derived S3 object ceiling. */
  readonly maxObjectBytes: number;
  /** Largest body sent through one `PutObject` request. */
  readonly maxPutBytes: number;
  /** Largest source copied through one `CopyObject` request. */
  readonly maxCopyBytes: number;
  /** Smallest legal non-final multipart part. */
  readonly minPartBytes: number;
  /** Largest legal multipart part. */
  readonly maxPartBytes: number;
  /** Maximum part count accepted by one multipart upload. */
  readonly maxParts: number;
}

/** Options used to create one S3-compatible client. */
export interface S3ClientOptionsType {
  /** S3-compatible endpoint, for example `https://s3.us-east-1.amazonaws.com`. */
  readonly endpoint: string | URL;
  /** Bucket exposed by this client. */
  readonly bucket: string;
  /** Signature region. S3-compatible providers document the value they expect. */
  readonly region: string;
  /** Static or refreshable Signature Version 4 credentials. */
  readonly credentials: S3CredentialSourceType;
  /** URL addressing style. Path style is the compatibility-oriented default. */
  readonly addressing?: S3AddressingType;
  /**
   * Decodes EncodingType=url listing keys/prefixes. Defaults to percent; literal + remains +.
   * Select form only for providers such as SeaweedFS4.41 that encode spaces as + and literal + as %2B.
   * Unencoded fields and opaque continuation tokens are never reinterpreted by this policy.
   */
  readonly listEncoding?: S3ListEncodingType;
  /**
   * Fetch implementation. Defaults to native Fetch, whose raw stream support
   * is admitted lazily. An injected transport owns its stream-byte capability.
   */
  readonly fetch?: FetchType;
  /** Clock used for Signature Version 4 timestamps. */
  readonly now?: () => Date;
  /** Multipart part size. Defaults to 8 MiB and must be between 5 MiB and 5 GiB. */
  readonly partSize?: number;
  /** Maximum simultaneous multipart requests. Defaults to 4. */
  readonly concurrency?: number;
  /** Server-side multipart-copy part size. Defaults to 1 GiB. */
  readonly copyPartSize?: number;
  /** Additional headers sent with every request, such as provider-specific controls. */
  readonly headers?: HeadersInit;
  /** Disables provider-side copy when a compatible service does not implement it correctly. */
  readonly copy?: boolean;
  /** Disables conditional writes when a compatible service ignores S3 preconditions. */
  readonly conditionalWrite?: boolean;
  /** Maximum time allowed for owned multipart abort cleanup after a failed streamed write. Defaults to 30 seconds. */
  readonly abortTimeoutMs?: number;
  /** Retry/backoff and optional per-attempt timeout policy. */
  readonly request?: RequestPolicyType;
  /** Delays multipart creation until the stream proves it needs more than one bounded part. Defaults to true. */
  readonly delayedMultipart?: boolean;
  /** Reuses the derived SigV4 signing key while credentials/date/region are unchanged. Defaults to true. */
  readonly signingKeyCache?: boolean;
  /** Direct-client HTTP instrumentation. Defaults to `basic`; `none` removes counter updates. */
  readonly metrics?: MetricsModeType;
}

/** One low-level signed S3 request. */
export interface S3RequestOptionsType {
  /** HTTP method. */
  readonly method: string;
  /** Object key. Omit it for bucket-level operations. */
  readonly key?: string;
  /** Query parameters. Repeated values can be supplied with an array. */
  readonly query?: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** Request headers added before signing. */
  readonly headers?: HeadersInit;
  /**
   * Web Fetch body. Raw ArrayBuffers use their native range across realms, and
   * detached buffers reject before credentials or dispatch. Fixed ordinary
   * buffers with this realm's native prototype and no own metadata stay borrowed:
   * keep their bytes valid and unchanged, with no new backing properties or
   * prototype changes until settlement. Resizable, foreign,
   * custom-prototype or own-metadata backing receives one clean fixed copy before
   * asynchronous signing and retries, costing its current native byte length. Raw
   * SharedArrayBuffer is outside BodyInit; shared-backed views have a separate
   * fixed wire conversion. Raw streams remain one-shot. Default Fetch checks
   * native Request stream admission before signing; an injected Fetch owns its
   * own stream-byte capability and reader retirement.
   */
  readonly body?: BodyInit | null;
  /** Explicit payload SHA-256. Use `UNSIGNED-PAYLOAD` only when the provider accepts it. */
  readonly payloadHash?: string;
  /** Cancels the request. */
  readonly signal?: AbortSignal;
  /** Whether transport/status retry is allowed for this protocol operation. Defaults to true. */
  readonly retry?: boolean;
}

/** Preconditions and integrity metadata applied when multipart upload commits. */
export interface S3CompleteOptionsType {
  /** Completes only when the current destination ETag still matches. */
  readonly ifMatch?: string;
  /** Completes only when the current destination ETag does not match. `*` means create only. */
  readonly ifNoneMatch?: string;
  /** Expected complete object size sent through `x-amz-mp-object-size`. */
  readonly expectedSize?: number;
  /** Cancels the complete request. */
  readonly signal?: AbortSignal;
}

/** Multipart upload state returned by S3. */
export interface S3UploadType {
  /** Object key being written. */
  readonly key: string;
  /** Provider upload identity. */
  readonly id: string;
}

/** One successfully uploaded multipart part. */
export interface S3PartType {
  /** One-based part number. */
  readonly number: number;
  /** Entity tag returned by S3 for this part. */
  readonly etag: string;
}

/** One retained multipart part, including the provider's acknowledged byte count. */
export interface S3StoredPartType extends S3PartType {
  readonly size: number;
}

/** A bounded provider page; a cursor is present only when another page is required. */
export interface S3PartPageType {
  readonly parts: readonly S3StoredPartType[];
  readonly cursor?: number;
}

/**
 * S3 client used directly or through the object-store filesystem adapter.
 *
 * The lower-level multipart methods remain public because S3-compatible
 * providers expose capabilities that do not always fit the filesystem facade.
 * A caller can therefore compose custom storage-class, encryption, checksum,
 * object-lock, or provider-specific requests without importing the AWS SDK.
 */
export interface S3ClientType extends ObjectBackendType {
  /** Resolved listing identity policy, inspectable without provider I/O. */
  readonly listEncoding: S3ListEncodingType;
  /** Resolved client optimization switches used by driver inspection. */
  readonly optimizations: Readonly<{ delayedMultipart: boolean; signingKeyCache: boolean }>;
  /** Returns detached direct HTTP request metrics. */
  getMetrics(): RequestMetricsType;
  /** Sends an arbitrary bucket/object request after Signature Version 4 signing. */
  request(options: S3RequestOptionsType): Promise<Response>;
  /** Copies through the provider; a disabled copy policy rejects before provider I/O. */
  copy(source: string, destination: string, options?: ObjectCopyOptionsType): Promise<ObjectReceiptType>;
  /** Starts one multipart upload. */
  createUpload(key: string, options?: ObjectPutOptionsType): Promise<S3UploadType>;
  /** Uploads one multipart part. */
  uploadPart(upload: S3UploadType, number: number, bytes: Uint8Array, signal?: AbortSignal): Promise<S3PartType>;
  /** Reads one page of retained parts for explicit restart reconciliation. */
  listParts(upload: S3UploadType, cursor?: number, signal?: AbortSignal): Promise<S3PartPageType>;
  /** Atomically assembles already uploaded parts into the object. */
  completeUpload(
    upload: S3UploadType,
    parts: readonly S3PartType[],
    options?: S3CompleteOptionsType,
  ): Promise<S3CommitType>;
  /** Cancels one unfinished multipart upload. */
  abortUpload(upload: S3UploadType, signal?: AbortSignal): Promise<void>;
}

/** One indexed multipart chunk before it is uploaded. */
export interface S3ChunkType {
  /** One-based part number. */
  readonly number: number;
  /** Owned bytes for this part. */
  readonly bytes: Uint8Array;
}

/** One byte range copied into a multipart destination. */
export interface S3CopyRangeType {
  /** One-based destination part number. */
  readonly number: number;
  /** Inclusive source byte offset. */
  readonly start: number;
  /** Inclusive source end offset. */
  readonly end: number;
}

/** Result returned after one streamed multipart chunk reaches S3. */
export interface S3UploadedChunkType {
  /** Provider part reference used by multipart completion. */
  readonly part: S3PartType;
  /** Source byte count used to verify an optional declared object size. */
  readonly size: number;
}

/** Identity retained from a validated multipart commit, whose byte count may be unknown. */
export interface S3CommitType {
  readonly etag: string;
  readonly version?: string;
  readonly requestId?: string;
}

/** Numbered native input retains direct interruption and one reader retirement. */
export interface S3ChunkSourceType extends AsyncIterableIterator<S3ChunkType> {
  interrupt(): Promise<void>;
}

/** Only this publication invocation can establish dispatch and acknowledgement. */
export interface S3PublicationType {
  phase: "not-dispatched" | "unknown" | "rejected" | "acknowledged";
}
