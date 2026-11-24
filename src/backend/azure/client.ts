/**
 * Azure Blob Storage over Web Fetch, without the Azure SDK.
 *
 * {@link createAzureClient} returns an {@link AzureClientType}: range reads,
 * block uploads, conditional replace, list pages and server-side copy, with SAS,
 * bearer or Shared Key authorization. Authorization is in `./sign.ts`, version
 * limits are in `./limits.ts`, block helpers are in `./block.ts`, response
 * parsing is in `./response.ts`, and the option types are in `./types.ts`.
 *
 * @module
 */
import { DEFAULT_BLOCK_SIZE, getBlockListBody, getBlocks, getByteStream, getCopyBlocks } from "./block.ts";
import { assertResponse, getName, getReceipt, getStat } from "./response.ts";
import { encodePath, getBearerToken, getBodyLength, getSharedKeyAuthorization } from "./sign.ts";
import {
  atLeast,
  AZURE_LIMITS,
  AZURE_STORAGE_VERSION,
  AzureStorageVersionSchema,
  getBlockLimit,
  getCopyBlockLimit,
  getPutBlobLimit,
  SHARED_KEY_VERSION,
  SOURCE_BEARER_VERSION,
  URL_COPY_VERSION,
} from "./limits.ts";
import { AzureCommitError, AzureError } from "./error.ts";
import type {
  AzureBlockType,
  AzureClientOptionsType,
  AzureClientType,
  AzureCopyBlockType,
  AzureCredentialType,
  AzureRequestOptionsType,
  AzureStorageVersionType,
} from "./types.ts";
import { assertRangeResponse, resolveRange } from "../../range.ts";
import type { DriverPlanInputType, DriverPlanType } from "../../driver/definition.ts";
import { map } from "../../pool.ts";

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
import { getXmlElements, getXmlText, getXmlValue, parseXmlRoot } from "../../xml.ts";

/**
 * Adds Azure metadata only after validating the provider's header contract.
 *
 * Azure accepts metadata names that start with a letter or underscore and then
 * contain only ASCII letters, digits, or underscores. Metadata values must also
 * be ASCII. Validate before request construction so a caller gets a local,
 * deterministic failure instead of a provider HTTP 400 after bytes may already
 * have been staged for a multipart write. `Headers.set()` remains responsible
 * for the ordinary HTTP header-value syntax, such as rejecting embedded CR/LF.
 */
function setMetadata(headers: Headers, metadata: Readonly<Record<string, string>> | undefined): void {
  const names = new Set<string>();
  for (const [name, value] of Object.entries(metadata ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new TypeError(
        `Azure metadata key ${JSON.stringify(name)} must start with a letter or underscore and contain only ASCII ` +
          "letters, numbers, or underscores.",
      );
    }
    const normalized = name.toLowerCase();
    if (names.has(normalized)) {
      throw new TypeError(`Azure metadata contains the case-insensitive duplicate key ${JSON.stringify(name)}.`);
    }
    names.add(normalized);
    for (const character of value) {
      if (character.codePointAt(0)! > 0x7f) {
        throw new TypeError(`Azure metadata value for ${JSON.stringify(name)} must contain only ASCII characters.`);
      }
    }
    headers.set(`x-ms-meta-${name}`, value);
  }
}

/**
 * Direct Azure Blob REST client.
 *
 * The client owns request construction, authentication, version-specific block
 * limits, block commit, provider-side copy, XML error parsing, and Azure
 * conditional headers. It does not read credentials from the environment and
 * performs no network work until a method is called.
 */
