/** Native WebDAV collection operations over an explicitly supplied endpoint. @module */
import { RequestMetrics, sendRequest } from "./request.ts";
import type { FetchType, RequestMetricsType, RequestPolicyType } from "./request.ts";
import { readResponse } from "./response.ts";
import { assertRangeResponse, range } from "./range.ts";
import { objectETag } from "./publication.ts";
import { isBytes, toRequestBytes } from "./bytes.ts";
import { dirname, normalizePath } from "./path.ts";
import { parseXmlRoot } from "./xml.ts";
import type { XmlElement } from "@std/xml/types";
import { openObjectSource } from "./source.ts";
import type { ByteSourceType, ObjectSourceOptionsType } from "./source.ts";
import type { ObjectBackendType, ObjectGetOptionsType, ObjectStatType } from "./driver/object.ts";

/** Authentication stays application-owned. Endpoint names one collection, not an arbitrary URL template. */
export interface WebdavClientOptionsType {
  readonly endpoint: string | URL;
  /** Explicit replay scope binding this collection and its authentication context; omitted identities cannot resume. */
  readonly namespace?: string;
  readonly fetch?: FetchType;
  readonly headers?: HeadersInit | ((url: URL) => HeadersInit | Promise<HeadersInit>);
  readonly credentials?: RequestCredentials;
  readonly policy?: RequestPolicyType;
  /** Maximum materialized records in a Depth:1 response. Defaults to 10,000. */
  readonly maxEntries?: number;
}

/** One bounded, validated resource description. Paths are relative to the configured collection. */
export interface WebdavEntryType {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly size?: number;
  readonly etag?: string;
  readonly lastModified?: number;
  readonly mediaType?: string;
}

/** Conditions apply to the addressed resource. There is no automatic mutating retry. */
export interface WebdavWriteOptionsType {
  readonly ifMatch?: string;
  readonly createOnly?: boolean;
  readonly mediaType?: string;
  readonly signal?: AbortSignal;
}

/** Native namespace copy/move options. A 207 partial result is a failure, never a success receipt. */
export interface WebdavCopyOptionsType {
  readonly overwrite?: boolean;
  readonly sourceIfMatch?: string;
  readonly signal?: AbortSignal;
}

/** Native HTTP status without a credential-bearing URL or an unbounded response body. */
export class WebdavError extends Error {
  readonly status: number;
  readonly operation: string;
  constructor(status: number, operation: string) {
    super(`WebDAV ${operation} failed with HTTP ${status}.`);
    this.name = "WebdavError";
    this.status = status;
    this.operation = operation;
  }
}

/** A dispatched mutation has uncertain or partial effects; retry requires application reconciliation. */
export class WebdavPublicationError extends Error {
  readonly operation: string;
  constructor(operation: string, cause: unknown) {
    super(`WebDAV ${operation} has no complete success acknowledgement.`, { cause });
    this.name = "WebdavPublicationError";
    this.operation = operation;
  }
}

/** Independently useful protocol client; no filesystem or registry is acquired. */
export interface WebdavClientType {
  readonly name: string;
  readonly identity: string | undefined;
  stat(path: string, options?: { readonly signal?: AbortSignal }): Promise<WebdavEntryType | null>;
  list(path: string, options?: { readonly signal?: AbortSignal }): Promise<readonly WebdavEntryType[]>;
  get(path: string, options?: ObjectGetOptionsType): Promise<ReadableStream<Uint8Array>>;
  put(path: string, bytes: Uint8Array, options?: WebdavWriteOptionsType): Promise<{ readonly etag?: string }>;
  mkdir(path: string, options?: { readonly signal?: AbortSignal }): Promise<void>;
  remove(path: string, options?: { readonly signal?: AbortSignal; readonly ifMatch?: string }): Promise<void>;
  copy(source: string, destination: string, options?: WebdavCopyOptionsType): Promise<void>;
  move(source: string, destination: string, options?: WebdavCopyOptionsType): Promise<void>;
  openSource(path: string, options?: ObjectSourceOptionsType): Promise<ByteSourceType>;
  getMetrics(): RequestMetricsType;
}

