import { pooledMap } from "@std/async/pool";
import { encodeHex } from "@std/encoding/hex";
import { z } from "zod";

import { split } from "./chunk.ts";
import {
  RequestMetrics,
  type RequestMetricsType,
  type RequestPolicyType,
  RequestTransportError,
  sendRequest,
} from "./request.ts";
import { type AdapterLimitsType, MetricsModeSchema, type MetricsModeType } from "./schema.ts";
import { createXmlElement, createXmlText, getXmlElements, getXmlValue, parseXmlRoot, stringifyXml } from "./xml.ts";

import type {
  ObjectBackendType,
  ObjectCopyOptionsType,
  ObjectEntryType,
  ObjectGetOptionsType,
  ObjectListOptionsType,
  ObjectListType,
  ObjectPutOptionsType,
  ObjectStatType,
} from "./driver/object.ts";

/** S3 URL addressing shape used when constructing signed request URLs. */
export const S3AddressingSchema = z.enum(["path", "virtual"]);

/** Validated S3 URL addressing shape. */
export type S3AddressingType = z.output<typeof S3AddressingSchema>;

/** AWS Signature Version 4 credentials. */
export const S3CredentialsSchema = z.object({
  /** Public access-key identifier placed in the SigV4 credential scope. */
  accessKeyId: z.string().min(1),
  /** Secret key used only as input to the SigV4 HMAC key-derivation chain. */
  secretAccessKey: z.string().min(1),
  /** Temporary-credential token signed through `x-amz-security-token` when present. */
  sessionToken: z.string().min(1).optional(),
});

/** Validated AWS Signature Version 4 credentials. */
export type S3CredentialsType = z.output<typeof S3CredentialsSchema>;

/** Credential value or refresh function used by long-lived S3 clients. */
export type S3CredentialSourceType = S3CredentialsType | (() => S3CredentialsType | Promise<S3CredentialsType>);

/**
 * S3 limits that affect the client's upload and copy planning.
 *
 * The multipart values come from the Amazon S3 multipart specification. The
 * single-request copy and PUT limits are the documented 5 GB REST limits,
 * which are decimal gigabytes rather than 5 GiB. The object-size value is the
 * exact multipart ceiling of 10,000 x 5 GiB (48.8 TiB,
 * approximately 53.7 TB), even though AWS often rounds that limit to 50 TB in
 * product documentation.
 */
export const S3_LIMITS = Object.freeze({
  /** Exact multipart-derived S3 object ceiling: 10,000 parts x 5 GiB. */
  maxObjectBytes: 53_687_091_200_000,
  /** Largest body sent through one `PutObject` request. */
  maxPutBytes: 5_000_000_000,
  /** Largest source copied through one `CopyObject` request. */
  maxCopyBytes: 5_000_000_000,
  /** Smallest legal non-final multipart upload/copy part. */
  minPartBytes: 5 * 1024 * 1024,
  /** Largest legal multipart upload/copy part. */
  maxPartBytes: 5 * 1024 * 1024 * 1024,
  /** Maximum part count accepted by one multipart upload. */
  maxParts: 10_000,
});

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
  /** Fetch implementation. The global Web Fetch API is used by default. */
  readonly fetch?: typeof fetch;
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
  /** Maximum time allowed for best-effort multipart abort cleanup after a failed streamed write. Defaults to 30 seconds. */
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
  /** Request body. */
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

/** Parsed S3 service failure with provider request identities retained. */
export class S3Error extends Error {
  /** HTTP status returned by the provider. */
  readonly status: number;
  /** S3 service error code when the response included one. */
  readonly code?: string;
  /** S3 request identity when available. */
  readonly requestId?: string;
  /** S3 host identity when available. */
  readonly hostId?: string;
  /** Original response. */
  readonly response: Response;

  /** Creates a provider-aware S3 failure without discarding the original response. */
  constructor(
    message: string,
    response: Response,
    details: { code?: string; requestId?: string; hostId?: string } = {},
  ) {
    super(message);
    this.name = "S3Error";
    this.status = response.status;
    this.response = response;
    if (details.code !== undefined) this.code = details.code;
    if (details.requestId !== undefined) this.requestId = details.requestId;
    if (details.hostId !== undefined) this.hostId = details.hostId;
  }
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
  /** Resolved client optimization switches used by driver inspection. */
  readonly optimizations: Readonly<{ delayedMultipart: boolean; signingKeyCache: boolean }>;
  /** Returns detached direct HTTP request metrics. */
  getMetrics(): RequestMetricsType;
  /** Sends an arbitrary bucket/object request after Signature Version 4 signing. */
  request(options: S3RequestOptionsType): Promise<Response>;
  /** Starts one multipart upload. */
  createUpload(key: string, options?: ObjectPutOptionsType): Promise<S3UploadType>;
  /** Uploads one multipart part. */
  uploadPart(upload: S3UploadType, number: number, bytes: Uint8Array, signal?: AbortSignal): Promise<S3PartType>;
  /** Atomically assembles already uploaded parts into the object. */
  completeUpload(upload: S3UploadType, parts: readonly S3PartType[], options?: S3CompleteOptionsType): Promise<void>;
  /** Cancels one unfinished multipart upload. */
  abortUpload(upload: S3UploadType, signal?: AbortSignal): Promise<void>;
}

