import { pooledMap } from "@std/async/pool";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { z } from "zod";

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
import { split } from "./chunk.ts";
import {
  type FetchType,
  RequestMetrics,
  type RequestMetricsType,
  type RequestPolicyType,
  sendRequest,
} from "./request.ts";
import { type AdapterLimitsType, MetricsModeSchema, type MetricsModeType } from "./schema.ts";
import { toByteStream } from "./stream.ts";
import { createXmlElement, createXmlText, getXmlElements, getXmlValue, parseXmlRoot, stringifyXml } from "./xml.ts";

/** Current fully deployed Azure Storage REST service version used by default. */
export const AZURE_STORAGE_VERSION = "2026-04-06";

/** Date-shaped Azure Storage REST service version sent through `x-ms-version`. */
export const AzureStorageVersionSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Validated Azure Storage REST service version. */
export type AzureStorageVersionType = z.output<typeof AzureStorageVersionSchema>;

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
  /** Fetch implementation. */
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
  /** Request body. */
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
}

/** Structured Azure Blob REST failure with provider request identity retained. */
export class AzureError extends Error {
  /** HTTP status returned by Azure. */
  readonly status: number;
  /** Azure service error code when present. */
  readonly code?: string;
  /** Azure request identity when present. */
  readonly requestId?: string;
  /** Original response. */
  readonly response: Response;

  /** Creates a provider-aware error without discarding the original response. */
  constructor(message: string, response: Response, details: { code?: string; requestId?: string } = {}) {
    super(message);
    this.name = "AzureError";
    this.status = response.status;
    this.response = response;
    if (details.code !== undefined) this.code = details.code;
    if (details.requestId !== undefined) this.requestId = details.requestId;
  }
}

/** Public Azure Blob size/count limits used by request planning and tests. */
export const AZURE_LIMITS = Object.freeze({
  /** Maximum block count a `Put Block List` can publish in one block blob. */
  maxCommittedBlocks: 50_000,
  /** Maximum uncommitted blocks Azure retains for one blob before commit. */
  maxUncommittedBlocks: 100_000,
  /** Maximum source size for synchronous `Copy Blob From URL`. */
  copyBlobBytes: 256 * 1024 * 1024,
  /** `Put Block` maximum used by service versions before 2016-05-31. */
  legacyBlockBytes: 4 * 1024 * 1024,
  /** `Put Block` maximum used from 2016-05-31 through the pre-2019 limit. */
  midBlockBytes: 100 * 1024 * 1024,
  /** Current `Put Block` and modern URL-copy range maximum. */
  currentBlockBytes: 4_000 * 1024 * 1024,
  /** Single `Put Blob` maximum used by older service versions. */
  legacyPutBlobBytes: 64 * 1024 * 1024,
  /** Single `Put Blob` maximum used by 2016-era service versions. */
  midPutBlobBytes: 256 * 1024 * 1024,
  /** Current single `Put Blob` maximum. */
  currentPutBlobBytes: 5_000 * 1024 * 1024,
});

/** Shared UTF-8 encoder used by block IDs and Shared Key signing. */
const textEncoder = new TextEncoder();
/** Default streamed block size, small enough for broad emulator/provider support. */
const DEFAULT_BLOCK_SIZE = 8 * 1024 * 1024;
/** Earliest Blob service version covered by this client's Shared Key string format. */
const SHARED_KEY_VERSION = "2009-09-19" as AzureStorageVersionType;
/** Last service version that signs a zero Content-Length as the literal `0`. */
const ZERO_CONTENT_LENGTH_VERSION = "2014-02-14" as AzureStorageVersionType;
/** First service version that retains empty `x-ms-*` headers during canonicalization. */
const EMPTY_HEADER_VERSION = "2016-05-31" as AzureStorageVersionType;
/** Earliest service version with Put Block From URL / Copy Blob From URL. */
const URL_COPY_VERSION = "2018-03-28" as AzureStorageVersionType;
/** Earliest service version with 4,000 MiB Put Block From URL ranges. */
const LARGE_URL_BLOCK_VERSION = "2020-04-08" as AzureStorageVersionType;
/** Earliest service version with source Microsoft Entra authorization headers. */
const SOURCE_BEARER_VERSION = "2020-10-02" as AzureStorageVersionType;

