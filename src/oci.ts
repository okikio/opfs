/** Bounded OCI Distribution pull operations with explicit content-integrity evidence. @module */
import { z } from "zod";
import { encodeHex } from "@std/encoding/hex";
import { toRequestBytes } from "./bytes.ts";
import { assertRangeResponse, range } from "./range.ts";
import { RequestMetrics, sendRequest } from "./request.ts";
import type { FetchType, RequestPolicyType } from "./request.ts";
import { readResponse } from "./response.ts";
import { sourceRange } from "./source.ts";
import type { ByteSourceType } from "./source.ts";
import { collectBytes } from "./stream.ts";

const image = "application/vnd.oci.image.manifest.v1+json";
const index = "application/vnd.oci.image.index.v1+json";
const dockerImage = "application/vnd.docker.distribution.manifest.v2+json";
const dockerIndex = "application/vnd.docker.distribution.manifest.list.v2+json";
const media = [image, index, dockerImage, dockerIndex];
const DescriptorSchema = z.object({
  mediaType: z.string().min(1),
  digest: z.string().regex(/^[a-z][a-z0-9+._-]*:[A-Za-z0-9=_-]+$/),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  artifactType: z.string().optional(),
  annotations: z.record(z.string(), z.string()).optional(),
});
/** Descriptor declarations are not evidence that the referenced content exists or has been fetched. */
export interface OciDescriptorType {
  readonly mediaType: string;
  readonly digest: string;
  readonly size: number;
  readonly artifactType?: string;
  readonly annotations?: Readonly<Record<string, string>>;
}
/** Verified exact response bytes and a supported manifest shape, without layer traversal or signature trust. */
export interface OciManifestType {
  readonly digest: string;
  readonly integrity: "sha256";
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly kind: "manifest" | "index";
  readonly config?: OciDescriptorType;
  readonly layers?: readonly OciDescriptorType[];
  readonly manifests?: readonly OciDescriptorType[];
  readonly subject?: OciDescriptorType;
  readonly artifactType?: string;
  readonly annotations?: Readonly<Record<string, string>>;
}
/** Registry-local credentials are acquired explicitly, never from challenges, files or ambient configuration. */
export interface OciOptionsType {
  /** Registry origin, optionally with a deployment prefix ending in '/'. */
  readonly registry: string | URL;
  readonly repository: string;
  readonly headers?: (url: URL, signal?: AbortSignal) => HeadersInit | Promise<HeadersInit>;
  readonly fetch?: FetchType;
  readonly request?: RequestPolicyType;
  /** Exact origins admitted for blob GET/HEAD redirects. Credentials are omitted even for same-origin redirects. */
  readonly redirectOrigins?: readonly string[];
  readonly maxRedirects?: number;
  /** Explicit trusted private-registry/test policy; HTTPS is otherwise mandatory. */
  readonly allowHttp?: boolean;
  readonly maxManifestBytes?: number;
  readonly maxBlobBytes?: number;
  readonly maxPages?: number;
  readonly maxTags?: number;
}
/** HEAD is server-asserted metadata, not proof of a blob's digest or immutable bytes. */
export interface OciBlobType {
  readonly digest: string;
  readonly size: number;
  readonly integrity: "server";
}
/** Tags are mutable pointers. Native continuation authority remains bound to this repository's tags route. */
export interface OciTagsType {
  readonly tags: readonly string[];
  readonly next?: string;
}
/** Provider HTTP failure messages omit registry credentials and redirect URLs. */
export class OciError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`OCI registry request failed with HTTP ${status}.`);
    this.name = "OciError";
    this.status = status;
  }
}
/** Bound policies and sizes before allocation or credential acquisition. */
function integer(value: number, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new RangeError(`Invalid OCI ${label}.`);
  return value;
}
/** This profile fetches SHA-256 content only; descriptor declarations can name other algorithms. */
function digest(value: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new TypeError("OCI content reads require a lowercase SHA-256 digest.");
  }
  return value;
}
function tag(value: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/.test(value)) {
    throw new TypeError("Invalid OCI tag.");
  }
  return value;
}
/** Runtime data is mapped to exact optional public properties instead of spreading Zod wire optionals. */
function descriptor(value: unknown): OciDescriptorType {
  const data = DescriptorSchema.parse(value);
  if (data.digest.startsWith("sha256:")) digest(data.digest);
  return {
    mediaType: data.mediaType,
    digest: data.digest,
    size: data.size,
    ...(data.artifactType === undefined ? {} : { artifactType: data.artifactType }),
    ...(data.annotations === undefined ? {} : { annotations: data.annotations }),
  };
}
/** WebCrypto hashes one bounded owned input; this is not an incremental hash engine. */
async function hash(bytes: Uint8Array): Promise<string> {
  return `sha256:${encodeHex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", toRequestBytes(bytes))))}`;
}

