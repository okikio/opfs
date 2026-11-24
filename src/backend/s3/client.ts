/**
 * S3 and S3-compatible object storage over Web Fetch with Signature Version 4.
 *
 * {@link createS3Client} returns an {@link S3ClientType}: get, put, head, list,
 * copy, delete and multipart upload. The client signs each attempt again, retries
 * only bodies it can replay, and reports a commit receipt for each write. Signing is in
 * `./sign.ts`, response parsing is in `./response.ts`, multipart helpers are in
 * `./upload.ts`, and the option types are in `./types.ts`.
 *
 * @module
 */
import { S3_LIMITS, S3AddressingSchema, S3CredentialsSchema, S3ListEncodingSchema } from "./schema.ts";
import {
  DEFAULT_COPY_PART_SIZE,
  DEFAULT_PART_SIZE,
  getChunks,
  getCompleteBody,
  getCopyRanges,
  normalizeParts,
} from "./upload.ts";
import { assertResponse, decodeListIdentity, getListObject, getReceipt, getStat, getSuccessXml } from "./response.ts";
import {
  compareText,
  encode,
  encodePath,
  getAmzDate,
  getHeaderValue,
  getHmac,
  getPayloadHash,
  getQueryString,
  getSha256,
  getSigningKey,
} from "./sign.ts";
import { S3CommitError, S3Error } from "./error.ts";
import type {
  S3AddressingType,
  S3ChunkSourceType,
  S3ChunkType,
  S3ClientOptionsType,
  S3ClientType,
  S3CommitType,
  S3CompleteOptionsType,
  S3CopyRangeType,
  S3CredentialSourceType,
  S3CredentialsType,
  S3ListEncodingType,
  S3PartPageType,
  S3PartType,
  S3PublicationType,
  S3RequestOptionsType,
  S3StoredPartType,
  S3UploadedChunkType,
  S3UploadType,
} from "./types.ts";
import { assertRangeResponse, resolveRange } from "../../range.ts";
import type { DriverPlanInputType, DriverPlanType } from "../../driver/definition.ts";
import { map } from "../../pool.ts";
import { encodeHex } from "@std/encoding/hex";

import { isBuffer, isBytes, toRequestBuffer, toRequestBytes } from "../../bytes.ts";
import { assertRequestStream, isStream } from "../../body.ts";
import { close } from "../../close.ts";
import { applyProperties, resolveETag, resolveETagCopy, resolveETagPut } from "../../publication.ts";
import type { ResponseTextType } from "../../response.ts";
import { readResponse } from "../../response.ts";
import {
  type FetchType,
  RequestMetrics,
  type RequestMetricsType,
  type RequestPolicyType,
  sendRequest,
} from "../../request.ts";
import { type AdapterLimitsType, MetricsModeSchema, type MetricsModeType } from "../../schema/mod.ts";
import { getXmlElements, getXmlScalar, getXmlText, getXmlValue, parseXmlRoot } from "../../xml.ts";

import type {
  ObjectCopyOptionsType,
  ObjectDeleteOptionsType,
  ObjectEntryType,
  ObjectGetOptionsType,
  ObjectListOptionsType,
  ObjectListType,
  ObjectPutOptionsType,
  ObjectReceiptType,
  ObjectStatType,
} from "../../driver/object.ts";

/** Default time allowed for cleanup after streamed multipart work becomes terminal. */
const DEFAULT_ABORT_TIMEOUT_MS = 30_000;