/** The default namespace must be tracked because @std/xml intentionally resolves only prefixed names. */
interface DavNodeType {
  readonly node: XmlElement;
  readonly defaultNamespace: string;
}
function namespace(node: XmlElement, inherited: string): string {
  return node.name.prefix === undefined ? node.attributes["xmlns"] ?? inherited : node.name.uri ?? "";
}
function children(parent: DavNodeType, name: string): DavNodeType[] {
  const output: DavNodeType[] = [];
  for (const node of parent.node.children) {
    if (node.type === "element" && node.name.local === name && namespace(node, parent.defaultNamespace) === "DAV:") {
      output.push({ node, defaultNamespace: node.attributes["xmlns"] ?? parent.defaultNamespace });
    }
  }
  return output;
}
/** Scalars are direct, unique DAV properties. Nested lookalikes cannot authorize a path or size. */
function scalar(parent: DavNodeType, name: string, required = true): string | undefined {
  const found = children(parent, name);
  if (found.length === 0 && !required) return undefined;
  if (found.length !== 1 || found[0]!.node.children.some((node) => node.type === "element")) {
    throw new SyntaxError(`WebDAV requires one scalar DAV:${name}.`);
  }
  const value = found[0]!.node.children.map((node) => node.type === "text" || node.type === "cdata" ? node.text : "")
    .join("").trim();
  if (!value && required) throw new SyntaxError(`WebDAV requires nonempty DAV:${name}.`);
  return value;
}
function status(value: string | undefined): number {
  const match = /^HTTP\/\d(?:\.\d)? (\d{3})(?: |$)/.exec(value ?? "");
  if (match === null) throw new SyntaxError("WebDAV status must contain one HTTP status line.");
  return Number(match[1]);
}
/** Reject URL normalization aliases before decoding each literal resource-name segment. */
function segments(path: string): string[] {
  const parts = path.split("/");
  if (parts[0] === "") parts.shift();
  if (parts.at(-1) === "") parts.pop();
  if (parts.some((part) => part === "")) {
    throw new TypeError("WebDAV repeated separators cannot be projected without aliasing.");
  }
  return parts.map((part) => {
    const name = decodeURIComponent(part);
    if (name === "." || name === ".." || /[/\\\0]/.test(name)) {
      throw new TypeError("WebDAV resource names cannot contain path aliases.");
    }
    return name;
  });
}

class WebdavClient implements WebdavClientType {
  readonly name = "webdav";
  readonly identity: string | undefined;
  readonly #endpoint: URL;
  readonly #root: readonly string[];
  readonly #fetch: FetchType;
  readonly #headers: Headers | ((url: URL) => HeadersInit | Promise<HeadersInit>);
  readonly #credentials: RequestCredentials;
  readonly #policy: RequestPolicyType | undefined;
  readonly #maximum: number;
  readonly #metrics = new RequestMetrics();