/** Compares Azure's ISO-date service versions without local-time conversion. */
function atLeast(version: AzureStorageVersionType, required: AzureStorageVersionType): boolean {
  return version >= required;
}

/** Returns the Put Block limit for the selected REST service version. */
function getBlockLimit(version: AzureStorageVersionType): number {
  if (atLeast(version, "2019-12-12")) return AZURE_LIMITS.currentBlockBytes;
  if (atLeast(version, "2016-05-31")) return AZURE_LIMITS.midBlockBytes;
  return AZURE_LIMITS.legacyBlockBytes;
}

/** Returns the single Put Blob limit for the selected REST service version. */
function getPutBlobLimit(version: AzureStorageVersionType): number {
  if (atLeast(version, "2019-12-12")) return AZURE_LIMITS.currentPutBlobBytes;
  if (atLeast(version, "2016-05-31")) return AZURE_LIMITS.midPutBlobBytes;
  return AZURE_LIMITS.legacyPutBlobBytes;
}

/** Returns the Put Block From URL range limit for the selected version. */
function getCopyBlockLimit(version: AzureStorageVersionType): number {
  return atLeast(version, LARGE_URL_BLOCK_VERSION) ? AZURE_LIMITS.currentBlockBytes : AZURE_LIMITS.midBlockBytes;
}

/** Percent-encodes one blob name while preserving virtual-directory separators. */
function encodePath(value: string): string {
  return value.split("/").map((part) => encodeURIComponent(part)).join("/");
}

/** Compares protocol strings by code-unit order rather than locale collation. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

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
 * Normalizes HTTP linear whitespace for Azure Shared Key canonicalization.
 *
 * Azure collapses linear whitespace outside quoted strings but preserves the
 * contents of quoted strings. A global whitespace regular expression would
 * therefore change a signed metadata value such as `"two  spaces"` and produce
 * an authorization value that Azure does not recognize.
 */
function normalizeHeaderValue(value: string): string {
  let result = "";
  let quoted = false;
  let escaped = false;
  let pendingSpace = false;

  for (const character of value) {
    if (quoted) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
      continue;
    }

    if (character === '"') {
      if (pendingSpace && result.length > 0) result += " ";
      pendingSpace = false;
      quoted = true;
      result += character;
      continue;
    }

    if (character === " " || character === "\t" || character === "\r" || character === "\n") {
      pendingSpace = result.length > 0;
      continue;
    }

    if (pendingSpace && result.length > 0) result += " ";
    pendingSpace = false;
    result += character;
  }

  return result;
}

/** Returns canonical `x-ms-*` headers sorted exactly as Shared Key requires. */
function getCanonicalHeaders(headers: Headers, version: AzureStorageVersionType): string {
  return [...headers.entries()]
    .filter(([name]) => name.toLowerCase().startsWith("x-ms-"))
    .map(([name, value]) => [name.toLowerCase(), normalizeHeaderValue(value)] as const)
    .filter(([, value]) => atLeast(version, EMPTY_HEADER_VERSION) || value.length > 0)
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, value]) => `${name}:${value}\n`)
    .join("");
}

/**
 * Returns the Shared Key canonical resource, including repeated query values.
 *
 * Azurite endpoints contain `/devstoreaccount1` in the URL path. Prefixing the
 * account name therefore produces the documented duplicated emulator account
 * segment without special-case string construction.
 */
function getCanonicalResource(url: URL, account: string): string {
  const valuesByName = new Map<string, string[]>();
  for (const [rawName, value] of url.searchParams) {
    const name = rawName.toLowerCase();
    const values = valuesByName.get(name) ?? [];
    values.push(value);
    valuesByName.set(name, values);
  }

  let result = `/${account}${url.pathname}`;
  for (const name of [...valuesByName.keys()].sort(compareText)) {
    const values = valuesByName.get(name)!.sort(compareText);
    result += `\n${name}:${values.join(",")}`;
  }
  return result;
}