/** One indexed multipart chunk before it is uploaded. */
interface S3ChunkType {
  /** One-based part number. */
  readonly number: number;
  /** Owned bytes for this part. */
  readonly bytes: Uint8Array;
}

/** One byte range copied into a multipart destination. */
interface S3CopyRangeType {
  /** One-based destination part number. */
  readonly number: number;
  /** Inclusive source byte offset. */
  readonly start: number;
  /** Inclusive source end offset. */
  readonly end: number;
}

/** Result returned after one streamed multipart chunk reaches S3. */
interface S3UploadedChunkType {
  /** Provider part reference used by multipart completion. */
  readonly part: S3PartType;
  /** Source byte count used to verify an optional declared object size. */
  readonly size: number;
}

/** Shared UTF-8 encoder used by SigV4 hashing and HMAC derivation. */
const textEncoder = new TextEncoder();
/** SHA-256 of an empty payload, required by SigV4 for requests without a body. */
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/** Default streamed upload part size. */
const DEFAULT_PART_SIZE = 8 * 1024 * 1024;
/** Default server-side multipart-copy range size. */
const DEFAULT_COPY_PART_SIZE = 1024 * 1024 * 1024;
/** Default time allowed for cleanup after streamed multipart work becomes terminal. */
const DEFAULT_ABORT_TIMEOUT_MS = 30_000;

/** Compares canonical protocol strings without locale-sensitive collation. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Percent-encodes one Signature Version 4 component using RFC 3986's unreserved set. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encodes a slash-delimited path while retaining path separators required by S3. */
function encodePath(value: string): string {
  return value.split("/").map(encode).join("/");
}

/** Builds the canonical query string required by Signature Version 4. */
function getQueryString(query: S3RequestOptionsType["query"]): string {
  const pairs: Array<readonly [string, string]> = [];
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) pairs.push([encode(name), encode(item)]);
  }
  pairs.sort(([leftName, leftValue], [rightName, rightValue]) => {
    const nameOrder = compareText(leftName, rightName);
    return nameOrder === 0 ? compareText(leftValue, rightValue) : nameOrder;
  });
  return pairs.map(([name, value]) => `${name}=${value}`).join("&");
}

/** Returns lowercase hexadecimal SHA-256 for one request payload. */
async function getSha256(value: BufferSource | string): Promise<string> {
  const bytes = typeof value === "string" ? textEncoder.encode(value) : value;
  return encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).toLowerCase();
}

/**
 * Returns the SigV4 payload hash for one Web Fetch body.
 *
 * Replayable materialized values are hashed before the request is sent. A
 * `ReadableStream` or `FormData` body is not consumed because doing so would
 * either destroy the caller's stream or require us to reproduce Fetch's
 * multipart encoding. S3 explicitly permits `UNSIGNED-PAYLOAD` for those
 * request shapes, and callers can still provide an exact `payloadHash` through
 * {@link S3RequestOptionsType} when a provider or policy requires one.
 */
async function getPayloadHash(body: BodyInit | null | undefined): Promise<string> {
  if (body === undefined || body === null) return EMPTY_SHA256;
  if (typeof body === "string") return await getSha256(body);
  if (body instanceof ArrayBuffer) return await getSha256(body);
  if (ArrayBuffer.isView(body)) {
    const bytes = new Uint8Array(body.byteLength);
    bytes.set(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    return await getSha256(bytes);
  }
  if (body instanceof Blob) return await getSha256(await body.arrayBuffer());
  if (body instanceof URLSearchParams) return await getSha256(body.toString());
  return "UNSIGNED-PAYLOAD";
}

/** Computes one HMAC-SHA256 step in the Signature Version 4 key derivation. */
async function getHmac(key: BufferSource, value: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, textEncoder.encode(value)));
}

/** Derives the date, region, and service-specific Signature Version 4 signing key. */
async function getSigningKey(secret: string, date: string, region: string): Promise<Uint8Array> {
  const dateKey = await getHmac(textEncoder.encode(`AWS4${secret}`), date);
  const regionKey = await getHmac(dateKey as Uint8Array<ArrayBuffer>, region);
  const serviceKey = await getHmac(regionKey as Uint8Array<ArrayBuffer>, "s3");
  return await getHmac(serviceKey as Uint8Array<ArrayBuffer>, "aws4_request");
}

/** Formats one UTC instant as the compact timestamp required by Signature Version 4. */
function getAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/** Normalizes header whitespace before canonical signing. */
function getHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/** Converts S3 response headers into provider-neutral object metadata. */
function getStat(headers: Headers): ObjectStatType {
  const metadata: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (name.toLowerCase().startsWith("x-amz-meta-")) metadata[name.slice("x-amz-meta-".length)] = value;
  }
  const size = Number.parseInt(headers.get("content-length") ?? "0", 10);
  const modified = headers.get("last-modified");
  return {
    size: Number.isSafeInteger(size) && size >= 0 ? size : 0,
    ...(modified === null ? {} : { lastModified: new Date(modified).getTime() }),
    ...(headers.get("content-type") === null ? {} : { mediaType: headers.get("content-type")! }),
    ...(headers.get("etag") === null ? {} : { etag: headers.get("etag")! }),
    ...(headers.get("x-amz-version-id") === null ? {} : { version: headers.get("x-amz-version-id")! }),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
  };
}