  constructor(options: WebdavClientOptionsType) {
    const endpoint = new URL(options.endpoint);
    if (
      !/^https?:$/.test(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    ) throw new TypeError("WebDAV requires an HTTP(S) collection URL without credentials, query or fragment.");
    if (!endpoint.pathname.endsWith("/")) endpoint.pathname += "/";
    this.#endpoint = endpoint;
    this.#root = segments(endpoint.pathname);
    if (options.namespace !== undefined && options.namespace.length === 0) {
      throw new TypeError("WebDAV namespace cannot be empty.");
    }
    this.identity = options.namespace === undefined
      ? undefined
      : JSON.stringify([endpoint.origin, ...this.#root, options.namespace]);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#headers = typeof options.headers === "function" ? options.headers : new Headers(options.headers);
    this.#credentials = options.credentials ?? "omit";
    this.#policy = options.policy === undefined ? undefined : { ...options.policy };
    this.#maximum = options.maxEntries ?? 10_000;
    if (!Number.isSafeInteger(this.#maximum) || this.#maximum < 1 || this.#maximum > 100_000) {
      throw new RangeError("maxEntries must be 1–100,000.");
    }
  }

  /** Canonical virtual paths are encoded segment by segment; caller text never becomes URL authority or query. */
  #url(path: string): URL {
    const canonical = normalizePath(path);
    const url = new URL(this.#endpoint);
    url.pathname += canonical === "/" ? "" : canonical.slice(1).split("/").map(encodeURIComponent).join("/");
    return url;
  }

  /** Inbound hrefs must stay inside the same configured namespace and preserve direct-child identity. */
  #path(href: string, requested: URL): string {
    if (
      /[\\?#]/.test(href) ||
      [...href].some((character) => character.codePointAt(0)! <= 32 || character.codePointAt(0) === 127)
    ) {
      throw new TypeError("WebDAV href contains an unsupported query, fragment or separator.");
    }
    for (const part of href.split("/").filter(Boolean)) {
      const name = decodeURIComponent(part);
      if (name === "." || name === ".." || /[/\\\0]/.test(name)) {
        throw new TypeError("WebDAV href contains a path alias.");
      }
    }
    const url = new URL(href, requested);
    const parts = segments(url.pathname);
    if (
      url.origin !== this.#endpoint.origin || url.username || url.password ||
      this.#root.some((name, index) => parts[index] !== name)
    ) throw new TypeError("WebDAV href escapes the configured collection.");
    return "/" + parts.slice(this.#root.length).join("/");
  }

  async #send(
    method: string,
    url: URL,
    headers = new Headers(),
    signal?: AbortSignal,
    body?: Uint8Array,
    dispatch?: () => void,
  ): Promise<Response> {
    signal?.throwIfAborted();
    return await sendRequest(async (attemptSignal) => {
      const auth = this.#headers;
      const admitted = new Headers(typeof auth === "function" ? await auth(new URL(url)) : auth);
      headers.forEach((value, key) => admitted.set(key, value));
      admitted.set("accept-encoding", "identity");
      return {
        input: new URL(url),
        init: {
          method,
          headers: admitted,
          redirect: "manual",
          credentials: this.#credentials,
          ...(attemptSignal === undefined ? {} : { signal: attemptSignal }),
          ...(body === undefined ? {} : { body: toRequestBytes(body) }),
        },
      };
    }, {
      fetch: (input, init) => {
        dispatch?.();
        return this.#fetch(input, init);
      },
      metrics: this.#metrics,
      replayable: method === "GET" || method === "PROPFIND",
      ...(signal === undefined ? {} : { signal }),
      ...(this.#policy === undefined ? {} : { policy: this.#policy }),
    });
  }

  /** Known refusals stay distinguishable from a lost acknowledgement or a partial multistatus. */
  async #mutate(
    method: string,
    url: URL,
    headers: Headers,
    signal: AbortSignal | undefined,
    accepted: readonly number[],
    body?: Uint8Array,
  ): Promise<Response> {
    let dispatched = false;
    let response: Response;
    try {
      response = await this.#send(method, url, headers, signal, body, () => {
        dispatched = true;
      });
    } catch (cause) {
      if (dispatched) throw new WebdavPublicationError(method, cause);
      throw cause;
    }
    if (!accepted.includes(response.status)) {
      return await readResponse(response, () => {
        const cause = new WebdavError(response.status, method);
        if (response.status === 207 || response.status === 408 || response.status >= 500 || response.ok) {
          throw new WebdavPublicationError(method, cause);
        }
        throw cause;
      });
    }
    return response;
  }

  /** One bounded Depth response is validated before any child is exposed to traversal. */
  async #properties(path: string, depth: 0 | 1, signal?: AbortSignal): Promise<WebdavEntryType[]> {
    const canonical = normalizePath(path);
    let url = this.#url(canonical);
    const headers = new Headers({ depth: String(depth), "content-type": "application/xml; charset=utf-8" });
    const body = new TextEncoder().encode(
      '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getetag/><d:getlastmodified/><d:getcontenttype/></d:prop></d:propfind>',
    );
    let response = await this.#send("PROPFIND", url, headers, signal, body);
    if ([301, 308].includes(response.status) && !url.pathname.endsWith("/")) {
      const location = response.headers.get("location");
      const expected = new URL(url);
      expected.pathname += "/";
      await readResponse(response, () => {
        const target = location === null ? undefined : new URL(location, url);
        if (target?.href !== expected.href) throw new TypeError("WebDAV redirect must only append a collection slash.");
      });
      url = expected;
      response = await this.#send("PROPFIND", url, headers, signal, body);
    }
    return await readResponse(response, async (text) => {
      if (response.status !== 207) throw new WebdavError(response.status, "PROPFIND");
      const root = parseXmlRoot(await text());
      const context = { node: root, defaultNamespace: root.attributes["xmlns"] ?? "" };
      if (root.name.local !== "multistatus" || namespace(root, "") !== "DAV:") {
        throw new SyntaxError("WebDAV requires a DAV:multistatus document.");
      }
      const responses = children(context, "response");
      if (responses.length > this.#maximum + 1) throw new RangeError("WebDAV response exceeds maxEntries.");
      const seen = new Set<string>();
      const output: WebdavEntryType[] = [];
      for (const item of responses) {
        const itemPath = this.#path(scalar(item, "href")!, url);
        if (seen.has(itemPath)) throw new SyntaxError("WebDAV returned duplicate resource identities.");
        seen.add(itemPath);
        if (itemPath !== canonical && (depth === 0 || dirname(itemPath) !== canonical)) {
          throw new TypeError("WebDAV returned a resource outside the requested depth.");
        }
        const directStatus = scalar(item, "status", false);
        if (directStatus !== undefined) throw new WebdavError(status(directStatus), "PROPFIND resource");
        const properties: DavNodeType[] = [];
        for (const propstat of children(item, "propstat")) {
          const code = status(scalar(propstat, "status"));
          if (code >= 200 && code < 300) properties.push(...children(propstat, "prop"));
          else if (code !== 404) throw new WebdavError(code, "PROPFIND property");
        }
        // Merge only disjoint successful property groups. Duplicate properties are ambiguous even when equal.
        const merged: DavNodeType = {
          node: {
            type: "element",
            name: { raw: "d:prop", local: "prop", prefix: "d", uri: "DAV:" },
            attributes: {},
            children: properties.flatMap((prop) =>
              prop.node.children.map((node) => {
                if (node.type !== "element") return node;
                return {
                  ...node,
                  attributes: { ...node.attributes, xmlns: node.attributes["xmlns"] ?? prop.defaultNamespace },
                };
              })
            ),
          },
          defaultNamespace: "",
        };
        const kinds = children(merged, "resourcetype");
        if (kinds.length !== 1) throw new SyntaxError("WebDAV requires one resource type.");
        const collections = children(kinds[0]!, "collection");
        const resources = kinds[0]!.node.children.filter((node) => node.type === "element");
        if (collections.length > 1 || resources.length !== collections.length) {
          throw new TypeError("WebDAV resource type is not a regular file or collection.");
        }
        const isDirectory = collections.length === 1;
        const sizeText = scalar(merged, "getcontentlength", !isDirectory);
        const size = sizeText === undefined || sizeText === "" ? undefined : Number(sizeText);
        if (sizeText && (!/^\d+$/.test(sizeText) || !Number.isSafeInteger(size))) {
          throw new SyntaxError("WebDAV file length is not a nonnegative safe integer.");
        }
        const modified = scalar(merged, "getlastmodified", false);
        const lastModified = modified === undefined || modified === "" ? undefined : Date.parse(modified);
        if (lastModified !== undefined && !Number.isFinite(lastModified)) {
          throw new SyntaxError("WebDAV returned an invalid modification date.");
        }
        const etag = scalar(merged, "getetag", false);
        const mediaType = scalar(merged, "getcontenttype", false);
        output.push({
          path: itemPath,
          kind: isDirectory ? "directory" : "file",
          ...(size === undefined ? {} : { size }),
          ...(etag === undefined || etag === "" ? {} : { etag }),
          ...(lastModified === undefined ? {} : { lastModified }),
          ...(mediaType === undefined ? {} : { mediaType }),
        });
      }
      if (!seen.has(canonical) || (depth === 0 && output.length !== 1)) {
        throw new SyntaxError("WebDAV omitted the requested resource.");
      }
      if (depth === 1 && output.find((entry) => entry.path === canonical)?.kind !== "directory") {
        throw new TypeError("WebDAV listing requires a collection.");
      }
      return output;
    });
  }

  async stat(path: string, options: { readonly signal?: AbortSignal } = {}): Promise<WebdavEntryType | null> {
    try {
      return (await this.#properties(path, 0, options.signal))[0]!;
    } catch (reason) {
      if (reason instanceof WebdavError && reason.status === 404) return null;
      throw reason;
    }
  }
  async list(path: string, options: { readonly signal?: AbortSignal } = {}): Promise<readonly WebdavEntryType[]> {
    const canonical = normalizePath(path);
    return (await this.#properties(canonical, 1, options.signal)).filter((entry) => entry.path !== canonical);
  }
  async get(path: string, options: ObjectGetOptionsType = {}): Promise<ReadableStream<Uint8Array>> {
    const url = this.#url(path);
    const selected = range(options);
    const etag = objectETag(options.revision);
    if (selected.empty) return new Blob().stream();
    const headers = new Headers();
    if (selected.header !== undefined) headers.set("range", selected.header);
    if (etag !== undefined) headers.set("if-match", etag);
    const response = await this.#send("GET", url, headers, selected.signal);
    if (!response.ok) {
      return await readResponse(response, () => {
        throw new WebdavError(response.status, "GET");
      });
    }
    await assertRangeResponse(response, selected);
    if (etag !== undefined && response.headers.has("etag") && response.headers.get("etag") !== etag) {
      return await readResponse(response, () => {
        throw new TypeError("WebDAV GET returned a different revision.");
      });
    }
    return response.body ?? new Blob().stream();
  }
  async put(
    path: string,
    bytes: Uint8Array,
    options: WebdavWriteOptionsType = {},
  ): Promise<{ readonly etag?: string }> {
    const url = this.#url(path);
    options.signal?.throwIfAborted();
    if (!isBytes(bytes)) throw new TypeError("WebDAV PUT requires native bytes.");
    const body = new Uint8Array(toRequestBytes(bytes));
    const { ifMatch, createOnly, mediaType, signal } = options;
    if (ifMatch !== undefined && createOnly) throw new TypeError("Conflicting WebDAV publication conditions.");
    const headers = new Headers();
    if (ifMatch !== undefined) headers.set("if-match", ifMatch);
    if (createOnly) headers.set("if-none-match", "*");
    if (mediaType !== undefined) headers.set("content-type", mediaType);
    const response = await this.#mutate("PUT", url, headers, signal, [200, 201, 204], body);
    return await readResponse(response, () => {
      if (![200, 201, 204].includes(response.status)) throw new WebdavError(response.status, "PUT");
      const etag = response.headers.get("etag");
      return etag === null ? {} : { etag };
    });
  }
  async mkdir(path: string, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    const response = await this.#mutate("MKCOL", this.#url(path), new Headers(), options.signal, [201]);
    await readResponse(response, () => {
      if (response.status !== 201) throw new WebdavError(response.status, "MKCOL");
    });
  }
  async remove(
    path: string,
    options: { readonly signal?: AbortSignal; readonly ifMatch?: string } = {},
  ): Promise<void> {
    const headers = new Headers();
    if (options.ifMatch !== undefined) headers.set("if-match", options.ifMatch);
    const response = await this.#mutate("DELETE", this.#url(path), headers, options.signal, [200, 204]);
    await readResponse(response, () => {
      if (![200, 204].includes(response.status)) throw new WebdavError(response.status, "DELETE");
    });
  }
  async #transfer(method: string, source: string, destination: string, options: WebdavCopyOptionsType): Promise<void> {
    const headers = new Headers({
      destination: this.#url(destination).href,
      overwrite: options.overwrite ? "T" : "F",
      depth: "infinity",
    });
    if (options.sourceIfMatch !== undefined) headers.set("if-match", options.sourceIfMatch);
    const response = await this.#mutate(method, this.#url(source), headers, options.signal, [201, 204]);
    await readResponse(response, () => {
      if (![201, 204].includes(response.status)) throw new WebdavError(response.status, method);
    });
  }
  copy(source: string, destination: string, options: WebdavCopyOptionsType = {}): Promise<void> {
    return this.#transfer("COPY", source, destination, { ...options });
  }
  move(source: string, destination: string, options: WebdavCopyOptionsType = {}): Promise<void> {
    return this.#transfer("MOVE", source, destination, { ...options });
  }
  /** Preserve the distinction between typed DAV properties and independent HTTP response metadata. */
  async #sourceStat(
    key: string,
    request?: { readonly signal?: AbortSignal },
  ): Promise<ObjectStatType | null> {
    const value = await this.stat(key, request);
    if (value === null) return null;
    if (value.kind !== "file" || value.size === undefined) {
      throw new TypeError("WebDAV byte sources require a regular resource with known size.");
    }
    // A DAV:getetag property is not always a conforming HTTP entity-tag.
    // Do not silently strengthen it. HEAD supplies an independent HTTP
    // validator, and equal size prevents combining divergent descriptions.
    if (value.etag === undefined || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value.etag)) {
      const response = await this.#send("HEAD", this.#url(key), new Headers(), request?.signal);
      return await readResponse(response, () => {
        if (response.status === 404) return null;
        if (response.status !== 200) throw new WebdavError(response.status, "HEAD");
        const length = response.headers.get("content-length");
        const encoding = response.headers.get("content-encoding");
        if (encoding !== null && encoding.toLowerCase().trim() !== "identity") {
          throw new TypeError("Encoded WebDAV sources cannot preserve byte offsets.");
        }
        if (
          length === null || !/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) ||
          Number(length) !== value.size
        ) {
          throw new TypeError("WebDAV HEAD and regular-resource properties disagree on size.");
        }
        const tag = response.headers.get("etag");
        return { size: value.size!, ...(tag === null ? {} : { etag: tag }) };
      });
    }
    return { size: value.size, etag: value.etag };
  }

  openSource(path: string, options: ObjectSourceOptionsType = {}): Promise<ByteSourceType> {
    const unsupported = (): never => {
      throw new TypeError("A WebDAV byte source exposes no mutations or listing.");
    };
    const backend: ObjectBackendType = {
      name: this.name,
      ...(this.identity === undefined ? {} : { identity: this.identity }),
      capabilities: { rangeRead: true, streamRead: true, streamWrite: false, copy: false, conditionalWrite: false },
      head: (key, request) => this.#sourceStat(key, request),
      get: (key, request) => this.get(key, request),
      put: unsupported,
      delete: unsupported,
      list: unsupported,
    };
    return openObjectSource(backend, normalizePath(path), options);
  }
  getMetrics(): RequestMetricsType {
    return this.#metrics.snapshot();
  }
}

/** Explicit construction acquires only borrowed Fetch/authentication capabilities, with no network request. */
export function createWebdavClient(options: WebdavClientOptionsType): WebdavClientType {
  return new WebdavClient(options);
}