/** One read-only repository. Import and construction acquire no external resources. */
export class OciClient {
  readonly #registry: URL;
  readonly #repository: string;
  readonly #headers: OciOptionsType["headers"];
  readonly #fetch: FetchType;
  readonly #policy: RequestPolicyType | undefined;
  readonly #origins: ReadonlySet<string>;
  readonly #redirects: number;
  readonly #http: boolean;
  readonly #manifestBytes: number;
  readonly #blobBytes: number;
  readonly #pages: number;
  readonly #tags: number;
  readonly #metrics = new RequestMetrics();
  constructor(options: OciOptionsType) {
    this.#http = options.allowHttp ?? false;
    this.#registry = this.#url(options.registry);
    if (this.#registry.search || !this.#registry.pathname.endsWith("/")) {
      throw new TypeError("OCI registry needs a trailing slash and no query.");
    }
    const repository = options.repository;
    if (
      typeof repository !== "string" || repository.length > 255 ||
      !/^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*)*$/.test(repository)
    ) throw new TypeError("Invalid OCI repository name.");
    this.#repository = repository;
    this.#headers = options.headers;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#policy = options.request;
    this.#origins = new Set((options.redirectOrigins ?? []).map((value) => {
      const url = this.#url(value);
      if (url.pathname !== "/" || url.search) throw new TypeError("OCI redirect policy requires exact origins.");
      return url.origin;
    }));
    this.#redirects = integer(options.maxRedirects ?? 3, "redirect budget", 10);
    this.#manifestBytes = integer(
      options.maxManifestBytes ?? 8 * 1024 * 1024,
      "manifest byte budget",
      64 * 1024 * 1024,
    );
    this.#blobBytes = integer(options.maxBlobBytes ?? 64 * 1024 * 1024, "blob byte budget", 1024 * 1024 * 1024);
    this.#pages = integer(options.maxPages ?? 1000, "page budget");
    this.#tags = integer(options.maxTags ?? 100000, "tag budget");
  }
  /** Canonical URL parsing is not credential discovery. Relative redirects are resolved by the caller before admission. */
  #url(value: string | URL): URL {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && !(this.#http && url.protocol === "http:")) || url.username || url.password ||
      url.hash || url.href.length > 65536
    ) throw new TypeError("Invalid OCI URL authority.");
    return url;
  }
  #route(part: string): URL {
    return new URL(`v2/${this.#repository}/${part}`, this.#registry);
  }
  /** Retry factory owns fresh auth headers. Redirect hops rebuild only the selected representation headers. */
  async #send(
    url: URL,
    method: "GET" | "HEAD",
    headers: Headers,
    signal?: AbortSignal,
    redirected = false,
  ): Promise<Response> {
    return await sendRequest(async (attemptSignal) => {
      attemptSignal?.throwIfAborted();
      const admitted = redirected ? new Headers() : new Headers(await this.#headers?.(new URL(url), attemptSignal));
      attemptSignal?.throwIfAborted();
      for (
        const name of [
          "host",
          "range",
          "if-range",
          "if-match",
          "if-none-match",
          "content-length",
          "transfer-encoding",
          "accept",
          "accept-encoding",
        ]
      ) admitted.delete(name);
      for (const [name, value] of headers) admitted.set(name, value);
      admitted.set("accept-encoding", "identity");
      return {
        input: new URL(url),
        init: {
          method,
          headers: admitted,
          credentials: "omit",
          redirect: "manual",
          referrerPolicy: "no-referrer",
          ...(attemptSignal === undefined ? {} : { signal: attemptSignal }),
        },
      };
    }, {
      fetch: this.#fetch,
      replayable: true,
      metrics: this.#metrics,
      ...(this.#policy === undefined ? {} : { policy: this.#policy }),
      ...(signal === undefined ? {} : { signal }),
    });
  }
  /** All redirect bodies are retired before the next acquisition, including loops and refused authorities. */
  async #blob(address: URL, method: "GET" | "HEAD", headers: Headers, signal?: AbortSignal): Promise<Response> {
    let url = address;
    const visited = new Set<string>();
    for (let hop = 0;; hop++) {
      if (visited.has(url.href)) throw new TypeError("OCI blob redirect repeated.");
      visited.add(url.href);
      const response = await this.#send(url, method, headers, signal, hop > 0);
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      url = await readResponse(response, () => {
        if (hop >= this.#redirects) throw new RangeError("OCI blob redirect budget exhausted.");
        const location = response.headers.get("location");
        if (location === null) throw new TypeError("OCI blob redirect has no Location.");
        const next = this.#url(new URL(location, url));
        if ((url.protocol === "https:" && next.protocol !== "https:") || !this.#origins.has(next.origin)) {
          throw new TypeError("OCI blob redirect origin is not explicitly allowed or downgrades HTTPS.");
        }
        return next;
      });
    }
  }
  /** Header admission owns retirement; payload reads then own the body through bounded collection. */
  async #bytes(response: Response, maximum: number, signal?: AbortSignal): Promise<Uint8Array> {
    let declared: number | undefined;
    try {
      if (response.status !== 200) throw new OciError(response.status);
      const encoding = response.headers.get("content-encoding");
      if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
        throw new TypeError("Encoded OCI content cannot preserve digest bytes.");
      }
      const value = response.headers.get("content-length");
      if (value !== null) {
        if (!/^\d+$/.test(value)) throw new TypeError("Invalid OCI Content-Length.");
        declared = integer(Number(value), "Content-Length", maximum);
      }
      if (response.body === null && declared !== 0) throw new TypeError("OCI content response has no body.");
    } catch (cause) {
      return await readResponse(response, () => {
        throw cause;
      });
    }
    const bytes = response.body === null
      ? new Uint8Array(0)
      : await collectBytes(response.body, maximum, signal, "read", "/oci");
    if (declared !== undefined && bytes.byteLength !== declared) {
      throw new TypeError("OCI body size differs from Content-Length.");
    }
    return bytes;
  }
  /** An optional supported digest header is checked against complete response bytes, never used as proof alone. */
  #declared(response: Response, computed: string): void {
    const header = response.headers.get("Docker-Content-Digest");
    if (header?.startsWith("sha256:") && digest(header) !== computed) {
      throw new TypeError("OCI response digest header differs from its bytes.");
    }
  }
  /** Hash exact bytes before fatal UTF-8 decoding or JSON parsing; tags resolve mutable pointers only for this response. */
  async getManifest(reference: string, signal?: AbortSignal): Promise<OciManifestType> {
    const expected = reference.includes(":") ? digest(reference) : undefined;
    if (expected === undefined) tag(reference);
    const response = await this.#send(
      this.#route(`manifests/${encodeURIComponent(reference)}`),
      "GET",
      new Headers({ accept: media.join(", ") }),
      signal,
    );
    const bytes = await this.#bytes(response, this.#manifestBytes, signal);
    const computed = await hash(bytes);
    signal?.throwIfAborted();
    if (expected !== undefined && computed !== expected) throw new TypeError("OCI manifest digest mismatch.");
    this.#declared(response, computed);
    const selected = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (selected === undefined || !media.includes(selected)) {
      throw new TypeError("Unsupported OCI manifest representation.");
    }
    const wire: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const shape = z.object({
      schemaVersion: z.literal(2),
      mediaType: z.string().optional(),
      config: z.unknown().optional(),
      layers: z.array(z.unknown()).optional(),
      manifests: z.array(z.unknown()).optional(),
      subject: z.unknown().optional(),
      artifactType: z.string().optional(),
      annotations: z.record(z.string(), z.string()).optional(),
    }).parse(wire);
    if (shape.mediaType !== undefined && shape.mediaType !== selected) {
      throw new TypeError("OCI manifest Content-Type differs from its mediaType.");
    }
    const common = {
      digest: computed,
      integrity: "sha256" as const,
      mediaType: selected,
      bytes,
      ...(shape.subject === undefined ? {} : { subject: descriptor(shape.subject) }),
      ...(shape.artifactType === undefined ? {} : { artifactType: shape.artifactType }),
      ...(shape.annotations === undefined ? {} : { annotations: shape.annotations }),
    };
    if (selected === index || selected === dockerIndex) {
      if (shape.manifests === undefined || shape.config !== undefined || shape.layers !== undefined) {
        throw new TypeError("OCI index requires only its manifest descriptor array.");
      }
      return { ...common, kind: "index", manifests: shape.manifests.map(descriptor) };
    }
    if (shape.config === undefined || shape.layers === undefined || shape.manifests !== undefined) {
      throw new TypeError("OCI image manifest requires config and layer descriptors.");
    }
    return { ...common, kind: "manifest", config: descriptor(shape.config), layers: shape.layers.map(descriptor) };
  }
  /** HEAD remains server evidence. The header digest is not upgraded to content verification. */
  async statBlob(value: string, signal?: AbortSignal): Promise<OciBlobType> {
    const selected = digest(value);
    const response = await this.#blob(this.#route(`blobs/${selected}`), "HEAD", new Headers(), signal);
    return await readResponse(response, () => {
      if (response.status !== 200) throw new OciError(response.status);
      const encoding = response.headers.get("content-encoding");
      if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
        throw new TypeError("Encoded OCI metadata cannot establish blob byte size.");
      }
      const length = response.headers.get("content-length");
      if (length === null || !/^\d+$/.test(length)) {
        throw new TypeError("OCI blob metadata requires a safe Content-Length.");
      }
      return { digest: selected, size: integer(Number(length), "blob size"), integrity: "server" };
    });
  }
  /** Explicit server-trusted streamed read. A digest-shaped URL is not proof of partial bytes. */
  async getBlob(
    value: string,
    options: {
      readonly integrity: "server";
      readonly at?: number;
      readonly length?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<ReadableStream<Uint8Array>> {
    const selected = range(options);
    const identifier = digest(value);
    if (options.integrity !== "server") throw new TypeError("Streamed OCI ranges require explicit server trust.");
    if (selected.empty) {
      return new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
    }
    const headers = new Headers();
    if (selected.header !== undefined) headers.set("Range", selected.header);
    const response = await this.#blob(this.#route(`blobs/${identifier}`), "GET", headers, selected.signal);
    if (!response.ok) {
      await readResponse(response, () => {
        throw new OciError(response.status);
      });
    }
    await assertRangeResponse(response, selected);
    if (response.body === null) {
      if (selected.header === undefined && response.headers.get("content-length") === "0") {
        return new ReadableStream({
          start(controller) {
            controller.close();
          },
        });
      }
      throw new TypeError("OCI blob response has no body.");
    }
    return response.body;
  }
  /** Bounded complete-object proof. WebCrypto and collection can retain extra copies; this does not stream verification. */
  async readBlob(
    value: string,
    options: { readonly maxBytes?: number; readonly size?: number; readonly signal?: AbortSignal } = {},
  ): Promise<Uint8Array> {
    const { signal, size } = options;
    const selected = digest(value);
    const maximum = integer(options.maxBytes ?? this.#blobBytes, "blob byte budget", this.#blobBytes);
    if (size !== undefined) integer(size, "expected blob size", maximum);
    const response = await this.#blob(this.#route(`blobs/${selected}`), "GET", new Headers(), signal);
    const bytes = await this.#bytes(response, maximum, signal);
    if (size !== undefined && bytes.byteLength !== size) {
      throw new TypeError("OCI blob differs from its descriptor size.");
    }
    const computed = await hash(bytes);
    signal?.throwIfAborted();
    if (computed !== selected) throw new TypeError("OCI blob digest mismatch.");
    this.#declared(response, computed);
    return bytes;
  }
  /** Retain only privately verified bytes. Every read returns an owned exact extent and needs no provider I/O. */
  async openBlobSource(
    value: string,
    options: { readonly maxBytes?: number; readonly size?: number; readonly signal?: AbortSignal } = {},
  ): Promise<ByteSourceType> {
    const selected = digest(value);
    const bytes = await this.readBlob(selected, options);
    const size = bytes.byteLength;
    return {
      size,
      identity: `oci:${selected}`,
      stability: "immutable",
      async read(offset, length, options = {}) {
        options.signal?.throwIfAborted();
        sourceRange(size, offset, length);
        return bytes.slice(offset, offset + length);
      },
    };
  }
  /** Only the exact repository's tag-list route can acquire registry credentials for continuation. */
  #next(value: string, base: URL): URL {
    const url = this.#url(new URL(value, base));
    if (url.origin !== base.origin || url.pathname !== base.pathname) {
      throw new TypeError("OCI tag continuation changed repository authority.");
    }
    const names = new Set<string>();
    for (const [key, value] of url.searchParams) {
      if (names.has(key) || !["n", "last"].includes(key)) {
        throw new TypeError("Unsupported OCI tag continuation query.");
      }
      names.add(key);
      if (key === "last") tag(value);
      else if (!/^\d+$/.test(value) || integer(Number(value), "tag page size", 1000) === 0) {
        throw new TypeError("Invalid OCI tag page size.");
      }
    }
    return url;
  }
  /** Bounded native tag page. This profile accepts one rel=next Link and rejects ambiguous Link syntax. */
  async tagsPage(
    options: { readonly next?: string; readonly pageSize?: number; readonly signal?: AbortSignal } = {},
  ): Promise<OciTagsType> {
    const { next, signal } = options;
    const size = integer(options.pageSize ?? 100, "tag page size", 1000);
    if (size === 0) throw new RangeError("OCI tag page size must be positive.");
    const route = this.#route("tags/list");
    const url = next === undefined ? route : this.#next(next, route);
    if (next === undefined) url.searchParams.set("n", String(size));
    const response = await this.#send(url, "GET", new Headers(), signal);
    return await readResponse(response, async (text) => {
      if (response.status !== 200) throw new OciError(response.status);
      const data = z.object({ name: z.string(), tags: z.array(z.string()).nullable() }).parse(JSON.parse(await text()));
      if (data.name !== this.#repository) throw new TypeError("OCI tag page names another repository.");
      const tags = (data.tags ?? []).map(tag);
      if (tags.length > 1000) throw new RangeError("OCI tag page exceeds its entry ceiling.");
      const link = response.headers.get("link");
      if (link === null) {
        // Older registries omit Link. A full page is not evidence of EOF;
        // continue non-inclusively from its last tag until a shorter page.
        const requested = Number(url.searchParams.get("n") ?? size);
        if (tags.length >= requested && tags.length > 0) {
          const continuation = new URL(route);
          continuation.searchParams.set("n", String(requested));
          continuation.searchParams.set("last", tags[tags.length - 1]!);
          return { tags, next: continuation.href };
        }
        return { tags };
      }
      const match = /^\s*<([^<>]+)>\s*;\s*rel=(?:"next"|next)\s*$/.exec(link);
      if (match === null) throw new TypeError("Unsupported or ambiguous OCI tag Link header.");
      return { tags, next: this.#next(match[1]!, route).href };
    });
  }
  /** Tag discovery is bounded and mutable; it is not a frozen repository inventory. */
  async *tags(options: { readonly pageSize?: number; readonly signal?: AbortSignal } = {}): AsyncGenerator<string> {
    const selected = { ...options };
    let next: string | undefined;
    let count = 0;
    const seen = new Set<string>();
    for (let page = 0; page < this.#pages; page++) {
      const result = await this.tagsPage({ ...selected, ...(next === undefined ? {} : { next }) });
      count += result.tags.length;
      if (count > this.#tags) throw new RangeError("OCI tag listing exceeds its tag budget.");
      yield* result.tags;
      if (result.next === undefined) return;
      if (seen.has(result.next)) throw new TypeError("OCI tag continuation repeated.");
      seen.add(result.next);
      next = result.next;
    }
    throw new RangeError("OCI tag listing exceeds its page budget.");
  }
}