/** Returns a deterministic request-body length when Web Fetch exposes one. */
function getBodyLength(body: BodyInit | null | undefined): number | undefined {
  if (body === undefined || body === null) return 0;
  if (typeof body === "string") return textEncoder.encode(body).byteLength;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof URLSearchParams) return textEncoder.encode(body.toString()).byteLength;
  return undefined;
}

/** Returns the service-version-specific Content-Length field used by Shared Key signing. */
function getSignedContentLength(headers: Headers, version: AzureStorageVersionType): string {
  const value = headers.get("content-length") ?? "";
  if (value !== "0") return value;
  return version <= ZERO_CONTENT_LENGTH_VERSION ? "0" : "";
}

/** Builds the Blob service Shared Key `StringToSign`. */
function getStringToSign(
  method: string,
  url: URL,
  headers: Headers,
  account: string,
  version: AzureStorageVersionType,
): string {
  const lines = [
    method.toUpperCase(),
    headers.get("content-encoding") ?? "",
    headers.get("content-language") ?? "",
    getSignedContentLength(headers, version),
    headers.get("content-md5") ?? "",
    headers.get("content-type") ?? "",
    "", // x-ms-date is used, so the Date line is empty.
    headers.get("if-modified-since") ?? "",
    headers.get("if-match") ?? "",
    headers.get("if-none-match") ?? "",
    headers.get("if-unmodified-since") ?? "",
    headers.get("range") ?? "",
  ];
  return `${lines.join("\n")}\n${getCanonicalHeaders(headers, version)}${getCanonicalResource(url, account)}`;
}

/** Signs one Shared Key request with HMAC-SHA256 and Base64 output. */
async function getSharedKeyAuthorization(
  method: string,
  url: URL,
  headers: Headers,
  account: string,
  key: string,
  version: AzureStorageVersionType,
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    decodeBase64(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    textEncoder.encode(getStringToSign(method, url, headers, account, version)),
  );
  return `SharedKey ${account}:${encodeBase64(new Uint8Array(signature))}`;
}

/** Converts Azure response headers to provider-neutral object metadata. */
function getStat(headers: Headers): ObjectStatType {
  const metadata: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (name.toLowerCase().startsWith("x-ms-meta-")) metadata[name.slice("x-ms-meta-".length)] = value;
  }
  const size = Number.parseInt(headers.get("content-length") ?? "0", 10);
  const modified = headers.get("last-modified");
  return {
    size: Number.isSafeInteger(size) && size >= 0 ? size : 0,
    ...(modified === null ? {} : { lastModified: new Date(modified).getTime() }),
    ...(headers.get("content-type") === null ? {} : { mediaType: headers.get("content-type")! }),
    ...(headers.get("etag") === null ? {} : { etag: headers.get("etag")! }),
    ...(headers.get("x-ms-version-id") === null ? {} : { version: headers.get("x-ms-version-id")! }),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
  };
}

/** Parses Azure XML failures while preserving HTTP-only failures from proxies. */
async function assertResponse(response: Response, operation: string): Promise<Response> {
  if (response.ok) return response;
  const body = await response.text().catch(() => "");
  let code = response.headers.get("x-ms-error-code") ?? undefined;
  let message = `${operation} failed with HTTP ${response.status}.`;
  if (body.trim().startsWith("<")) {
    try {
      const root = parseXmlRoot(body);
      code ??= getXmlValue(root, "Code");
      message = getXmlValue(root, "Message") ?? message;
    } catch {
      // A proxy can return HTML or malformed XML. Preserve the HTTP failure.
    }
  }
  throw new AzureError(message, response, {
    ...(code === undefined ? {} : { code }),
    ...(response.headers.get("x-ms-request-id") === null
      ? {}
      : { requestId: response.headers.get("x-ms-request-id")! }),
  });
}

/** Returns a fixed-width Base64 block ID so lexical order matches block order. */
function getBlockId(index: number): string {
  return encodeBase64(textEncoder.encode(String(index).padStart(10, "0")));
}

/** Builds the XML document that commits one ordered Azure block list. */
function getBlockListBody(ids: readonly string[]): string {
  return stringifyXml(createXmlElement(
    "BlockList",
    ids.map((id) => createXmlElement("Latest", [createXmlText(id)])),
  ));
}