class AzureClient implements AzureClientType {
  /** Configured Blob service endpoint, including Azurite account path when present. */
  readonly #endpoint: URL;
  /** Container exposed by this client. */
  readonly #container: string;
  /** Authorization strategy supplied by the caller. */
  readonly #credential: AzureCredentialType;
  /** REST service version sent on every authorized request. */
  readonly #version: AzureStorageVersionType;
  /** Fetch implementation used for all provider traffic. */
  readonly #fetch: FetchType;
  /** Only an omitted Fetch selects the native raw-stream capability contract. */
  readonly #nativeFetch: boolean;
  /** Clock used for request authorization. */
  readonly #now: () => Date;
  /** Block size used by streamed uploads. */
  readonly #blockSize: number;
  /** Maximum active block requests. */
  readonly #concurrency: number;
  /** Headers inherited by every request before operation-specific headers. */
  readonly #headers: Headers;
  /** Retry/backoff and optional per-attempt deadline. */
  readonly #requestPolicy: RequestPolicyType | undefined;
  /** Selected request metrics detail. */
  readonly #metricsMode: MetricsModeType;
  /** Mutable request counters when metrics are enabled. */
  readonly #metrics: RequestMetrics | undefined;

  /** Stable object-store client name. */
  readonly name = "azure";
  /** Credential-free namespace used to bind persistent source identities. */
  readonly identity: string;
  /** Native operations guaranteed for this configured credential/version pair. */
  readonly capabilities: AzureClientType["capabilities"];
  /** Resolved behavior-changing client optimization switches. */
  readonly optimizations: Readonly<{ blockUpload: boolean; serverCopy: boolean }>;
  /** Portable Azure limits exposed to the filesystem planner. */
  readonly limits: AdapterLimitsType;