/** Resolves static or refreshable credentials immediately before signing. */
async function getCredentials(source: S3CredentialSourceType): Promise<S3CredentialsType> {
  return S3CredentialsSchema.parse(typeof source === "function" ? await source() : source);
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
  /** Resolved provider listing dialect, kept distinct from optimization switches. */
  readonly #listEncoding: S3ListEncodingType;
  /** Reads the immutable identity policy without probing the provider. */
  get listEncoding(): S3ListEncodingType {
    return this.#listEncoding;
  }
  /** Stable object-store name exposed to the adapter and diagnostics. */
  readonly name = "s3";
  /** Credential-free namespace used to bind persistent source identities. */
  readonly identity: string;
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
  readonly #fetch: FetchType;
  /** Only an omitted Fetch selects the native raw-stream capability contract. */
  readonly #nativeFetch: boolean;
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
  /** Maximum time allowed for owned AbortMultipartUpload cleanup. */
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
    this.identity = JSON.stringify(["s3", this.#endpoint.origin, this.#endpoint.pathname, this.#bucket]);
    this.#region = options.region;
    this.#credentials = options.credentials;
    this.#addressing = S3AddressingSchema.parse(options.addressing ?? "path");
    this.#listEncoding = S3ListEncodingSchema.parse(options.listEncoding ?? "percent");
    const suppliedFetch = options.fetch;
    this.#fetch = suppliedFetch ?? fetch;
    this.#nativeFetch = suppliedFetch === undefined || suppliedFetch === null;
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
    if (key === "") throw new TypeError("Object requests require a nonempty key; omit key for container operations.");
    const endpointPath = this.#endpoint.pathname.replace(/\/$/, "");
    const objectPath = key === undefined || key.length === 0 ? "" : `/${encodePath(key)}`;
    const bucketPath = this.#addressing === "path" ? `/${encode(this.#bucket)}` : "";
    const canonicalUri = `${endpointPath}${bucketPath}${objectPath}` || "/";
    const url = new URL(this.#endpoint);
    url.pathname = canonicalUri;
    if (url.pathname !== canonicalUri) throw new TypeError("Object key cannot be represented by a Fetch URL.");
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
  #getCopyHeaders(source: string, options: ObjectCopyOptionsType, version?: string): Headers {
    const address = `/${encode(this.#bucket)}/${encodePath(source)}${
      version === undefined ? "" : `?versionId=${encode(version)}`
    }`;
    const headers = new Headers({ "x-amz-copy-source": address });
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

  /** Snapshots applied properties through the same Fetch header normalization as dispatch. */
  #getPropertyHeaders(options: ObjectPutOptionsType): Headers {
    const headers = new Headers(this.#headers);
    if (options.mediaType !== undefined) headers.set("content-type", options.mediaType);
    for (const [name, value] of Object.entries(options.metadata ?? {})) headers.set(`x-amz-meta-${name}`, value);
    return headers;
  }

  /** Writes one materialized object with PutObject and optional write preconditions. */
  async #putBytes(key: string, body: Uint8Array, options: ObjectPutOptionsType): Promise<ObjectReceiptType> {
    if (!isBytes(body)) throw new TypeError("A materialized upload body must be a readable Uint8Array.");
    body = toRequestBytes(body);
    if (options.size !== undefined && options.size !== body.byteLength) {
      throw new RangeError("S3 body length does not match options.size.");
    }
    if (body.byteLength > S3_LIMITS.maxPutBytes) {
      throw new RangeError(
        `S3 PutObject accepts at most ${S3_LIMITS.maxPutBytes} bytes. Use a stream for multipart upload.`,
      );
    }
    const headers = this.#getPropertyHeaders(options);
    if (options.ifMatch !== undefined) headers.set("if-match", options.ifMatch);
    if (options.ifNoneMatch !== undefined) headers.set("if-none-match", options.ifNoneMatch);

    const response = await this.#publish({
      method: "PUT",
      key,
      headers,
      body: body as Uint8Array<ArrayBuffer>,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, (response, text) => assertResponse(response, `PutObject ${key}`, text));
    return getReceipt(response, body.byteLength, options);
  }

  /** Copies one source range into one destination multipart part. */
  async #copyPart(
    source: string,
    upload: S3UploadType,
    range: S3CopyRangeType,
    options: ObjectCopyOptionsType,
    version?: string,
  ): Promise<S3PartType> {
    const headers = this.#getCopyHeaders(source, options, version);
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
    return await readResponse(response, async (text) => {
      const root = await getSuccessXml(
        response,
        `UploadPartCopy ${source}[${range.start}-${range.end}] -> ${upload.key}#${range.number}`,
        text,
      );
      if (root.name.local !== "CopyPartResult") {
        throw new S3Error("Unexpected UploadPartCopy acknowledgement.", response);
      }
      const etag = getXmlScalar(root, "ETag");
      return { number: range.number, etag };
    });
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
    return await this.#send(options);
  }

  /** Tracks actual dispatch separately from signing and local validation. */
  async #send(options: S3RequestOptionsType, onDispatch?: () => void): Promise<Response> {
    const source = options.body;
    const body = ArrayBuffer.isView(source)
      ? toRequestBytes(source)
      : isBuffer(source)
      ? toRequestBuffer(source)
      : source;
    const payloadHash = options.payloadHash ?? await getPayloadHash(body);
    // Body replayability and protocol idempotency are separate. A byte body can
    // be replayed mechanically while an operation such as CreateMultipartUpload
    // can still allocate a second server-side resource.
    const streamed = isStream(body);
    const replayable = options.retry !== false && !streamed;

    return await sendRequest(async (signal) => {
      if (streamed && this.#nativeFetch) assertRequestStream();
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
        ...(body === undefined ? {} : { body }),
        ...(signal === undefined ? {} : { signal }),
      };
      if (streamed) init.duplex = "half";
      return { input: url, init };
    }, {
      fetch: (input, init) => {
        onDispatch?.();
        return this.#fetch(input, init);
      },
      ...(this.#requestPolicy === undefined ? {} : { policy: this.#requestPolicy }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      replayable,
      ...(this.#metrics === undefined ? {} : { metrics: this.#metrics }),
    });
  }

  /** Pure admission for the concrete wire route; no credentials, stream reads, or I/O. */
  admit(input: DriverPlanInputType): DriverPlanType {
    const plan: DriverPlanType = {
      operation: input.operation,
      supported: true,
      support: "native",
      problems: [],
      actions: [],
    };
    try {
      if ((input.operation === "copy" || input.operation === "move") && !this.capabilities.copy) {
        throw new TypeError("S3 server-side copy is disabled for this client.");
      }
      if (input.path !== undefined) this.#address(input.path.slice(1));
      if (input.destination !== undefined) this.#address(input.destination.slice(1));
      if (input.size !== undefined && input.size > S3_LIMITS.maxObjectBytes) {
        throw new RangeError("Object exceeds the S3 object size limit.");
      }
      if (
        input.operation === "write" && input.source === "bytes" && input.size !== undefined &&
        input.size > S3_LIMITS.maxPutBytes
      ) {
        throw new RangeError("Materialized S3 writes exceed PutObject; supply a stream for multipart upload.");
      }
      if (input.operation === "write" && input.source === "stream") {
        const partBytes = this.#getPartSize(input.size);
        return {
          ...plan,
          support: "partitioned",
          partBytes,
          ...(input.size === undefined || input.size === 0 ? {} : { parts: Math.ceil(input.size / partBytes) }),
        };
      }
      return plan;
    } catch (error) {
      return {
        ...plan,
        supported: false,
        support: "unsupported",
        problems: [{
          code: "provider-route",
          layer: "driver",
          severity: "error",
          message: error instanceof Error ? error.message : String(error),
        }],
        actions: [{ kind: "select-driver" }],
      };
    }
  }

  /** Actual response/parser events own publication disposition, never error classes. */
  async #publish<T>(
    options: S3RequestOptionsType,
    read: (response: Response, text: ResponseTextType, rejected: () => void) => Promise<T>,
    disposition: S3PublicationType = { phase: "not-dispatched" },
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.#send({ ...options, retry: false }, () => {
        disposition.phase = "unknown";
      });
    } catch (error) {
      if (disposition.phase === "not-dispatched") throw error;
      throw new S3CommitError(options.key ?? "", error);
    }
    if (response.status >= 300 && response.status < 500) disposition.phase = "rejected";
    return await readResponse(response, async (text) => {
      try {
        const value = await read(response, text, () => {
          disposition.phase = "rejected";
        });
        disposition.phase = "acknowledged";
        return value;
      } catch (error) {
        if (disposition.phase === "rejected") throw error;
        disposition.phase = "unknown";
        throw new S3CommitError(options.key ?? "", error);
      }
    });
  }

  /** Returns exact-object metadata, or `null` when the object does not exist. */
  async head(key: string, options?: { readonly signal?: AbortSignal }): Promise<ObjectStatType | null> {
    const response = await this.request({
      method: "HEAD",
      key,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    return await readResponse(response, async (text) => {
      if (response.status === 404) return null;
      await assertResponse(response, `HeadObject ${key}`, text);
      return getStat(response.headers);
    });
  }

  /** Opens an S3 object or byte range as a Web `ReadableStream`. */
  async get(key: string, options: ObjectGetOptionsType = {}): Promise<ReadableStream<Uint8Array>> {
    const ifMatch = resolveETag(options.revision);
    const selected = resolveRange(options);
    if (selected.empty) return new Blob().stream();
    const headers = new Headers();
    if (ifMatch !== undefined) headers.set("if-match", ifMatch);
    if (selected.header !== undefined) headers.set("range", selected.header);
    const response = await assertResponse(
      await this.request({
        method: "GET",
        key,
        headers,
        ...(selected.signal === undefined ? {} : { signal: selected.signal }),
      }),
      `GetObject ${key}`,
    );
    await assertRangeResponse(response, selected);
    return response.body ?? new Blob().stream();
  }

  /**
   * Transfers one validated allocation only after response retirement succeeds.
   * A known allocation remains owned on failure and is aborted with a fresh,
   * bounded cleanup signal. Unknown/malformed allocation is never guessed.
   */
  async createUpload(key: string, options: ObjectPutOptionsType = {}): Promise<S3UploadType> {
    let upload: S3UploadType | undefined;
    try {
      return await this.#createUpload(key, options, (acquired) => {
        upload = acquired;
      });
    } catch (reason) {
      const owned = upload;
      await close([
        async () => {
          if (owned !== undefined) await this.abortUpload(owned, AbortSignal.timeout(this.#abortTimeoutMs));
        },
      ], [reason]);
      throw reason;
    }
  }

  /** Publishes the actual validated allocation to its owner before body retirement. */
  async #createUpload(
    key: string,
    options: ObjectPutOptionsType,
    acquired: (upload: S3UploadType) => void,
  ): Promise<S3UploadType> {
    const headers = this.#getPropertyHeaders(options);
    const response = await this.request({
      method: "POST",
      key,
      query: { uploads: "" },
      headers,
      retry: false,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return await readResponse(response, async (text) => {
      await assertResponse(response, `CreateMultipartUpload ${key}`, text);
      const root = parseXmlRoot(await text());
      if (root.name.local !== "InitiateMultipartUploadResult") {
        throw new SyntaxError("Unexpected multipart allocation acknowledgement.");
      }
      const id = getXmlText(root, "UploadId");
      if (id === undefined || id.length === 0) {
        throw new S3Error("CreateMultipartUpload response did not contain UploadId.", response);
      }
      // Required direct-scalar structure authorizes acquisition; retain the
      // provider's decoded opaque text rather than reconstructing its identity.
      getXmlScalar(root, "UploadId");
      const upload = { key, id };
      acquired(upload);
      return upload;
    });
  }

  /** Uploads one legal multipart part and retains the ETag required at completion. */
  async uploadPart(upload: S3UploadType, number: number, bytes: Uint8Array, signal?: AbortSignal): Promise<S3PartType> {
    if (!Number.isSafeInteger(number) || number < 1 || number > S3_LIMITS.maxParts) {
      throw new RangeError(`S3 part number must be between 1 and ${S3_LIMITS.maxParts}.`);
    }
    if (!isBytes(bytes)) throw new TypeError("An upload part must be a readable Uint8Array.");
    bytes = toRequestBytes(bytes);
    if (bytes.byteLength > S3_LIMITS.maxPartBytes) {
      throw new RangeError(`S3 multipart parts cannot exceed ${S3_LIMITS.maxPartBytes} bytes.`);
    }
    const response = await this.request({
      method: "PUT",
      key: upload.key,
      query: { partNumber: String(number), uploadId: upload.id },
      body: bytes as Uint8Array<ArrayBuffer>,
      ...(signal === undefined ? {} : { signal }),
    });
    return await readResponse(response, async (text) => {
      await assertResponse(response, `UploadPart ${upload.key}#${number}`, text);
      const etag = response.headers.get("etag");
      if (etag === null) throw new S3Error(`UploadPart ${number} response did not contain ETag.`, response);
      return { number, etag };
    });
  }

  /** Reads at most 1,000 retained parts without treating an empty page as completion. */
  async listParts(upload: S3UploadType, cursor = 0, signal?: AbortSignal): Promise<S3PartPageType> {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor >= S3_LIMITS.maxParts) {
      throw new RangeError("Invalid S3 multipart listing cursor.");
    }
    const response = await this.request({
      method: "GET",
      key: upload.key,
      query: { uploadId: upload.id, "max-parts": "1000", "part-number-marker": String(cursor) },
      ...(signal === undefined ? {} : { signal }),
    });
    return await readResponse(response, async (text) => {
      await assertResponse(response, `ListParts ${upload.key}`, text);
      const root = parseXmlRoot(await text());
      if (root.name.local !== "ListPartsResult" || getXmlScalar(root, "UploadId") !== upload.id) {
        throw new SyntaxError("Multipart listing does not identify this upload.");
      }
      const keys = getXmlElements(root, "Key");
      if (
        keys.length !== 1 || !root.children.includes(keys[0]!) ||
        keys[0]!.children.some((node) => node.type === "element") || getXmlText(root, "Key") !== upload.key
      ) throw new SyntaxError("Multipart listing identifies a different object key.");
      const integer = (value: string): number => {
        if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
          throw new SyntaxError("Invalid multipart listing integer.");
        }
        return Number(value);
      };
      const nodes = getXmlElements(root, "Part");
      if (nodes.length > 1000 || nodes.some((node) => !root.children.includes(node))) {
        throw new SyntaxError("Multipart listing exceeds one direct provider page.");
      }
      let previous = cursor;
      const parts = nodes.map((node): S3StoredPartType => {
        const number = integer(getXmlScalar(node, "PartNumber"));
        const size = integer(getXmlScalar(node, "Size"));
        if (number <= previous || number > S3_LIMITS.maxParts || size > S3_LIMITS.maxPartBytes) {
          throw new SyntaxError("Multipart listing contains unordered or out-of-range parts.");
        }
        previous = number;
        return { number, size, etag: getXmlScalar(node, "ETag") };
      });
      const truncated = getXmlScalar(root, "IsTruncated");
      if (truncated === "false") return { parts };
      if (truncated !== "true") throw new SyntaxError("Invalid multipart truncation flag.");
      const next = integer(getXmlScalar(root, "NextPartNumberMarker"));
      if (next <= cursor || next < previous || next >= S3_LIMITS.maxParts) {
        throw new SyntaxError("Multipart listing cursor did not advance within the part limit.");
      }
      return { parts, cursor: next };
    });
  }

  /** Commits uploaded parts after validating part identity and ordering. */
  async completeUpload(
    upload: S3UploadType,
    parts: readonly S3PartType[],
    options: S3CompleteOptionsType = {},
  ): Promise<S3CommitType> {
    return await this.#completeUpload(upload, parts, options);
  }

  /** Carries this final attempt's disposition through independent reader cleanup. */
  async #completeUpload(
    upload: S3UploadType,
    parts: readonly S3PartType[],
    options: S3CompleteOptionsType,
    disposition: S3PublicationType = { phase: "not-dispatched" },
  ): Promise<S3CommitType> {
    if (
      options.expectedSize !== undefined &&
      (!Number.isSafeInteger(options.expectedSize) || options.expectedSize < 0 ||
        options.expectedSize > S3_LIMITS.maxObjectBytes)
    ) {
      throw new RangeError("Invalid expected multipart object size.");
    }
    const normalized = normalizeParts(parts);
    const headers = new Headers({ "content-type": "application/xml" });
    if (options.ifMatch !== undefined) headers.set("if-match", options.ifMatch);
    if (options.ifNoneMatch !== undefined) headers.set("if-none-match", options.ifNoneMatch);
    if (options.expectedSize !== undefined) headers.set("x-amz-mp-object-size", String(options.expectedSize));

    return await this.#publish({
      method: "POST",
      key: upload.key,
      query: { uploadId: upload.id },
      headers,
      body: getCompleteBody(normalized),
      retry: false,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, async (response, text, rejected) => {
      // The whole XML body is commit authority; HTTP 200 can still contain Error.
      const root = await getSuccessXml(response, `CompleteMultipartUpload ${upload.key}`, text, rejected);
      if (root.name.local !== "CompleteMultipartUploadResult") {
        throw new SyntaxError("Unexpected multipart acknowledgement.");
      }
      const etag = getXmlScalar(root, "ETag");
      return {
        etag,
        ...(response.headers.get("x-amz-version-id") === null
          ? {}
          : { version: response.headers.get("x-amz-version-id")! }),
        ...(response.headers.get("x-amz-request-id") === null
          ? {}
          : { requestId: response.headers.get("x-amz-request-id")! }),
      };
    }, disposition);
  }

  /** Aborts one unfinished multipart upload. Missing upload IDs are already terminal. */
  async abortUpload(upload: S3UploadType, signal?: AbortSignal): Promise<void> {
    const response = await this.request({
      method: "DELETE",
      key: upload.key,
      query: { uploadId: upload.id },
      ...(signal === undefined ? {} : { signal }),
    });
    await readResponse(response, async (text) => {
      if (response.status === 404) return;
      await assertResponse(response, `AbortMultipartUpload ${upload.key}`, text);
    });
  }

  /**
   * Replaces one object with bounded, input-ordered multipart admission.
   *
   * This invocation owns its source from acquisition through delayed probing,
   * initialization, active parts and final acknowledgement. Failed part mapping
   * interrupts pending input without aborting already-admitted requests. Their
   * outcomes drain before remote abort. The final attempt's own disposition,
   * never a thrown class, decides whether multipart abort remains safe.
   */
  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    options: ObjectPutOptionsType = {},
  ): Promise<ObjectReceiptType> {
    options = resolveETagPut(options);
    const properties = getStat(this.#getPropertyHeaders(options));
    options = applyProperties(options, properties);
    this.#address(key);
    // Intrinsic byte admission includes genuine foreign-realm views. A detached
    // or out-of-bounds view must not fall through as an apparent empty stream.
    if (isBytes(body)) return await this.#putBytes(key, body, options);
    if (!isStream(body)) {
      throw new TypeError("An upload body must be readable Uint8Array bytes or a native ReadableStream.");
    }

    const chunks = getChunks(body, this.#getPartSize(options.size), options.signal);
    const disposition: S3PublicationType = { phase: "not-dispatched" };
    let retired = false;
    let upload: S3UploadType | undefined;
    let primary: readonly unknown[] = [];
    const retire = async (): Promise<void> => {
      if (retired) return;
      // This marks observation ownership, not successful cleanup. A rejected
      // retirement is submitted to the current scope once, never attempted twice.
      retired = true;
      await chunks.return?.();
    };
    try {
      const prefix: S3ChunkType[] = [];
      if (this.optimizations.delayedMultipart) {
        const first = await chunks.next();
        if (first.done) {
          await retire();
          return await this.#putBytes(key, new Uint8Array(), options);
        }
        const second = await chunks.next();
        if (second.done && first.value.bytes.byteLength <= S3_LIMITS.maxPutBytes) {
          if (options.size !== undefined && first.value.bytes.byteLength !== options.size) {
            throw new RangeError(
              `S3 streamed body produced ${first.value.bytes.byteLength} bytes but options.size declared ${options.size}.`,
            );
          }
          await retire();
          return await this.#putBytes(key, first.value.bytes, options);
        }
        prefix.push(first.value);
        if (!second.done) prefix.push(second.value);
      }
      upload = await this.#createUpload(key, options, (acquired) => {
        upload = acquired;
      });
      const active = upload;
      const input: S3ChunkSourceType = {
        async next() {
          const value = prefix.shift();
          return value === undefined ? await chunks.next() : { done: false, value };
        },
        async return() {
          await retire();
          return { done: true, value: undefined };
        },
        interrupt: () => chunks.interrupt(),
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      let size = 0;
      const parts: S3PartType[] = [];
      for await (
        const result of map(
          this.#concurrency,
          input,
          (chunk) => this.#uploadChunk(active, chunk, options.signal),
          { interrupt: () => input.interrupt() },
        )
      ) {
        parts.push(result.part);
        size += result.size;
      }
      if (options.size !== undefined && size !== options.size) {
        throw new RangeError(`S3 streamed body produced ${size} bytes but options.size declared ${options.size}.`);
      }
      if (parts.length === 0) {
        // Submit this abort once even when its own response retirement rejects.
        upload = undefined;
        await this.abortUpload(active, AbortSignal.timeout(this.#abortTimeoutMs));
        return await this.#putBytes(key, new Uint8Array(), options);
      }
      const receipt = await this.#completeUpload(active, parts, {
        ...(options.ifMatch === undefined ? {} : { ifMatch: options.ifMatch }),
        ...(options.ifNoneMatch === undefined ? {} : { ifNoneMatch: options.ifNoneMatch }),
        expectedSize: size,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }, disposition);
      return {
        size,
        ...receipt,
        ...(options.mediaType === undefined ? {} : { mediaType: options.mediaType }),
        ...(options.metadata === undefined ? {} : { metadata: { ...options.metadata } }),
      };
    } catch (reason) {
      primary = [reason];
      throw reason;
    } finally {
      const owned = upload;
      await close([
        retire,
        async () => {
          if (
            primary.length > 0 && owned !== undefined &&
            (disposition.phase === "not-dispatched" || disposition.phase === "rejected")
          ) {
            await this.abortUpload(owned, AbortSignal.timeout(this.#abortTimeoutMs));
          }
        },
      ], primary);
    }
  }

  /** Removes one exact object. A missing object is treated as already removed. */
  async delete(key: string, options?: ObjectDeleteOptionsType): Promise<void> {
    const ifMatch = resolveETag(options?.revision);
    const response = await this.request({
      method: "DELETE",
      key,
      ...(ifMatch === undefined ? {} : { headers: new Headers({ "if-match": ifMatch }) }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    await readResponse(response, async (text) => {
      if (response.status === 404) return;
      await assertResponse(response, `DeleteObject ${key}`, text);
    });
  }

  /** Lists one S3 `ListObjectsV2` page and preserves its continuation token. */
  async list(options: ObjectListOptionsType): Promise<ObjectListType> {
    const response = await this.request({
      method: "GET",
      query: {
        "list-type": "2",
        "encoding-type": "url",
        prefix: options.prefix,
        delimiter: options.delimiter,
        "max-keys": options.limit === undefined ? undefined : String(options.limit),
        "continuation-token": options.cursor,
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return await readResponse(response, async (text) => {
      await assertResponse(response, "ListObjectsV2", text);
      const root = parseXmlRoot(await text());
      const encoded = getXmlValue(root, "EncodingType") === "url";
      const objects: ObjectEntryType[] = getXmlElements(root, "Contents").map((entry) =>
        getListObject(entry, encoded, this.listEncoding)
      );
      const prefixes = getXmlElements(root, "CommonPrefixes")
        .map((entry) => getXmlText(entry, "Prefix"))
        .filter((value): value is string => value !== undefined)
        .map((value) => encoded ? decodeListIdentity(value, this.listEncoding) : value);
      const cursor = getXmlText(root, "NextContinuationToken");
      return { objects, prefixes, ...(cursor === undefined ? {} : { cursor }) };
    });
  }

  /**
   * Copies one object inside S3 without downloading the source through JS.
   *
   * `CopyObject` handles sources up to the documented 5 GB limit. Larger
   * sources use multipart `UploadPartCopy`. Destination preconditions are
   * applied to `CopyObject` directly or to `CompleteMultipartUpload` so the
   * copy cannot silently replace a destination that changed during the copy.
   */
  async copy(source: string, destination: string, options: ObjectCopyOptionsType = {}): Promise<ObjectReceiptType> {
    options = resolveETagCopy(options);
    if (!this.capabilities.copy) throw new TypeError("S3 server-side copy is disabled for this client.");
    this.#address(destination);
    const sourceHeaders = new Headers();
    if (options.sourceIfMatch !== undefined) sourceHeaders.set("if-match", options.sourceIfMatch);
    if (options.sourceIfNoneMatch !== undefined) sourceHeaders.set("if-none-match", options.sourceIfNoneMatch);
    if (options.sourceIfModifiedSince !== undefined) {
      sourceHeaders.set("if-modified-since", options.sourceIfModifiedSince.toUTCString());
    }
    if (options.sourceIfUnmodifiedSince !== undefined) {
      sourceHeaders.set("if-unmodified-since", options.sourceIfUnmodifiedSince.toUTCString());
    }
    const sourceResponse = await this.request({
      method: "HEAD",
      key: source,
      headers: sourceHeaders,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const sourceStat = await readResponse(
      sourceResponse,
      async (text) =>
        sourceResponse.status === 404
          ? null
          : getStat((await assertResponse(sourceResponse, "Read copy source properties", text)).headers),
    );
    if (sourceStat === null) {
      throw new S3Error(`Copy source '${source}' does not exist.`, new Response(null, { status: 404 }));
    }
    if (sourceStat.etag === undefined) throw new TypeError("S3 copy requires a source ETag to pin its bytes.");
    options = { ...options, sourceIfMatch: sourceStat.etag };
    if (sourceStat.size > S3_LIMITS.maxObjectBytes) {
      throw new RangeError(`S3 copy source exceeds ${S3_LIMITS.maxObjectBytes} bytes.`);
    }

    if (sourceStat.size <= S3_LIMITS.maxCopyBytes) {
      return await this.#publish({
        method: "PUT",
        key: destination,
        headers: this.#getCopyHeaders(source, options, sourceStat.version),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }, async (response, text, rejected) => {
        const root = await getSuccessXml(response, `CopyObject ${source} -> ${destination}`, text, rejected);
        if (root.name.local !== "CopyObjectResult") throw new SyntaxError("Unexpected copy acknowledgement.");
        const etag = getXmlScalar(root, "ETag");
        return getReceipt(
          response,
          sourceStat.size,
          sourceStat.version === undefined || sourceStat.version === "null" ? {} : sourceStat,
          etag,
        );
      });
    }

    const requiredPartSize = Math.ceil(sourceStat.size / S3_LIMITS.maxParts);
    const copyPartSize = Math.max(this.#copyPartSize, requiredPartSize);
    if (copyPartSize > S3_LIMITS.maxPartBytes) {
      throw new RangeError(`S3 server-side copy requires parts larger than ${S3_LIMITS.maxPartBytes} bytes.`);
    }

    let upload: S3UploadType | undefined;
    const disposition: S3PublicationType = { phase: "not-dispatched" };
    let primary: readonly unknown[] = [];
    try {
      const active = await this.#createUpload(destination, {
        ...(sourceStat.mediaType === undefined ? {} : { mediaType: sourceStat.mediaType }),
        ...(sourceStat.metadata === undefined ? {} : { metadata: sourceStat.metadata }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }, (acquired) => {
        upload = acquired;
      });
      const copied = map(
        this.#concurrency,
        getCopyRanges(sourceStat.size, copyPartSize),
        (range) => this.#copyPart(source, active, range, options, sourceStat.version),
      );
      const parts = await Array.fromAsync(copied);
      const receipt = await this.#completeUpload(active, parts, {
        ...(options.ifMatch === undefined ? {} : { ifMatch: options.ifMatch }),
        ...(options.ifNoneMatch === undefined ? {} : { ifNoneMatch: options.ifNoneMatch }),
        expectedSize: sourceStat.size,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }, disposition);
      return {
        size: sourceStat.size,
        ...receipt,
        ...(sourceStat.mediaType === undefined ? {} : { mediaType: sourceStat.mediaType }),
        ...(sourceStat.metadata === undefined ? {} : { metadata: { ...sourceStat.metadata } }),
      };
    } catch (reason) {
      primary = [reason];
      throw reason;
    } finally {
      await close([
        async () => {
          if (
            primary.length > 0 && upload !== undefined &&
            (disposition.phase === "not-dispatched" || disposition.phase === "rejected")
          ) {
            await this.abortUpload(upload, AbortSignal.timeout(this.#abortTimeoutMs));
          }
        },
      ], primary);
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

export type {
  S3AddressingType,
  S3ClientOptionsType,
  S3ClientType,
  S3CommitType,
  S3CompleteOptionsType,
  S3CredentialSourceType,
  S3CredentialsType,
  S3LimitsType,
  S3ListEncodingType,
  S3PartPageType,
  S3PartType,
  S3RequestOptionsType,
  S3StoredPartType,
  S3UploadType,
} from "./types.ts";

export { S3CommitError, S3Error } from "./error.ts";

export { S3_LIMITS, S3AddressingSchema, S3CredentialsSchema } from "./schema.ts";