/** Resolves a static or refreshable Microsoft Entra bearer token. */
async function getBearerToken(value: string | (() => string | Promise<string>)): Promise<string> {
  return typeof value === "function" ? await value() : value;
}

/** Converts one materialized byte array into a single-use Web stream. */
function getByteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return toByteStream(bytes);
}

/** One indexed block emitted before an Azure Put Block request. */
interface AzureBlockType {
  /** One-based logical block number. */
  readonly number: number;
  /** Fixed-width Base64 block ID. */
  readonly id: string;
  /** Block bytes. */
  readonly bytes: Uint8Array;
}

/** One source range used by Put Block From URL. */
interface AzureCopyBlockType {
  /** One-based destination block number. */
  readonly number: number;
  /** Fixed-width Base64 destination block ID. */
  readonly id: string;
  /** Inclusive source byte start. */
  readonly start: number;
  /** Inclusive source byte end. */
  readonly end: number;
}

/** Assigns stable IDs to streamed blocks and rejects the Azure block-count limit. */
async function* getBlocks(source: ReadableStream<Uint8Array>, size: number): AsyncIterableIterator<AzureBlockType> {
  let number = 0;
  for await (const bytes of split(source, size)) {
    number += 1;
    if (number > AZURE_LIMITS.maxCommittedBlocks) {
      throw new RangeError(`Azure block upload exceeds the ${AZURE_LIMITS.maxCommittedBlocks}-block service limit.`);
    }
    yield { number, id: getBlockId(number), bytes };
  }
}