/** Reads and throws a structured S3 error without losing provider request IDs. */
async function assertResponse(response: Response, operation: string): Promise<Response> {
  if (response.ok) return response;

  let code: string | undefined;
  let requestId = response.headers.get("x-amz-request-id") ?? undefined;
  let hostId = response.headers.get("x-amz-id-2") ?? undefined;
  let message = `${operation} failed with HTTP ${response.status}.`;
  const body = await response.text().catch(() => "");

  if (body.trim().startsWith("<")) {
    try {
      const root = parseXmlRoot(body);
      code = getXmlValue(root, "Code");
      requestId ??= getXmlValue(root, "RequestId");
      hostId ??= getXmlValue(root, "HostId");
      message = getXmlValue(root, "Message") ?? message;
    } catch {
      // A gateway can return HTML or malformed XML. The HTTP status and provider
      // request headers still preserve the most useful failure evidence.
    }
  }

  throw new S3Error(message, response, {
    ...(code === undefined ? {} : { code }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(hostId === undefined ? {} : { hostId }),
  });
}

/** Parses an HTTP-success S3 XML response and detects the protocol's embedded `<Error>` form. */
async function getSuccessXml(response: Response, operation: string) {
  await assertResponse(response, operation);
  const body = await response.text();
  if (!body.trim().startsWith("<")) return undefined;
  const root = parseXmlRoot(body);
  const error = getXmlElements(root, "Error")[0];
  if (error === undefined) return root;

  throw new S3Error(getXmlValue(error, "Message") ?? `${operation} failed after HTTP 200.`, response, {
    ...(getXmlValue(error, "Code") === undefined ? {} : { code: getXmlValue(error, "Code")! }),
    ...(getXmlValue(error, "RequestId") === undefined ? {} : { requestId: getXmlValue(error, "RequestId")! }),
    ...(getXmlValue(error, "HostId") === undefined ? {} : { hostId: getXmlValue(error, "HostId")! }),
  });
}

/** Resolves static or refreshable credentials immediately before signing. */
async function getCredentials(source: S3CredentialSourceType): Promise<S3CredentialsType> {
  return S3CredentialsSchema.parse(typeof source === "function" ? await source() : source);
}

/** Yields one-based part numbers beside fixed-size chunks from a streamed object body. */
async function* getChunks(source: ReadableStream<Uint8Array>, size: number): AsyncGenerator<S3ChunkType> {
  let number = 0;
  for await (const bytes of split(source, size)) {
    number += 1;
    if (number > S3_LIMITS.maxParts) {
      throw new RangeError(
        `S3 multipart upload exceeds ${S3_LIMITS.maxParts} parts. Supply the expected size or increase partSize.`,
      );
    }
    yield { number, bytes };
  }
}

/** Yields the inclusive source ranges required for multipart server-side copy. */
function* getCopyRanges(size: number, partSize: number): Generator<S3CopyRangeType> {
  const count = Math.ceil(size / partSize);
  for (let index = 0; index < count; index += 1) {
    const start = index * partSize;
    yield { number: index + 1, start, end: Math.min(size, start + partSize) - 1 };
  }
}

/** Builds one XML `<Part>` element for multipart completion. */
function getCompletePart(part: S3PartType): ReturnType<typeof createXmlElement> {
  return createXmlElement("Part", [
    createXmlElement("PartNumber", [createXmlText(String(part.number))]),
    createXmlElement("ETag", [createXmlText(part.etag)]),
  ]);
}

/** Builds the XML body accepted by `CompleteMultipartUpload`. */
function getCompleteBody(parts: readonly S3PartType[]): string {
  return stringifyXml(createXmlElement("CompleteMultipartUpload", parts.map(getCompletePart)));
}

/** Converts one `ListObjectsV2` `<Contents>` element into portable metadata. */
function getListObject(content: Parameters<typeof getXmlValue>[0]): ObjectEntryType {
  const key = getXmlValue(content, "Key") ?? "";
  const size = Number.parseInt(getXmlValue(content, "Size") ?? "0", 10);
  const modified = getXmlValue(content, "LastModified");
  const etag = getXmlValue(content, "ETag");
  return {
    key,
    size: Number.isSafeInteger(size) && size >= 0 ? size : 0,
    ...(modified === undefined ? {} : { lastModified: new Date(modified).getTime() }),
    ...(etag === undefined ? {} : { etag }),
  };
}

/** Validates and orders part references before S3 commits a multipart upload. */
function normalizeParts(parts: readonly S3PartType[]): S3PartType[] {
  if (parts.length === 0) throw new RangeError("CompleteMultipartUpload requires at least one part.");
  if (parts.length > S3_LIMITS.maxParts) {
    throw new RangeError(`S3 permits at most ${S3_LIMITS.maxParts} multipart parts.`);
  }

  const sorted = [...parts].sort((left, right) => left.number - right.number);
  let previous = 0;
  for (const part of sorted) {
    if (!Number.isSafeInteger(part.number) || part.number < 1 || part.number > S3_LIMITS.maxParts) {
      throw new RangeError(`S3 part number must be between 1 and ${S3_LIMITS.maxParts}.`);
    }
    if (part.number === previous) throw new RangeError(`S3 multipart part ${part.number} appears more than once.`);
    if (part.etag.length === 0) throw new TypeError(`S3 multipart part ${part.number} has an empty ETag.`);
    previous = part.number;
  }
  return sorted;
}

/**
 * Direct Fetch/Web-Crypto implementation of the S3 REST subset used by OPFS.
 *
 * The class exists instead of a factory full of nested functions so request
 * signing, multipart lifecycle, copying, and provider translation remain
 * independently readable and testable. Public consumers still receive the
 * structural `S3ClientType` contract through `createS3Client()`.
 */
class S3Client implements S3ClientType {
  /** Stable object-store name exposed to the adapter and diagnostics. */
  readonly name = "s3";
  /** Native behavior guaranteed by this configured client. */
  readonly capabilities;
  /** Portable S3 limits exposed to the filesystem planner. */
  readonly limits: AdapterLimitsType;

  /** Base S3-compatible HTTP endpoint. */
  readonly #endpoint: URL;
  /** Bucket addressed by every high-level object operation. */
  readonly #bucket: string;
  /** SigV4 region. */
  readonly #region: string;
  /** Static or refreshable SigV4 credentials. */
  readonly #credentials: S3CredentialSourceType;
  /** Path-style or virtual-hosted-style URL strategy. */
  readonly #addressing: S3AddressingType;
  /** Fetch implementation used for every request. */
  readonly #fetch: typeof fetch;
  /** Clock injected for deterministic signing and tests. */
  readonly #now: () => Date;
  /** Configured minimum multipart upload size. */
  readonly #partSize: number;
  /** Configured minimum multipart-copy range size. */
  readonly #copyPartSize: number;
  /** Maximum count of active multipart requests. */
  readonly #concurrency: number;
  /** Headers copied into each request before operation-specific headers. */
  readonly #headers: HeadersInit | undefined;
  /** Maximum time allowed for best-effort AbortMultipartUpload cleanup. */
  readonly #abortTimeoutMs: number;
  /** Retry/backoff and optional per-attempt deadline. */
  readonly #requestPolicy: RequestPolicyType | undefined;
  /** Selected HTTP instrumentation detail. */
  readonly #metricsMode: MetricsModeType;
  /** Mutable direct HTTP counters when instrumentation is enabled. */
  readonly #metrics: RequestMetrics | undefined;
  /** Resolved client optimization switches. */
  readonly optimizations: Readonly<{ delayedMultipart: boolean; signingKeyCache: boolean }>;
  /** One-entry derived SigV4 key cache. The raw secret is retained only as long as the client already retains credentials. */
  #signingKey: { secret: string; date: string; region: string; key: Uint8Array } | undefined;

  /** Validates configuration and creates one import-safe S3 client. */
  constructor(options: S3ClientOptionsType) {
    this.#endpoint = new URL(options.endpoint);
    this.#bucket = options.bucket;
    this.#region = options.region;
    this.#credentials = options.credentials;
    this.#addressing = S3AddressingSchema.parse(options.addressing ?? "path");
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#partSize = options.partSize ?? DEFAULT_PART_SIZE;
    this.#copyPartSize = options.copyPartSize ?? DEFAULT_COPY_PART_SIZE;
    this.#concurrency = options.concurrency ?? 4;
    this.#headers = options.headers;
    this.#abortTimeoutMs = options.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS;
    this.#requestPolicy = options.request;
    this.#metricsMode = MetricsModeSchema.parse(options.metrics ?? "basic");
    this.#metrics = this.#metricsMode === "none" ? undefined : new RequestMetrics(this.#metricsMode === "timing");
    this.optimizations = Object.freeze({
      delayedMultipart: options.delayedMultipart ?? true,
      signingKeyCache: options.signingKeyCache ?? true,
    });

    if (this.#bucket.length === 0) throw new TypeError("S3 bucket cannot be empty.");
    if (this.#region.length === 0) throw new TypeError("S3 region cannot be empty.");
    if (
      !Number.isSafeInteger(this.#partSize) || this.#partSize < S3_LIMITS.minPartBytes ||
      this.#partSize > S3_LIMITS.maxPartBytes
    ) {
      throw new RangeError(
        `S3 partSize must be between ${S3_LIMITS.minPartBytes} and ${S3_LIMITS.maxPartBytes} bytes.`,
      );
    }
    if (
      !Number.isSafeInteger(this.#copyPartSize) || this.#copyPartSize < S3_LIMITS.minPartBytes ||
      this.#copyPartSize > S3_LIMITS.maxPartBytes
    ) {
      throw new RangeError(
        `S3 copyPartSize must be between ${S3_LIMITS.minPartBytes} and ${S3_LIMITS.maxPartBytes} bytes.`,
      );
    }
    if (!Number.isSafeInteger(this.#concurrency) || this.#concurrency < 1) {
      throw new RangeError("S3 concurrency must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.#abortTimeoutMs) || this.#abortTimeoutMs < 1) {
      throw new RangeError("S3 abortTimeoutMs must be a positive integer.");
    }

    this.capabilities = {
      rangeRead: true,
      streamRead: true,
      streamWrite: true,
      copy: options.copy ?? true,
      conditionalWrite: options.conditionalWrite ?? true,
      multipart: true,
      metadata: true,
      versions: false,
    } as const;
    this.limits = {
      maxFileBytes: S3_LIMITS.maxObjectBytes,
      minPartBytes: S3_LIMITS.minPartBytes,
      maxPartBytes: S3_LIMITS.maxPartBytes,
      maxParts: S3_LIMITS.maxParts,
      maxConcurrency: this.#concurrency,
    };
  }

  /** Returns the derived SigV4 key, reusing one safe per-client cache entry when enabled. */
  async #getSigningKey(secret: string, date: string): Promise<Uint8Array> {
    if (this.optimizations.signingKeyCache) {
      const cached = this.#signingKey;
      if (cached !== undefined && cached.secret === secret && cached.date === date && cached.region === this.#region) {
        return cached.key;
      }
    }
    const key = await getSigningKey(secret, date, this.#region);
    if (this.optimizations.signingKeyCache) this.#signingKey = { secret, date, region: this.#region, key };
    return key;
  }

  /** Builds the request URL and canonical URI for one bucket/object address. */
  #address(key: string | undefined): { url: URL; canonicalUri: string } {
    const endpointPath = this.#endpoint.pathname.replace(/\/$/, "");
    const objectPath = key === undefined || key.length === 0 ? "" : `/${encodePath(key)}`;
    const bucketPath = this.#addressing === "path" ? `/${encode(this.#bucket)}` : "";
    const canonicalUri = `${endpointPath}${bucketPath}${objectPath}` || "/";
    const url = new URL(this.#endpoint);
    url.pathname = canonicalUri;
    if (this.#addressing === "virtual") url.hostname = `${this.#bucket}.${this.#endpoint.hostname}`;
    return { url, canonicalUri };
  }

  /** Chooses a legal multipart part size for a known or unknown object size. */
  #getPartSize(expectedSize: number | undefined): number {
    if (expectedSize === undefined) return this.#partSize;
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > S3_LIMITS.maxObjectBytes) {
      throw new RangeError(`S3 object size must be between 0 and ${S3_LIMITS.maxObjectBytes} bytes.`);
    }
    const required = Math.ceil(expectedSize / S3_LIMITS.maxParts);
    const size = Math.max(this.#partSize, required);
    if (size > S3_LIMITS.maxPartBytes) {
      throw new RangeError(`S3 object requires multipart parts larger than ${S3_LIMITS.maxPartBytes} bytes.`);
    }
    return size;
  }

  /** Adds S3 source and destination copy preconditions to one request. */
  #getCopyHeaders(source: string, options: ObjectCopyOptionsType): Headers {
    const headers = new Headers({ "x-amz-copy-source": `/${encode(this.#bucket)}/${encodePath(source)}` });
    if (options.sourceIfMatch !== undefined) headers.set("x-amz-copy-source-if-match", options.sourceIfMatch);
    if (options.sourceIfNoneMatch !== undefined) {
      headers.set("x-amz-copy-source-if-none-match", options.sourceIfNoneMatch);
    }
    if (options.sourceIfModifiedSince !== undefined) {
      headers.set("x-amz-copy-source-if-modified-since", options.sourceIfModifiedSince.toUTCString());
    }
    if (options.sourceIfUnmodifiedSince !== undefined) {
      headers.set("x-amz-copy-source-if-unmodified-since", options.sourceIfUnmodifiedSince.toUTCString());
    }
    if (options.ifMatch !== undefined) headers.set("if-match", options.ifMatch);
    if (options.ifNoneMatch !== undefined) headers.set("if-none-match", options.ifNoneMatch);
    return headers;
  }

  /** Writes one materialized object with PutObject and optional write preconditions. */
  async #putBytes(key: string, body: Uint8Array, options: ObjectPutOptionsType): Promise<ObjectStatType> {
    if (body.byteLength > S3_LIMITS.maxPutBytes) {
      throw new RangeError(
        `S3 PutObject accepts at most ${S3_LIMITS.maxPutBytes} bytes. Use a stream for multipart upload.`,
      );
    }
    const headers = new Headers();
    if (options.mediaType !== undefined) headers.set("content-type", options.mediaType);
    if (options.ifMatch !== undefined) headers.set("if-match", options.ifMatch);
    if (options.ifNoneMatch !== undefined) headers.set("if-none-match", options.ifNoneMatch);
    for (const [name, value] of Object.entries(options.metadata ?? {})) headers.set(`x-amz-meta-${name}`, value);

    await assertResponse(
      await this.request({
        method: "PUT",
        key,
        headers,
        body: body as Uint8Array<ArrayBuffer>,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
      `PutObject ${key}`,
    );
    return (await this.head(key, options)) ?? { size: body.byteLength };
  }

  /** Copies one source range into one destination multipart part. */
  async #copyPart(
    source: string,
    upload: S3UploadType,
    range: S3CopyRangeType,
    options: ObjectCopyOptionsType,
  ): Promise<S3PartType> {
    const headers = this.#getCopyHeaders(source, options);
    headers.delete("if-match");
    headers.delete("if-none-match");
    headers.set("x-amz-copy-source-range", `bytes=${range.start}-${range.end}`);

    const response = await this.request({
      method: "PUT",
      key: upload.key,
      query: { partNumber: String(range.number), uploadId: upload.id },
      headers,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const root = await getSuccessXml(
      response,
      `UploadPartCopy ${source}[${range.start}-${range.end}] -> ${upload.key}#${range.number}`,
    );
    const etag = root === undefined ? undefined : getXmlValue(root, "ETag");
    if (etag === undefined) {
      throw new S3Error(`UploadPartCopy ${range.number} response did not contain ETag.`, response);
    }
    return { number: range.number, etag };
  }

  /** Uploads one indexed streamed chunk and retains its byte count for commit validation. */
  async #uploadChunk(
    upload: S3UploadType,
    chunk: S3ChunkType,
    signal?: AbortSignal,
  ): Promise<S3UploadedChunkType> {
    const part = await this.uploadPart(upload, chunk.number, chunk.bytes, signal);
    return { part, size: chunk.bytes.byteLength };
  }

  /** Returns detached direct HTTP metrics without exposing the mutable counter book. */
  getMetrics(): RequestMetricsType {
    return this.#metrics?.snapshot() ?? { requests: 0, retries: 0, failures: 0, responses: 0, durationMs: 0 };
  }

  /**
   * Sends one arbitrary S3 request after AWS Signature Version 4 signing.
   *
   * Every retry rebuilds the signature so refreshed credentials and the current
   * timestamp are used. Signed redirects are never followed automatically. S3
   * redirect responses must reach the caller so it can choose a new endpoint and
   * sign a new request for that authority. ReadableStream bodies are one-shot and
   * therefore receive exactly one attempt.
   */
  async request(options: S3RequestOptionsType): Promise<Response> {
    const payloadHash = options.payloadHash ?? await getPayloadHash(options.body);
    // Body replayability and protocol idempotency are separate. A byte body can
    // be replayed mechanically while an operation such as CreateMultipartUpload
    // can still allocate a second server-side resource.
    const replayable = options.retry !== false && !(options.body instanceof ReadableStream);

    return await sendRequest(async (signal) => {
      const { url, canonicalUri } = this.#address(options.key);
      const canonicalQuery = getQueryString(options.query);
      url.search = canonicalQuery;

      const timestamp = getAmzDate(this.#now());
      const shortDate = timestamp.slice(0, 8);
      const credentials = await getCredentials(this.#credentials);
      const headers = new Headers(this.#headers);
      new Headers(options.headers).forEach((value, name) => headers.set(name, value));
      headers.delete("authorization");
      headers.delete("host");
      headers.set("x-amz-date", timestamp);
      headers.set("x-amz-content-sha256", payloadHash);
      if (credentials.sessionToken !== undefined) headers.set("x-amz-security-token", credentials.sessionToken);

      // Fetch owns Host/:authority and browsers forbid setting Host directly. SigV4
      // still requires the authority in the signed set, so sign a cloned header
      // collection while the actual request derives authority from the URL.
      const signingHeaders = new Headers(headers);
      signingHeaders.set("host", url.host);
      const signedNames = Array.from(signingHeaders.keys()).map((name) => name.toLowerCase()).sort(compareText);
      const canonicalHeaders = signedNames.map((name) =>
        `${name}:${getHeaderValue(signingHeaders.get(name) ?? "")}`
      ).join("\n") + "\n";
      const signedHeaders = signedNames.join(";");
      const canonicalRequest = [
        options.method.toUpperCase(),
        canonicalUri,
        canonicalQuery,
        canonicalHeaders,
        signedHeaders,
        payloadHash,
      ].join("\n");
      const scope = `${shortDate}/${this.#region}/s3/aws4_request`;
      const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${await getSha256(canonicalRequest)}`;
      const signingKey = await this.#getSigningKey(credentials.secretAccessKey, shortDate);
      const signature = encodeHex(await getHmac(signingKey as Uint8Array<ArrayBuffer>, stringToSign)).toLowerCase();
      headers.set(
        "authorization",
        `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      );

      const init: RequestInit & { duplex?: "half" } = {
        method: options.method,
        headers,
        redirect: "manual",
        ...(options.body === undefined ? {} : { body: options.body }),
        ...(signal === undefined ? {} : { signal }),
      };
      if (options.body instanceof ReadableStream) init.duplex = "half";
      try {
        return await this.#fetch(url, init);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        throw new RequestTransportError(error);
      }
    }, {
      ...(this.#requestPolicy === undefined ? {} : { policy: this.#requestPolicy }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      replayable,
      ...(this.#metrics === undefined ? {} : { metrics: this.#metrics }),
    });
  }

  /** Returns exact-object metadata, or `null` when the object does not exist. */
  async head(key: string, options?: { readonly signal?: AbortSignal }): Promise<ObjectStatType | null> {
    const response = await this.request({
      method: "HEAD",
      key,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    if (response.status === 404) return null;
    await assertResponse(response, `HeadObject ${key}`);
    return getStat(response.headers);
  }

  /** Opens an S3 object or byte range as a Web `ReadableStream`. */
  async get(key: string, options: ObjectGetOptionsType = {}): Promise<ReadableStream<Uint8Array>> {
    const headers = new Headers();
    if (options.at !== undefined || options.length !== undefined) {
      const start = options.at ?? 0;
      const end = options.length === undefined ? "" : String(start + Math.max(0, options.length - 1));
      headers.set("range", `bytes=${start}-${end}`);
    }
    const response = await assertResponse(
      await this.request({
        method: "GET",
        key,
        headers,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
      `GetObject ${key}`,
    );
    return response.body ?? new Blob().stream();
  }

  /** Starts a multipart upload and returns its provider identity. */
  async createUpload(key: string, options: ObjectPutOptionsType = {}): Promise<S3UploadType> {
    const headers = new Headers();
    if (options.mediaType !== undefined) headers.set("content-type", options.mediaType);
    for (const [name, value] of Object.entries(options.metadata ?? {})) headers.set(`x-amz-meta-${name}`, value);
    const response = await assertResponse(
      await this.request({
        method: "POST",
        key,
        query: { uploads: "" },
        headers,
        retry: false,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
      `CreateMultipartUpload ${key}`,
    );
    const id = getXmlValue(parseXmlRoot(await response.text()), "UploadId");
    if (id === undefined) throw new S3Error("CreateMultipartUpload response did not contain UploadId.", response);
    return { key, id };
  }

  /** Uploads one legal multipart part and retains the ETag required at completion. */
  async uploadPart(upload: S3UploadType, number: number, bytes: Uint8Array, signal?: AbortSignal): Promise<S3PartType> {
    if (!Number.isSafeInteger(number) || number < 1 || number > S3_LIMITS.maxParts) {
      throw new RangeError(`S3 part number must be between 1 and ${S3_LIMITS.maxParts}.`);
    }
    if (bytes.byteLength > S3_LIMITS.maxPartBytes) {
      throw new RangeError(`S3 multipart parts cannot exceed ${S3_LIMITS.maxPartBytes} bytes.`);
    }
    const response = await assertResponse(
      await this.request({
        method: "PUT",
        key: upload.key,
        query: { partNumber: String(number), uploadId: upload.id },
        body: bytes as Uint8Array<ArrayBuffer>,
        ...(signal === undefined ? {} : { signal }),
      }),
      `UploadPart ${upload.key}#${number}`,
    );
    const etag = response.headers.get("etag");
    if (etag === null) throw new S3Error(`UploadPart ${number} response did not contain ETag.`, response);
    return { number, etag };
  }

  /** Commits uploaded parts after validating part identity and ordering. */
  async completeUpload(
    upload: S3UploadType,
    parts: readonly S3PartType[],
    options: S3CompleteOptionsType = {},
  ): Promise<void> {
    const normalized = normalizeParts(parts);
    const headers = new Headers({ "content-type": "application/xml" });
    if (options.ifMatch !== undefined) headers.set("if-match", options.ifMatch);
    if (options.ifNoneMatch !== undefined) headers.set("if-none-match", options.ifNoneMatch);
    if (options.expectedSize !== undefined) headers.set("x-amz-mp-object-size", String(options.expectedSize));

    const response = await this.request({
      method: "POST",
      key: upload.key,
      query: { uploadId: upload.id },
      headers,
      body: getCompleteBody(normalized),
      retry: false,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    // S3 can send HTTP 200 before assembly completes and later encode a failure
    // as an <Error> body in the same response. HTTP status alone is not commit
    // authority for this operation.
    await getSuccessXml(response, `CompleteMultipartUpload ${upload.key}`);
  }

  /** Aborts one unfinished multipart upload. Missing upload IDs are already terminal. */
  async abortUpload(upload: S3UploadType, signal?: AbortSignal): Promise<void> {
    const response = await this.request({
      method: "DELETE",
      key: upload.key,
      query: { uploadId: upload.id },
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status === 404) return;
    await assertResponse(response, `AbortMultipartUpload ${upload.key}`);
  }

  /**
   * Replaces one object from materialized bytes or a bounded multipart stream.
   *
   * Streamed writes use `@std/async/pool` so the client admits at most
   * `concurrency` active part requests. When a part fails, the pool stops
   * pulling new chunks and waits for already-started requests. Only then does
   * the client abort the multipart upload, which prevents a late part from
   * arriving after the abort request.
   */
  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    options: ObjectPutOptionsType = {},
  ): Promise<ObjectStatType> {
    if (body instanceof Uint8Array) return await this.#putBytes(key, body, options);

    const partSize = this.#getPartSize(options.size);
    let chunks = getChunks(body, partSize);

    if (this.optimizations.delayedMultipart) {
      const first = await chunks.next();
      if (first.done) return await this.#putBytes(key, new Uint8Array(), options);

      const second = await chunks.next();
      if (second.done && first.value.bytes.byteLength <= S3_LIMITS.maxPutBytes) {
        if (options.size !== undefined && first.value.bytes.byteLength !== options.size) {
          throw new RangeError(
            `S3 streamed body produced ${first.value.bytes.byteLength} bytes but options.size declared ${options.size}.`,
          );
        }
        return await this.#putBytes(key, first.value.bytes, options);
      }

      // Preserve the already-consumed chunks before replacing the iterator.
      // A single chunk larger than PutObject's hard limit still enters multipart
      // instead of failing only because delayed multipart is enabled.
      const rest = chunks;
      async function* retained(): AsyncGenerator<S3ChunkType> {
        yield first.value;
        if (!second.done) yield second.value;
        for await (const chunk of rest) yield chunk;
      }

      chunks = retained();
    }

    const upload = await this.createUpload(key, options);
    let size = 0;
    const parts: S3PartType[] = [];

    try {
      const uploaded = pooledMap(
        this.#concurrency,
        chunks,
        (chunk) => this.#uploadChunk(upload, chunk, options.signal),
      );
      for await (const result of uploaded) {
        parts.push(result.part);
        size += result.size;
      }

      if (parts.length === 0) {
        await this.abortUpload(upload, options.signal);
        return await this.#putBytes(key, new Uint8Array(), options);
      }
      if (options.size !== undefined && size !== options.size) {
        throw new RangeError(`S3 streamed body produced ${size} bytes but options.size declared ${options.size}.`);
      }

      await this.completeUpload(upload, parts, {
        ...(options.ifMatch === undefined ? {} : { ifMatch: options.ifMatch }),
        ...(options.ifNoneMatch === undefined ? {} : { ifNoneMatch: options.ifNoneMatch }),
        expectedSize: size,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return (await this.head(key, options)) ?? { size };
    } catch (error) {
      // Caller cancellation ends the write, but it must not also cancel the
      // request that releases provider-side multipart state. Cleanup gets its
      // own bounded signal so a failed provider cannot delay shutdown forever.
      await this.abortUpload(upload, AbortSignal.timeout(this.#abortTimeoutMs)).catch(() => undefined);
      throw error;
    }
  }

  /** Removes one exact object. A missing object is treated as already removed. */
  async delete(key: string, options?: { readonly signal?: AbortSignal }): Promise<void> {
    const response = await this.request({
      method: "DELETE",
      key,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    if (response.status === 404) return;
    await assertResponse(response, `DeleteObject ${key}`);
  }

  /** Lists one S3 `ListObjectsV2` page and preserves its continuation token. */
  async list(options: ObjectListOptionsType): Promise<ObjectListType> {
    const response = await assertResponse(
      await this.request({
        method: "GET",
        query: {
          "list-type": "2",
          prefix: options.prefix,
          delimiter: options.delimiter,
          "max-keys": options.limit === undefined ? undefined : String(options.limit),
          "continuation-token": options.cursor,
        },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
      "ListObjectsV2",
    );
    const root = parseXmlRoot(await response.text());
    const objects: ObjectEntryType[] = getXmlElements(root, "Contents").map(getListObject);
    const prefixes = getXmlElements(root, "CommonPrefixes")
      .map((entry) => getXmlValue(entry, "Prefix"))
      .filter((value): value is string => value !== undefined);
    const cursor = getXmlValue(root, "NextContinuationToken");
    return { objects, prefixes, ...(cursor === undefined ? {} : { cursor }) };
  }

  /**
   * Copies one object inside S3 without downloading the source through JS.
   *
   * `CopyObject` handles sources up to the documented 5 GB limit. Larger
   * sources use multipart `UploadPartCopy`. Destination preconditions are
   * applied to `CopyObject` directly or to `CompleteMultipartUpload` so the
   * copy cannot silently replace a destination that changed during the copy.
   */
  async copy(source: string, destination: string, options: ObjectCopyOptionsType = {}): Promise<ObjectStatType> {
    const sourceStat = await this.head(source, options);
    if (sourceStat === null) {
      throw new S3Error(`Copy source '${source}' does not exist.`, new Response(null, { status: 404 }));
    }
    if (sourceStat.size > S3_LIMITS.maxObjectBytes) {
      throw new RangeError(`S3 copy source exceeds ${S3_LIMITS.maxObjectBytes} bytes.`);
    }

    if (sourceStat.size <= S3_LIMITS.maxCopyBytes) {
      const response = await this.request({
        method: "PUT",
        key: destination,
        headers: this.#getCopyHeaders(source, options),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      await getSuccessXml(response, `CopyObject ${source} -> ${destination}`);
      return (await this.head(destination, options)) ?? { size: sourceStat.size };
    }

    const requiredPartSize = Math.ceil(sourceStat.size / S3_LIMITS.maxParts);
    const copyPartSize = Math.max(this.#copyPartSize, requiredPartSize);
    if (copyPartSize > S3_LIMITS.maxPartBytes) {
      throw new RangeError(`S3 server-side copy requires parts larger than ${S3_LIMITS.maxPartBytes} bytes.`);
    }

    const upload = await this.createUpload(destination, {
      ...(sourceStat.mediaType === undefined ? {} : { mediaType: sourceStat.mediaType }),
      ...(sourceStat.metadata === undefined ? {} : { metadata: sourceStat.metadata }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    try {
      const copied = pooledMap(
        this.#concurrency,
        getCopyRanges(sourceStat.size, copyPartSize),
        (range) => this.#copyPart(source, upload, range, options),
      );
      const parts = await Array.fromAsync(copied);
      await this.completeUpload(upload, parts, {
        ...(options.ifMatch === undefined ? {} : { ifMatch: options.ifMatch }),
        ...(options.ifNoneMatch === undefined ? {} : { ifNoneMatch: options.ifNoneMatch }),
        expectedSize: sourceStat.size,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return (await this.head(destination, options)) ?? { size: sourceStat.size };
    } catch (error) {
      // Caller cancellation ends the write, but it must not also cancel the
      // request that releases provider-side multipart state. Cleanup gets its
      // own bounded signal so a failed provider cannot delay shutdown forever.
      await this.abortUpload(upload, AbortSignal.timeout(this.#abortTimeoutMs)).catch(() => undefined);
      throw error;
    }
  }
}

/**
 * Creates a direct S3-compatible REST client without the AWS SDK dependency graph.
 *
 * The client uses Web Fetch and Web Crypto, signs requests with AWS Signature
 * Version 4, streams large replacements through multipart upload, and exposes
 * the lower-level signed request/multipart primitives needed for provider
 * extensions. Importing this module performs no network or credential work.
 *
 * @example Use a path-style S3-compatible endpoint.
 * ```ts
 * const client = createS3Client({
 *   endpoint: "http://127.0.0.1:8333",
 *   bucket: "opfs-test",
 *   region: "us-east-1",
 *   credentials: { accessKeyId: "admin", secretAccessKey: "secret" },
 * });
 *
 * await client.put("state.json", new TextEncoder().encode("{}"));
 * ```
 */
export function createS3Client(options: S3ClientOptionsType): S3ClientType {
  return new S3Client(options);
}
