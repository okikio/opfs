/**
 * Option, credential, request and block types for the Azure Blob client.
 *
 * @module
 */
import type { ObjectBackendType, ObjectCopyOptionsType, ObjectReceiptType } from "../../driver/object.ts";
import { type FetchType, type RequestMetricsType, type RequestPolicyType } from "../../request.ts";
import { type MetricsModeType } from "../../schema/mod.ts";

/** Validated Azure Storage REST service version. */
export type AzureStorageVersionType = import("../../schema/types.ts").AzureStorageVersionType;

/**
 * Azure Blob authorization strategy.
 *
 * Shared Key is supported for server runtimes and local Azurite validation. It
 * exposes the account secret to the process and should not be embedded in a
 * browser application. SAS and Microsoft Entra bearer credentials are better
 * fits when code executes in an untrusted client runtime.
 */
export type AzureCredentialType =
  | Readonly<{
    /** Selects SAS query authorization. */
    readonly kind: "sas";
    /** SAS token with or without a leading `?`; the client merges it into every request URL. */
    readonly token: string;
  }>
  | Readonly<{
    /** Selects Microsoft Entra bearer authorization. */
    readonly kind: "bearer";
    /** Static token or refresh function evaluated immediately before each request. */
    readonly token: string | (() => string | Promise<string>);
  }>
  | Readonly<{
    /** Selects Azure Storage Shared Key authorization. */
    readonly kind: "shared-key";
    /** Storage account name used in the Authorization header and canonical resource. */
    readonly account: string;
    /** Base64-encoded storage account key used only for HMAC-SHA256 signing. */
    readonly key: string;
  }>
  | Readonly<{
    /** Selects caller-owned authorization headers. */
    readonly kind: "headers";
    /**
     * Returns headers after the request URL and ordinary headers are known.
     *
     * This escape hatch supports provider-specific authorization without
     * letting the client guess whether those credentials also authorize a
     * server-side copy source.
     */
    readonly get: (
      request: Readonly<{
        /** HTTP method that will be sent. */
        readonly method: string;
        /** Final request URL including service and SAS query parameters. */
        readonly url: URL;
        /** Headers assembled before custom authorization is applied. */
        readonly headers: Headers;
      }>,
    ) => HeadersInit | Promise<HeadersInit>;
  }>;

/** Options used to create one Azure Blob Storage client. */
export interface AzureClientOptionsType {
  /** Blob service endpoint, for example `https://account.blob.core.windows.net`. */
  readonly endpoint: string | URL;
  /** Container exposed by this client. */
  readonly container: string;
  /** SAS, Microsoft Entra, Shared Key, or custom authorization strategy. */
  readonly credential: AzureCredentialType;
  /** Blob REST version. Defaults to {@link AZURE_STORAGE_VERSION}. */
  readonly version?: AzureStorageVersionType;
  /**
   * Fetch implementation. Defaults to native Fetch, whose raw stream support
   * is admitted lazily. An injected transport owns its stream-byte capability.
   */
  readonly fetch?: FetchType;
  /** Clock used by `x-ms-date` and deterministic Shared Key tests. */
  readonly now?: () => Date;
  /** Streaming block size. Defaults to 8 MiB. */
  readonly blockSize?: number;
  /** Maximum simultaneous Put Block / Put Block From URL requests. Defaults to 4. */
  readonly concurrency?: number;
  /** Additional headers sent with every request. */
  readonly headers?: HeadersInit;
  /** Retry/backoff and optional per-attempt timeout policy. */
  readonly request?: RequestPolicyType;
  /** Enables staged Put Block uploads for streams and blobs larger than Put Blob. Defaults to true. */
  readonly blockUpload?: boolean;
  /** Enables Azure server-side copy routes. Defaults to true. */
  readonly serverCopy?: boolean;
  /** Direct-client HTTP instrumentation. Defaults to `basic`; `none` removes counter updates. */
  readonly metrics?: MetricsModeType;
}

/** One low-level Azure Blob REST request. */
export interface AzureRequestOptionsType {
  /** HTTP method. */
  readonly method: string;
  /** Blob key. Omit for container-level requests. */
  readonly key?: string;
  /** Query parameters merged with configured SAS parameters. */
  readonly query?: Readonly<Record<string, string | undefined>>;
  /** Request headers added before authorization. */
  readonly headers?: HeadersInit;
  /**
   * Web Fetch body. Raw ArrayBuffers use their native range across realms, and
   * detached buffers reject before authorization or dispatch. Fixed ordinary
   * buffers with this realm's native prototype and no own metadata stay borrowed:
   * keep their bytes valid and unchanged, with no new backing properties or
   * prototype changes until settlement. Resizable, foreign,
   * custom-prototype or own-metadata backing receives one clean fixed copy before
   * asynchronous authorization and retries, costing its native byte length. Raw
   * SharedArrayBuffer is outside BodyInit; shared-backed views have a separate
   * fixed wire conversion. Raw streams remain one-shot. Default Fetch checks
   * native Request stream admission before authorization; an injected Fetch owns
   * its stream-byte capability and reader retirement. Shared Key raw streams
   * still need an explicit Content-Length.
   */
  readonly body?: BodyInit | null;
  /** Cancels the request. */
  readonly signal?: AbortSignal;
  /** Whether transport/status retry is allowed for this protocol operation. Defaults to true. */
  readonly retry?: boolean;
}

/** Azure Blob client used directly or as an object-store backend. */
export interface AzureClientType extends ObjectBackendType {
  /** Resolved client optimization switches used by driver inspection. */
  readonly optimizations: Readonly<{ blockUpload: boolean; serverCopy: boolean }>;
  /** Returns detached direct HTTP request metrics. */
  getMetrics(): RequestMetricsType;
  /** Sends one Blob REST request with the configured authorization strategy. */
  request(options: AzureRequestOptionsType): Promise<Response>;
  /** Copies through the provider; unavailable service or authorization policy rejects explicitly. */
  copy(source: string, destination: string, options?: ObjectCopyOptionsType): Promise<ObjectReceiptType>;
}

/** Public Azure Blob size/count limit contract. */
export interface AzureLimitsType {
  readonly maxCommittedBlocks: number;
  readonly maxUncommittedBlocks: number;
  readonly copyBlobBytes: number;
  readonly legacyBlockBytes: number;
  readonly midBlockBytes: number;
  readonly currentBlockBytes: number;
  readonly legacyPutBlobBytes: number;
  readonly midPutBlobBytes: number;
  readonly currentPutBlobBytes: number;
}

/** One indexed block emitted before an Azure Put Block request. */
export interface AzureBlockType {
  /** One-based logical block number. */
  readonly number: number;
  /** Fixed-width Base64 block ID. */
  readonly id: string;
  /** Block bytes. */
  readonly bytes: Uint8Array;
}

/** One source range used by Put Block From URL. */
export interface AzureCopyBlockType {
  /** One-based destination block number. */
  readonly number: number;
  /** Fixed-width Base64 destination block ID. */
  readonly id: string;
  /** Inclusive source byte start. */
  readonly start: number;
  /** Inclusive source byte end. */
  readonly end: number;
}

/** Native block input exposes direct interruption rather than queued return. */
export interface AzureBlockSourceType extends AsyncIterableIterator<AzureBlockType> {
  interrupt(): Promise<void>;
}