/** Generates server-side source ranges without allocating the source object. */
function* getCopyBlocks(size: number, blockSize: number): IterableIterator<AzureCopyBlockType> {
  let number = 0;
  for (let start = 0; start < size; start += blockSize) {
    number += 1;
    yield {
      number,
      id: getBlockId(number),
      start,
      end: Math.min(size, start + blockSize) - 1,
    };
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
    this.#credential = options.credential;
    this.#version = AzureStorageVersionSchema.parse(options.version ?? AZURE_STORAGE_VERSION);
    this.#fetch = options.fetch ?? fetch;
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

  /** Builds the container/blob URL and applies configured SAS query fields. */
  #getAddress(key?: string): URL {
    const url = new URL(this.#endpoint);
    const root = this.#endpoint.pathname.replace(/\/$/, "");
    url.pathname = `${root}/${encodeURIComponent(this.#container)}${
      key === undefined || key.length === 0 ? "" : `/${encodePath(key)}`
    }`;
    if (this.#credential.kind === "sas") {
      const params = new URLSearchParams(this.#credential.token.replace(/^\?/, ""));
      for (const [name, value] of params) url.searchParams.append(name, value);
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
    const replayable = options.retry !== false && !(options.body instanceof ReadableStream);
    return await sendRequest(async (signal) => {
      const url = this.#getAddress(options.key);
      for (const [name, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined) url.searchParams.set(name, value);
      }

      const headers = new Headers(this.#headers);
      new Headers(options.headers).forEach((value, name) => headers.set(name, value));
      headers.set("x-ms-version", this.#version);
      headers.set("x-ms-date", this.#now().toUTCString());

      const bodyLength = getBodyLength(options.body);
      if (
        bodyLength !== undefined && !headers.has("content-length") && options.method !== "GET" &&
        options.method !== "HEAD"
      ) {
        headers.set("content-length", String(bodyLength));
      }
      if (
        this.#credential.kind === "shared-key" && options.body instanceof ReadableStream &&
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
        ...(options.body === undefined ? {} : { body: options.body }),
        ...(signal === undefined ? {} : { signal }),
      };
      if (options.body instanceof ReadableStream) init.duplex = "half";
      return { input: url, init };
    }, {
      fetch: this.#fetch,
      ...(this.#requestPolicy === undefined ? {} : { policy: this.#requestPolicy }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      replayable,
      ...(this.#metrics === undefined ? {} : { metrics: this.#metrics }),
    });
  }

  /** Returns blob properties or null for an absent blob. */
  async head(key: string, options?: { readonly signal?: AbortSignal }): Promise<ObjectStatType | null> {
    const response = await this.request({
      method: "HEAD",
      key,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    if (response.status === 404) return null;
    await assertResponse(response, `Get Blob Properties ${key}`);
    return getStat(response.headers);
  }

  /** Opens one full blob or byte range as the provider response stream. */
  async get(key: string, options: ObjectGetOptionsType = {}): Promise<ReadableStream<Uint8Array>> {
    const headers = new Headers();
    if (options.at !== undefined || options.length !== undefined) {
      const start = options.at ?? 0;
      const end = options.length === undefined ? "" : String(start + Math.max(0, options.length - 1));
      headers.set("x-ms-range", `bytes=${start}-${end}`);
    }
    const response = await assertResponse(
      await this.request({
        method: "GET",
        key,
        headers,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
      `Get Blob ${key}`,
    );
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
    await assertResponse(
      await this.request({
        method: "PUT",
        key,
        query: { comp: "block", blockid: block.id },
        headers: { "content-type": "application/octet-stream" },
        body: block.bytes as Uint8Array<ArrayBuffer>,
        ...(signal === undefined ? {} : { signal }),
      }),
      `Put Block ${key}#${block.number}`,
    );
    return block;
  }

  /** Commits one ordered block list and applies destination metadata/preconditions atomically. */
  async #commitBlocks(
    key: string,
    ids: readonly string[],
    options: ObjectPutOptionsType,
    size: number,
  ): Promise<ObjectStatType> {
    const headers = this.#getWriteHeaders(options);
    headers.set("content-type", "application/xml");
    await assertResponse(
      await this.request({
        method: "PUT",
        key,
        query: { comp: "blocklist" },
        headers,
        body: getBlockListBody(ids),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
      `Put Block List ${key}`,
    );
    return (await this.head(key, options)) ?? { size };
  }

  /** Uploads a stream as uncommitted blocks and publishes it only after all blocks succeed. */
  async #putBlocks(
    key: string,
    body: ReadableStream<Uint8Array>,
    options: ObjectPutOptionsType,
  ): Promise<ObjectStatType> {
    const blockSize = this.#getBlockSize(options.size);
    const blocks = pooledMap(
      this.#concurrency,
      getBlocks(body, blockSize),
      (block) => this.#putBlock(key, block, options.signal),
    );
    const ids: string[] = [];
    let size = 0;
    for await (const block of blocks) {
      ids.push(block.id);
      size += block.bytes.byteLength;
    }
    if (ids.length === 0) return await this.#putBytes(key, new Uint8Array(), options);
    if (options.size !== undefined && options.size !== size) {
      throw new RangeError(`Azure streamed body produced ${size} bytes but options.size declared ${options.size}.`);
    }
    return await this.#commitBlocks(key, ids, options, size);
  }

  /** Uses one Put Blob request when the selected service version permits the byte length. */
  async #putBytes(key: string, body: Uint8Array, options: ObjectPutOptionsType): Promise<ObjectStatType> {
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
    await assertResponse(
      await this.request({
        method: "PUT",
        key,
        headers,
        body: body as Uint8Array<ArrayBuffer>,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
      `Put Blob ${key}`,
    );
    return (await this.head(key, options)) ?? { size: body.byteLength };
  }

  /** Replaces one blob, using block upload when a single Put Blob is insufficient or the body streams. */
  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    options: ObjectPutOptionsType = {},
  ): Promise<ObjectStatType> {
    if (body instanceof Uint8Array) return await this.#putBytes(key, body, options);
    if (!this.optimizations.blockUpload) {
      await body.cancel().catch(() => undefined);
      throw new TypeError(
        "Azure streamed writes require blockUpload; enable it or let the filesystem adapter buffer " +
          "a bounded stream before calling put().",
      );
    }
    return await this.#putBlocks(key, body, options);
  }

  /** Removes one exact blob. Missing blobs are already in the requested state. */
  async delete(key: string, options?: { readonly signal?: AbortSignal }): Promise<void> {
    const response = await this.request({
      method: "DELETE",
      key,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    if (response.status === 404) return;
    await assertResponse(response, `Delete Blob ${key}`);
  }

  /** Converts one `<Blob>` list element into provider-neutral metadata. */
  #getListEntry(blob: ReturnType<typeof parseXmlRoot>): ObjectEntryType {
    const properties = getXmlElements(blob, "Properties")[0] ?? blob;
    const size = Number.parseInt(getXmlValue(properties, "Content-Length") ?? "0", 10);
    const modified = getXmlValue(properties, "Last-Modified");
    return {
      key: getXmlValue(blob, "Name") ?? "",
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
    const response = await assertResponse(
      await this.request({
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
      }),
      "List Blobs",
    );
    const root = parseXmlRoot(await response.text());
    const objects = getXmlElements(root, "Blob").map((blob) => this.#getListEntry(blob));
    const prefixes = getXmlElements(root, "BlobPrefix")
      .map((prefix) => getXmlValue(prefix, "Name"))
      .filter((value): value is string => value !== undefined);
    const cursor = getXmlValue(root, "NextMarker");
    return { objects, prefixes, ...(cursor === undefined || cursor.length === 0 ? {} : { cursor }) };
  }

  /** Builds source URL authorization and source precondition headers for copy operations. */
  async #getCopyHeaders(source: string, options: ObjectCopyOptionsType): Promise<Headers> {
    const headers = new Headers({ "x-ms-copy-source": this.#getAddress(source).toString() });
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
  ): Promise<AzureCopyBlockType> {
    const headers = await this.#getCopyHeaders(source, options);
    headers.set("x-ms-source-range", `bytes=${block.start}-${block.end}`);
    headers.set("content-length", "0");
    await assertResponse(
      await this.request({
        method: "PUT",
        key: destination,
        query: { comp: "block", blockid: block.id },
        headers,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
      `Put Block From URL ${source}[${block.start}-${block.end}] -> ${destination}#${block.number}`,
    );
    return block;
  }

  /** Commits copied ranges while preserving source media type/metadata and destination preconditions. */
  async #commitCopy(
    destination: string,
    blocks: readonly AzureCopyBlockType[],
    source: ObjectStatType,
    options: ObjectCopyOptionsType,
  ): Promise<ObjectStatType> {
    const headers = this.#getWriteHeaders(options);
    headers.set("content-type", "application/xml");
    if (source.mediaType !== undefined) headers.set("x-ms-blob-content-type", source.mediaType);
    setMetadata(headers, source.metadata);
    await assertResponse(
      await this.request({
        method: "PUT",
        key: destination,
        query: { comp: "blocklist" },
        headers,
        body: getBlockListBody(blocks.map((block) => block.id)),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
      `Put Block List ${destination}`,
    );
    return (await this.head(destination, options)) ?? { size: source.size };
  }

  /** Copies a source up to 256 MiB through synchronous Copy Blob From URL. */
  async #copyBlob(
    source: string,
    destination: string,
    sourceStat: ObjectStatType,
    options: ObjectCopyOptionsType,
  ): Promise<ObjectStatType> {
    const headers = await this.#getCopyHeaders(source, options);
    const destinationHeaders = this.#getWriteHeaders(options);
    destinationHeaders.forEach((value, name) => headers.set(name, value));
    headers.set("x-ms-requires-sync", "true");
    headers.set("content-length", "0");
    const response = await assertResponse(
      await this.request({
        method: "PUT",
        key: destination,
        headers,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
      `Copy Blob From URL ${source} -> ${destination}`,
    );
    if (response.headers.get("x-ms-copy-status") !== "success") {
      throw new AzureError("Copy Blob From URL did not report synchronous success.", response, {
        ...(response.headers.get("x-ms-request-id") === null
          ? {}
          : { requestId: response.headers.get("x-ms-request-id")! }),
      });
    }
    return (await this.head(destination, options)) ?? { size: sourceStat.size };
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
  async copy(source: string, destination: string, options: ObjectCopyOptionsType = {}): Promise<ObjectStatType> {
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

    const sourceStat = await this.head(source, options);
    if (sourceStat === null) {
      throw new AzureError(`Copy source '${source}' does not exist.`, new Response(null, { status: 404 }));
    }
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

    const copied = pooledMap(
      this.#concurrency,
      getCopyBlocks(sourceStat.size, copyBlockSize),
      (block) => this.#copyBlock(source, destination, block, options),
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