  /** Validates options and captures immutable client configuration. */
  constructor(options: AzureClientOptionsType) {
    this.#endpoint = new URL(options.endpoint);
    this.#container = options.container;
    this.identity = JSON.stringify(["azure", this.#endpoint.origin, this.#endpoint.pathname, this.#container]);
    this.#credential = options.credential;
    this.#version = AzureStorageVersionSchema.parse(options.version ?? AZURE_STORAGE_VERSION);
    const suppliedFetch = options.fetch;
    this.#fetch = suppliedFetch ?? fetch;
    this.#nativeFetch = suppliedFetch === undefined || suppliedFetch === null;
    this.#now = options.now ?? (() => new Date());
    const blockLimit = getBlockLimit(this.#version);
    this.#blockSize = options.blockSize ?? Math.min(DEFAULT_BLOCK_SIZE, blockLimit);
    this.#concurrency = options.concurrency ?? 4;
    this.#headers = new Headers(options.headers);
    this.#requestPolicy = options.request;
    this.#metricsMode = MetricsModeSchema.parse(options.metrics ?? "basic");
    this.#metrics = this.#metricsMode === "none" ? undefined : new RequestMetrics(this.#metricsMode === "timing");
    this.optimizations = Object.freeze({
      blockUpload: options.blockUpload ?? true,
      serverCopy: options.serverCopy ?? true,
    });

    if (this.#container.length === 0) throw new TypeError("Azure container cannot be empty.");
    if (this.#credential.kind === "shared-key" && !atLeast(this.#version, SHARED_KEY_VERSION)) {
      throw new RangeError(
        `Azure Shared Key support starts at Blob service version ${SHARED_KEY_VERSION}; received ${this.#version}.`,
      );
    }
    if (!Number.isSafeInteger(this.#blockSize) || this.#blockSize < 1 || this.#blockSize > blockLimit) {
      throw new RangeError(
        `Azure blockSize must be between 1 and ${blockLimit} bytes for service version ${this.#version}.`,
      );
    }
    if (!Number.isSafeInteger(this.#concurrency) || this.#concurrency < 1) {
      throw new RangeError("Azure concurrency must be a positive integer.");
    }

    const copy = atLeast(this.#version, URL_COPY_VERSION) && (
      this.#credential.kind === "sas" ||
      this.#credential.kind === "shared-key" ||
      (this.#credential.kind === "bearer" && atLeast(this.#version, SOURCE_BEARER_VERSION))
    );
    this.capabilities = {
      rangeRead: true,
      streamRead: true,
      streamWrite: this.optimizations.blockUpload,
      copy: this.optimizations.serverCopy && copy,
      conditionalWrite: true,
      multipart: this.optimizations.blockUpload,
      metadata: true,
      versions: false,
    };
    this.limits = {
      maxFileBytes: getBlockLimit(this.#version) * AZURE_LIMITS.maxCommittedBlocks,
      minPartBytes: 1,
      maxPartBytes: getBlockLimit(this.#version),
      maxParts: AZURE_LIMITS.maxCommittedBlocks,
      maxConcurrency: this.#concurrency,
    };
  }

  /** Preserves SAS signing fields and selects this client's operation version independently from `sv`. */
  #getAddress(key?: string): URL {
    if (key === "") throw new TypeError("Object requests require a nonempty key; omit key for container operations.");
    const url = new URL(this.#endpoint);
    const root = this.#endpoint.pathname.replace(/\/$/, "");
    const path = `${root}/${encodeURIComponent(this.#container)}${
      key === undefined || key.length === 0 ? "" : `/${encodePath(key)}`
    }`;
    url.pathname = path;
    if (url.pathname !== path) throw new TypeError("Blob key cannot be represented by a Fetch URL.");
    if (this.#credential.kind === "sas") {
      const params = new URLSearchParams(this.#credential.token.replace(/^\?/, ""));
      for (const [name, value] of params) url.searchParams.append(name, value);
      url.searchParams.set("api-version", this.#version);
    }
    return url;
  }

  /** Adds Shared Key, bearer, or caller-defined authorization after all signed headers exist. */
  async #authorize(method: string, url: URL, headers: Headers): Promise<void> {
    if (this.#credential.kind === "bearer") {
      headers.set("authorization", `Bearer ${await getBearerToken(this.#credential.token)}`);
      return;
    }
    if (this.#credential.kind === "shared-key") {
      headers.set(
        "authorization",
        await getSharedKeyAuthorization(
          method,
          url,
          headers,
          this.#credential.account,
          this.#credential.key,
          this.#version,
        ),
      );
      return;
    }
    if (this.#credential.kind === "headers") {
      const added = await this.#credential.get({ method, url, headers: new Headers(headers) });
      new Headers(added).forEach((value, name) => headers.set(name, value));
    }
  }

  /** Returns detached direct HTTP metrics without exposing mutable counters. */
  getMetrics(): RequestMetricsType {
    return this.#metrics?.snapshot() ?? { requests: 0, retries: 0, failures: 0, responses: 0, durationMs: 0 };
  }

  /**
   * Sends one Azure Blob REST request.
   *
   * Authorization is rebuilt for every retry so refreshed bearer/custom
   * credentials and Shared Key dates remain current. Redirects are surfaced to
   * the caller rather than allowing authorization headers to cross authorities.
   * ReadableStream bodies are one-shot and therefore receive exactly one attempt.
   *
   * Shared Key signing occurs after query parameters, `x-ms-version`, date,
   * operation headers, and content length are final. A streamed low-level body
   * must provide its own `content-length` when Shared Key is used because its
   * byte count cannot be derived without consuming the stream.
   */
  async request(options: AzureRequestOptionsType): Promise<Response> {
    return await this.#send(options);
  }

  /** Tracks actual dispatch separately from signing and local validation. */
  async #send(options: AzureRequestOptionsType, onDispatch?: () => void): Promise<Response> {
    const source = options.body;
    const body = ArrayBuffer.isView(source)
      ? toRequestBytes(source)
      : isBuffer(source)
      ? toRequestBuffer(source)
      : source;
    const streamed = isStream(body);
    const replayable = options.retry !== false && !streamed;
    return await sendRequest(async (signal) => {
      if (streamed && this.#nativeFetch) assertRequestStream();
      const url = this.#getAddress(options.key);
      for (const [name, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined) url.searchParams.set(name, value);
      }
      // A SAS sv governs signature verification; api-version governs operation semantics.
      // Keep the version used for limits authoritative even when a low-level query supplies one.
      if (this.#credential.kind === "sas") url.searchParams.set("api-version", this.#version);

      const headers = new Headers(this.#headers);
      new Headers(options.headers).forEach((value, name) => headers.set(name, value));
      headers.set("x-ms-version", this.#version);
      headers.set("x-ms-date", this.#now().toUTCString());

      const bodyLength = getBodyLength(body);
      if (
        bodyLength !== undefined && !headers.has("content-length") && options.method !== "GET" &&
        options.method !== "HEAD"
      ) {
        headers.set("content-length", String(bodyLength));
      }
      if (
        this.#credential.kind === "shared-key" && streamed &&
        !headers.has("content-length")
      ) {
        throw new TypeError(
          "Azure Shared Key requests with a streamed low-level body require an explicit content-length header.",
        );
      }
      await this.#authorize(options.method, url, headers);

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
      if (input.path !== undefined) this.#getAddress(input.path.slice(1));
      if (input.destination !== undefined) this.#getAddress(input.destination.slice(1));
      if (input.operation === "copy" && !this.capabilities.copy) {
        throw new TypeError("Native Azure copy is unavailable for this client configuration.");
      }
      if (input.operation === "write") {
        if (input.source === "stream" && !this.optimizations.blockUpload) {
          throw new TypeError("Streamed Azure writes require blockUpload.");
        }
        if (
          !this.optimizations.blockUpload && input.size !== undefined && input.size > getPutBlobLimit(this.#version)
        ) {
          throw new RangeError(
            "Write exceeds this service version's single Put Blob limit while blockUpload is disabled.",
          );
        }
        const partBytes = this.#getBlockSize(input.size);
        if (input.source === "stream" || (input.size !== undefined && input.size > getPutBlobLimit(this.#version))) {
          return {
            ...plan,
            support: "partitioned",
            partBytes,
            ...(input.size === undefined || input.size === 0 ? {} : { parts: Math.ceil(input.size / partBytes) }),
          };
        }
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

  /** Only an acquired HTTP response proves known refusal after dispatch. */
  async #publish<T>(
    options: AzureRequestOptionsType,
    read: (response: Response, text: ResponseTextType) => Promise<T>,
  ): Promise<T> {
    let dispatched = false;
    let response: Response;
    try {
      response = await this.#send({ ...options, retry: false }, () => {
        dispatched = true;
      });
    } catch (error) {
      if (!dispatched) throw error;
      throw new AzureCommitError(options.key ?? "", error);
    }
    const rejected = response.status >= 300 && response.status < 500;
    return await readResponse(response, async (text) => {
      try {
        return await read(response, text);
      } catch (error) {
        if (rejected) throw error;
        throw new AzureCommitError(options.key ?? "", error);
      }
    });
  }

  /** Returns blob properties or null for an absent blob. */
  async head(key: string, options?: { readonly signal?: AbortSignal }): Promise<ObjectStatType | null> {
    const response = await this.request({
      method: "HEAD",
      key,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    return await readResponse(response, async (text) => {
      if (response.status === 404) return null;
      await assertResponse(response, `Get Blob Properties ${key}`, text);
      return getStat(response.headers);
    });
  }

  /** Opens one full blob or byte range as the provider response stream. */
  async get(key: string, options: ObjectGetOptionsType = {}): Promise<ReadableStream<Uint8Array>> {
    const ifMatch = resolveETag(options.revision);
    const selected = resolveRange(options);
    if (selected.empty) return getByteStream(new Uint8Array());
    const headers = new Headers();
    if (ifMatch !== undefined) headers.set("if-match", ifMatch);
    if (selected.header !== undefined) headers.set("x-ms-range", selected.header);
    const response = await assertResponse(
      await this.request({
        method: "GET",
        key,
        headers,
        ...(selected.signal === undefined ? {} : { signal: selected.signal }),
      }),
      `Get Blob ${key}`,
    );
    await assertRangeResponse(response, selected);
    return response.body ?? getByteStream(new Uint8Array());
  }

  /** Chooses a legal block size for a known or unknown streamed body. */
  #getBlockSize(expectedSize: number | undefined): number {
    if (expectedSize === undefined) return this.#blockSize;
    const blockLimit = getBlockLimit(this.#version);
    const maxBlobBytes = blockLimit * AZURE_LIMITS.maxCommittedBlocks;
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > maxBlobBytes) {
      throw new RangeError(
        `Azure block blob size must be between 0 and ${maxBlobBytes} bytes for service version ${this.#version}.`,
      );
    }
    const required = Math.ceil(expectedSize / AZURE_LIMITS.maxCommittedBlocks);
    const size = Math.max(this.#blockSize, required);
    if (size > blockLimit) {
      throw new RangeError(
        `Azure block blob requires blocks larger than ${blockLimit} bytes for service version ${this.#version}.`,
      );
    }
    return size;
  }

  /** Builds destination metadata and HTTP preconditions for Put/commit operations. */
  #getWriteHeaders(options: ObjectPutOptionsType | ObjectCopyOptionsType): Headers {
    const headers = new Headers();
    if ("mediaType" in options && options.mediaType !== undefined) {
      headers.set("x-ms-blob-content-type", options.mediaType);
    }
    if (options.ifMatch !== undefined) headers.set("if-match", options.ifMatch);
    if (options.ifNoneMatch !== undefined) headers.set("if-none-match", options.ifNoneMatch);
    if ("metadata" in options) setMetadata(headers, options.metadata);
    return headers;
  }

  /** Uploads one uncommitted block. Preconditions belong to the final block-list commit. */
  async #putBlock(key: string, block: AzureBlockType, signal?: AbortSignal): Promise<AzureBlockType> {
    if (!isBytes(block.bytes)) throw new TypeError("An upload block must be a readable Uint8Array.");
    block = { ...block, bytes: toRequestBytes(block.bytes) };
    const response = await this.request({
      method: "PUT",
      key,
      query: { comp: "block", blockid: block.id },
      headers: { "content-type": "application/octet-stream" },
      body: block.bytes as Uint8Array<ArrayBuffer>,
      ...(signal === undefined ? {} : { signal }),
    });
    await readResponse(response, (text) => assertResponse(response, `Put Block ${key}#${block.number}`, text));
    return block;
  }

  /** Commits one ordered block list and applies destination metadata/preconditions atomically. */
  async #commitBlocks(
    key: string,
    ids: readonly string[],
    options: ObjectPutOptionsType,
    size: number,
  ): Promise<ObjectReceiptType> {
    const headers = this.#getWriteHeaders(options);
    headers.set("content-type", "application/xml");
    const response = await this.#publish({
      method: "PUT",
      key,
      query: { comp: "blocklist" },
      headers,
      body: getBlockListBody(ids),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, (response, text) => assertResponse(response, `Put Block List ${key}`, text));
    return getReceipt(response, size, options);
  }

  /**
   * Uploads uncommitted blocks and publishes only after every block succeeds.
   * Producer/caller failures survive after admitted requests drain; independent
   * provider failures remain secondary evidence in the terminal aggregate.
   */
  async #putBlocks(
    key: string,
    body: ReadableStream<Uint8Array>,
    options: ObjectPutOptionsType,
  ): Promise<ObjectReceiptType> {
    const blockSize = this.#getBlockSize(options.size);
    const source = getBlocks(body, blockSize, options.signal);
    const blocks = map(
      this.#concurrency,
      source,
      (block) => this.#putBlock(key, block, options.signal),
      { interrupt: () => source.interrupt() },
    );
    const ids: string[] = [];
    let size = 0;
    for await (const block of blocks) {
      ids.push(block.id);
      size += block.bytes.byteLength;
    }
    if (options.size !== undefined && options.size !== size) {
      throw new RangeError(`Azure streamed body produced ${size} bytes but options.size declared ${options.size}.`);
    }
    if (ids.length === 0) return await this.#putBytes(key, new Uint8Array(), options);
    return await this.#commitBlocks(key, ids, options, size);
  }

  /** Uses one Put Blob request when the selected service version permits the byte length. */
  async #putBytes(key: string, body: Uint8Array, options: ObjectPutOptionsType): Promise<ObjectReceiptType> {
    if (!isBytes(body)) throw new TypeError("A materialized upload body must be a readable Uint8Array.");
    body = toRequestBytes(body);
    if (options.size !== undefined && options.size !== body.byteLength) {
      throw new RangeError("Azure body length does not match options.size.");
    }
    if (body.byteLength > getPutBlobLimit(this.#version)) {
      if (!this.optimizations.blockUpload) {
        throw new RangeError(
          `Blob is ${body.byteLength} bytes, above the single Put Blob limit ${getPutBlobLimit(this.#version)} ` +
            "while blockUpload is disabled.",
        );
      }
      return await this.#putBlocks(key, getByteStream(body), { ...options, size: body.byteLength });
    }
    const headers = this.#getWriteHeaders(options);
    headers.set("x-ms-blob-type", "BlockBlob");
    const response = await this.#publish({
      method: "PUT",
      key,
      headers,
      body: body as Uint8Array<ArrayBuffer>,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, (response, text) => assertResponse(response, `Put Blob ${key}`, text));
    return getReceipt(response, body.byteLength, options);
  }

  /** Replaces one blob, using block upload when a single Put Blob is insufficient or the body streams. */
  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    options: ObjectPutOptionsType = {},
  ): Promise<ObjectReceiptType> {
    options = resolveETagPut(options);
    const properties = new Headers(this.#headers);
    this.#getWriteHeaders(options).forEach((value, name) => properties.set(name, value));
    const mediaType = properties.get("x-ms-blob-content-type");
    const metadata = getStat(properties).metadata;
    options = applyProperties(options, {
      ...(mediaType === null ? {} : { mediaType }),
      ...(metadata === undefined ? {} : { metadata }),
    });
    this.#getAddress(key);
    // Intrinsic byte admission includes genuine foreign-realm views. A detached
    // or out-of-bounds view must not fall through as an apparent empty stream.
    if (isBytes(body)) return await this.#putBytes(key, body, options);
    if (!isStream(body)) {
      throw new TypeError("An upload body must be readable Uint8Array bytes or a native ReadableStream.");
    }
    if (!this.optimizations.blockUpload) {
      const failure = new TypeError(
        "Azure streamed writes require blockUpload; enable it or let the filesystem adapter buffer " +
          "a bounded stream before calling put().",
      );
      await close([() => body.cancel()], [failure]);
      throw failure;
    }
    return await this.#putBlocks(key, body, options);
  }

  /** Removes one exact blob. Missing blobs are already in the requested state. */
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
      await assertResponse(response, `Delete Blob ${key}`, text);
    });
  }

  /** Converts one `<Blob>` list element into provider-neutral metadata. */
  #getListEntry(blob: ReturnType<typeof parseXmlRoot>): ObjectEntryType {
    const properties = getXmlElements(blob, "Properties")[0] ?? blob;
    const size = Number.parseInt(getXmlValue(properties, "Content-Length") ?? "0", 10);
    const modified = getXmlValue(properties, "Last-Modified");
    return {
      key: getName(blob) ?? "",
      size: Number.isSafeInteger(size) && size >= 0 ? size : 0,
      ...(modified === undefined ? {} : { lastModified: new Date(modified).getTime() }),
      ...(getXmlValue(properties, "Content-Type") === undefined
        ? {}
        : { mediaType: getXmlValue(properties, "Content-Type")! }),
      ...(getXmlValue(properties, "Etag") === undefined ? {} : { etag: getXmlValue(properties, "Etag")! }),
    };
  }

  /** Lists one Azure container page with delimiter and marker semantics preserved. */
  async list(options: ObjectListOptionsType): Promise<ObjectListType> {
    const response = await this.request({
      method: "GET",
      query: {
        restype: "container",
        comp: "list",
        prefix: options.prefix,
        delimiter: options.delimiter,
        maxresults: options.limit === undefined ? undefined : String(options.limit),
        marker: options.cursor,
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return await readResponse(response, async (text) => {
      await assertResponse(response, "List Blobs", text);
      const root = parseXmlRoot(await text());
      const objects = getXmlElements(root, "Blob").map((blob) => this.#getListEntry(blob));
      const prefixes = getXmlElements(root, "BlobPrefix")
        .map((prefix) => getName(prefix))
        .filter((value): value is string => value !== undefined);
      const cursor = getXmlText(root, "NextMarker");
      return { objects, prefixes, ...(cursor === undefined || cursor.length === 0 ? {} : { cursor }) };
    });
  }

  /** Builds source URL authorization and source precondition headers for copy operations. */
  async #getCopyHeaders(source: string, options: ObjectCopyOptionsType, version?: string): Promise<Headers> {
    const url = this.#getAddress(source);
    if (version !== undefined) url.searchParams.set("versionid", version);
    const headers = new Headers({ "x-ms-copy-source": url.toString() });
    if (options.sourceIfMatch !== undefined) headers.set("x-ms-source-if-match", options.sourceIfMatch);
    if (options.sourceIfNoneMatch !== undefined) headers.set("x-ms-source-if-none-match", options.sourceIfNoneMatch);
    if (options.sourceIfModifiedSince !== undefined) {
      headers.set("x-ms-source-if-modified-since", options.sourceIfModifiedSince.toUTCString());
    }
    if (options.sourceIfUnmodifiedSince !== undefined) {
      headers.set("x-ms-source-if-unmodified-since", options.sourceIfUnmodifiedSince.toUTCString());
    }
    if (this.#credential.kind === "bearer") {
      if (!atLeast(this.#version, SOURCE_BEARER_VERSION)) {
        throw new AzureError(
          `Azure service version ${this.#version} predates source bearer authorization for URL copy.`,
          new Response(null, { status: 400 }),
        );
      }
      headers.set("x-ms-copy-source-authorization", `Bearer ${await getBearerToken(this.#credential.token)}`);
    }
    return headers;
  }

  /** Copies one source range into one uncommitted destination block. */
  async #copyBlock(
    source: string,
    destination: string,
    block: AzureCopyBlockType,
    options: ObjectCopyOptionsType,
    version?: string,
  ): Promise<AzureCopyBlockType> {
    const headers = await this.#getCopyHeaders(source, options, version);
    headers.set("x-ms-source-range", `bytes=${block.start}-${block.end}`);
    headers.set("content-length", "0");
    const response = await this.request({
      method: "PUT",
      key: destination,
      query: { comp: "block", blockid: block.id },
      headers,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    await readResponse(
      response,
      (text) =>
        assertResponse(
          response,
          `Put Block From URL ${source}[${block.start}-${block.end}] -> ${destination}#${block.number}`,
          text,
        ),
    );
    return block;
  }

  /** Commits copied ranges while preserving source media type/metadata and destination preconditions. */
  async #commitCopy(
    destination: string,
    blocks: readonly AzureCopyBlockType[],
    source: ObjectStatType,
    options: ObjectCopyOptionsType,
  ): Promise<ObjectReceiptType> {
    const headers = this.#getWriteHeaders(options);
    headers.set("content-type", "application/xml");
    if (source.mediaType !== undefined) headers.set("x-ms-blob-content-type", source.mediaType);
    setMetadata(headers, source.metadata);
    const response = await this.#publish({
      method: "PUT",
      key: destination,
      query: { comp: "blocklist" },
      headers,
      body: getBlockListBody(blocks.map((block) => block.id)),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, (response, text) => assertResponse(response, `Put Block List ${destination}`, text));
    return getReceipt(response, source.size, source);
  }

  /** Copies a source up to 256 MiB through synchronous Copy Blob From URL. */
  async #copyBlob(
    source: string,
    destination: string,
    sourceStat: ObjectStatType,
    options: ObjectCopyOptionsType,
  ): Promise<ObjectReceiptType> {
    const headers = await this.#getCopyHeaders(source, options, sourceStat.version);
    const destinationHeaders = this.#getWriteHeaders(options);
    destinationHeaders.forEach((value, name) => headers.set(name, value));
    headers.set("x-ms-requires-sync", "true");
    headers.set("content-length", "0");
    return await this.#publish({
      method: "PUT",
      key: destination,
      headers,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, async (response, text) => {
      await assertResponse(response, `Copy Blob From URL ${source} -> ${destination}`, text);
      if (response.headers.get("x-ms-copy-status") !== "success") {
        throw new Error("Copy Blob From URL did not report synchronous success.");
      }
      return getReceipt(response, sourceStat.size, sourceStat);
    });
  }

  /**
   * Copies one same-client blob without routing source bytes through JavaScript.
   *
   * Copy Blob From URL handles sources through 256 MiB. Larger sources use Put
   * Block From URL ranges and an atomic Put Block List commit. The source URL
   * contains the configured SAS when SAS is used. Bearer source authorization
   * requires service version 2020-10-02 or later. Shared Key signs the
   * destination request and is valid for same-account sources built by this
   * client.
   */
  async copy(source: string, destination: string, options: ObjectCopyOptionsType = {}): Promise<ObjectReceiptType> {
    options = resolveETagCopy(options);
    if (!this.optimizations.serverCopy) {
      throw new TypeError("Azure serverCopy optimization is disabled for this client.");
    }
    if (!atLeast(this.#version, URL_COPY_VERSION)) {
      throw new AzureError(
        `Azure service version ${this.#version} does not support URL-based server-side copy.`,
        new Response(null, { status: 400 }),
      );
    }
    if (this.#credential.kind === "headers") {
      throw new AzureError(
        "Provider-side Azure copy is not advertised for custom authorization headers because source authorization cannot be inferred.",
        new Response(null, { status: 400 }),
      );
    }

    this.#getAddress(destination);
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
      throw new AzureError(`Copy source '${source}' does not exist.`, new Response(null, { status: 404 }));
    }
    if (sourceStat.etag === undefined) throw new TypeError("Azure copy requires a source ETag to pin its bytes.");
    options = { ...options, sourceIfMatch: sourceStat.etag };
    if (sourceStat.size <= AZURE_LIMITS.copyBlobBytes) {
      return await this.#copyBlob(source, destination, sourceStat, options);
    }

    const copyLimit = getCopyBlockLimit(this.#version);
    const requiredBlockSize = Math.ceil(sourceStat.size / AZURE_LIMITS.maxCommittedBlocks);
    const copyBlockSize = Math.max(this.#blockSize, requiredBlockSize);
    if (copyBlockSize > copyLimit) {
      throw new RangeError(
        `Azure server-side copy requires blocks larger than ${copyLimit} bytes for service version ${this.#version}.`,
      );
    }
    const blockCount = Math.ceil(sourceStat.size / copyBlockSize);
    if (blockCount > AZURE_LIMITS.maxCommittedBlocks) {
      throw new RangeError(
        `Azure server-side copy needs ${blockCount} blocks; the service permits ${AZURE_LIMITS.maxCommittedBlocks}.`,
      );
    }

    const copied = map(
      this.#concurrency,
      getCopyBlocks(sourceStat.size, copyBlockSize),
      (block) => this.#copyBlock(source, destination, block, options, sourceStat.version),
    );
    return await this.#commitCopy(destination, await Array.fromAsync(copied), sourceStat, options);
  }
}

/**
 * Creates a direct Azure Blob REST client without the Azure SDK dependency graph.
 *
 * The client implements Blob REST versioning, SAS, bearer, Shared Key, block
 * upload, range reads, conditional replacement, list pagination, synchronous
 * copy, and block-from-URL copy. The detailed wire contract and version limits
 * are documented in `docs/azure.md`.
 *
 * @example Connect to Azurite with its development account.
 * ```ts
 * const client = createAzureClient({
 *   endpoint: "http://127.0.0.1:10000/devstoreaccount1",
 *   container: "opfs-test",
 *   credential: { kind: "shared-key", account: "devstoreaccount1", key: AZURITE_KEY },
 * });
 * ```
 */
export function createAzureClient(options: AzureClientOptionsType): AzureClientType {
  return new AzureClient(options);
}

export type {
  AzureClientOptionsType,
  AzureClientType,
  AzureCredentialType,
  AzureLimitsType,
  AzureRequestOptionsType,
  AzureStorageVersionType,
} from "./types.ts";

export { AzureCommitError, AzureError } from "./error.ts";

export { AZURE_LIMITS, AZURE_STORAGE_VERSION, AzureStorageVersionSchema } from "./limits.ts";
