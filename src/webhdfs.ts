/** Native WebHDFS requests with explicit NameNode/DataNode authority. @module */
import { RequestMetrics, sendRequest } from "./request.ts";
import type { FetchType, RequestMetricsType, RequestPolicyType } from "./request.ts";
import { readResponse } from "./response.ts";
import { close } from "./close.ts";
import { openBytes } from "./stream.ts";
import { isBytes, toView } from "./bytes.ts";
import { range } from "./range.ts";
import type { FileDriverReadOptionsType, FileDriverSignalOptionsType } from "./driver/file.ts";

/** Per-target credentials are evaluated only after routing admission.
 * Redirected authentication query fields are stripped. A DataNode callback must
 * explicitly supply its own token/user context, even on the same origin.
 */
export interface WebhdfsAuthType {
  readonly headers?: HeadersInit;
  readonly query?: Readonly<Partial<Record<"user.name" | "doas" | "delegation", string>>>;
}

/** A configured protocol endpoint. Construction does no I/O or credential discovery. */
export interface WebhdfsClientOptionsType {
  readonly name?: string;
  /** NameNode HTTP(S) prefix, normally https://name.example/webhdfs/v1. */
  readonly endpoint: string | URL;
  /** HDFS path prefix, not a security sandbox against server-side aliases or changes. */
  readonly root?: string;
  /** Exact origins, including scheme and port. No NameNode or wildcard origin is implicitly allowed. */
  readonly dataOrigins: readonly string[];
  readonly auth?: (url: URL, target: "namenode" | "datanode") => WebhdfsAuthType | Promise<WebhdfsAuthType>;
  readonly fetch?: FetchType;
  readonly policy?: RequestPolicyType;
  /** Bounded materialized CREATE/APPEND payload; default 8 MiB. */
  readonly maxWriteBytes?: number;
  /** Per OPEN stream limit; default 1 GiB, independent of the driver's readFile limit. */
  readonly maxReadBytes?: number;
  readonly maxEntries?: number;
  readonly maxPages?: number;
}

/** Native status. SYMLINK entries remain visible to direct protocol callers. */
export interface WebhdfsEntryType {
  readonly name: string;
  readonly kind: "file" | "directory" | "link";
  readonly size: number;
  readonly lastModified: number;
}

/** HTTP failure retains status without copying token-bearing URLs or remote exception text. */
export class WebhdfsError extends Error {
  readonly status: number;
  readonly operation: string;
  constructor(status: number, operation: string) {
    super(`WebHDFS ${operation} failed with HTTP ${status}.`);
    this.name = "WebhdfsError";
    this.status = status;
    this.operation = operation;
  }
}

/** A successful HTTP response explicitly rejected a namespace operation with boolean=false.
 * The response does not identify a more specific reason, so no status or cause is fabricated.
 */
export class WebhdfsRejectionError extends Error {
  readonly operation: string;
  constructor(operation: string) {
    super(`WebHDFS ${operation} returned boolean false.`);
    this.name = "WebhdfsRejectionError";
    this.operation = operation;
  }
}

/** Mutation outcome is unknown. APPEND must never be blindly retried after this failure. */
export class WebhdfsPublicationError extends Error {
  readonly operation: string;
  constructor(operation: string, cause: unknown) {
    super(`WebHDFS ${operation} has no complete acknowledgement; reconcile before retry.`, { cause });
    this.name = "WebhdfsPublicationError";
    this.operation = operation;
  }
}

/** The client owns wire semantics; rename/mkdir/recursive delete are not canonical file primitives. */
export interface WebhdfsClientType {
  readonly name: string;
  stat(path: string, options?: FileDriverSignalOptionsType): Promise<WebhdfsEntryType | null>;
  list(path: string, options?: FileDriverSignalOptionsType): Promise<readonly WebhdfsEntryType[]>;
  get(path: string, options?: FileDriverReadOptionsType): Promise<ReadableStream<Uint8Array>>;
  put(
    path: string,
    bytes: Uint8Array,
    options?: FileDriverSignalOptionsType & { readonly overwrite?: boolean },
  ): Promise<void>;
  append(path: string, bytes: Uint8Array, options?: FileDriverSignalOptionsType): Promise<void>;
  /** Native MKDIRS recursively creates missing parents. */
  mkdir(path: string, options?: FileDriverSignalOptionsType): Promise<void>;
  /** Nonrecursive by default. An explicit true permits native recursive deletion. */
  remove(path: string, options?: FileDriverSignalOptionsType & { readonly recursive?: boolean }): Promise<void>;
  /** HDFS RENAME may move into an existing destination directory; no canonical move claim. */
  rename(source: string, destination: string, options?: FileDriverSignalOptionsType): Promise<void>;
  getMetrics(): RequestMetricsType;
}

/** Safe arithmetic is admitted before allocation or credential acquisition. */
function integer(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative safe integer.`);
  return value;
}

/** Direct paths are canonical absolute names, never URI or backslash aliases. */
function path(value: string): string {
  if (
    typeof value !== "string" || !value.startsWith("/") || /[\\\0]/.test(value) ||
    (value !== "/" && value.endsWith("/"))
  ) throw new TypeError("WebHDFS requires a canonical absolute path.");
  if (value !== "/" && value.slice(1).split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TypeError("WebHDFS path aliases are unsupported.");
  }
  return value;
}

/** Rejects arrays/null before interpreting untrusted JSON object fields. */
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Malformed WebHDFS JSON object.");
  }
  return value as Record<string, unknown>;
}

/** Preserves native entry kinds and safe millisecond/byte fields. */
function entry(value: unknown, child: boolean): WebhdfsEntryType {
  const row = object(value);
  if (
    typeof row.pathSuffix !== "string" ||
    (child &&
      (!row.pathSuffix || /[/\\\0]/.test(row.pathSuffix) || row.pathSuffix === "." || row.pathSuffix === "..")) ||
    (!child && row.pathSuffix !== "")
  ) throw new TypeError("Malformed WebHDFS pathSuffix.");
  const kind = row.type === "FILE"
    ? "file"
    : row.type === "DIRECTORY"
    ? "directory"
    : row.type === "SYMLINK"
    ? "link"
    : undefined;
  if (kind === undefined || typeof row.length !== "number" || typeof row.modificationTime !== "number") {
    throw new TypeError("Malformed WebHDFS file status.");
  }
  return Object.freeze({
    name: row.pathSuffix,
    kind,
    size: integer(row.length, "file length"),
    lastModified: integer(row.modificationTime, "modification time"),
  });
}

/** HDFS child ordering uses unsigned UTF-8 bytes, which differs from JavaScript UTF-16 order. */
function advances(previous: string, next: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(previous);
  const b = encoder.encode(next);
  if (new TextDecoder().decode(b) !== next) throw new TypeError("WebHDFS child name is not well-formed Unicode.");
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return b[i]! > a[i]!;
  return b.length > a.length;
}

/** Owns one OPEN body, bounding actual bytes as well as declared Content-Length.
 * No bytes beyond the admitted bound escape; abort/cancel joins upstream release.
 */
function body(
  source: ReadableStream<Uint8Array>,
  maximum: number,
  expected: number | undefined,
): ReadableStream<Uint8Array> {
  const reader = openBytes(source);
  let size = 0;
  let terminal = false;
  let cancelled = false;
  let retirement: Promise<void> | undefined;
  const retire = (primary: readonly unknown[] = [], reason: unknown = primary[0]): Promise<void> =>
    retirement ??= close([
      ...(!terminal ? [() => reader.cancel(reason)] : []),
      () => reader.releaseLock(),
    ], primary);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await reader.read();
        } catch (reason) {
          terminal = true;
          throw reason;
        }
        if (cancelled) return;
        if (next.done) {
          terminal = true;
          if (expected !== undefined && size !== expected) {
            throw new TypeError("WebHDFS body differs from Content-Length.");
          }
          await retire();
          controller.close();
          return;
        }
        if (!isBytes(next.value)) throw new TypeError("WebHDFS body requires byte chunks.");
        const bytes = toView(next.value);
        if (bytes.byteLength > maximum - size || (expected !== undefined && bytes.byteLength > expected - size)) {
          throw new RangeError("WebHDFS OPEN exceeds its byte extent or limit.");
        }
        size += bytes.byteLength;
        controller.enqueue(bytes);
      } catch (reason) {
        try {
          await retire([reason]);
        } catch (failure) {
          if (!cancelled) controller.error(failure);
        }
      }
    },
    async cancel(reason) {
      cancelled = true;
      await retire([], reason);
    },
  }, { highWaterMark: 0 });
}

/** Native HTTP implementation with one admitted redirect, no mutation retries and bounded control JSON. */
class WebhdfsClient implements WebhdfsClientType {
  readonly name: string;
  readonly #endpoint: URL;
  readonly #root: string;
  readonly #origins: ReadonlySet<string>;
  readonly #auth: WebhdfsClientOptionsType["auth"];
  readonly #fetch: FetchType;
  readonly #policy: RequestPolicyType | undefined;
  readonly #writeBytes: number;
  readonly #readBytes: number;
  readonly #entries: number;
  readonly #pages: number;
  readonly #metrics = new RequestMetrics();

  constructor(options: WebhdfsClientOptionsType) {
    this.#endpoint = new URL(options.endpoint);
    if (
      !/^https?:$/.test(this.#endpoint.protocol) || this.#endpoint.username || this.#endpoint.password ||
      this.#endpoint.search || this.#endpoint.hash || /%(?:2f|5c|2e)/i.test(this.#endpoint.pathname)
    ) throw new TypeError("Invalid WebHDFS endpoint.");
    this.#endpoint.pathname = this.#endpoint.pathname.replace(/\/$/, "");
    this.#root = path(options.root ?? "/");
    this.#origins = new Set(options.dataOrigins.map((value) => {
      const url = new URL(value);
      if (value !== url.origin || !/^https?:$/.test(url.protocol)) {
        throw new TypeError("DataNode allowlist entries must be exact HTTP(S) origins.");
      }
      return url.origin;
    }));
    this.#auth = options.auth;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#policy = options.policy === undefined ? undefined : { ...options.policy };
    this.#writeBytes = integer(options.maxWriteBytes ?? 8 * 1024 * 1024, "maxWriteBytes");
    this.#readBytes = integer(options.maxReadBytes ?? 1024 * 1024 * 1024, "maxReadBytes");
    this.#entries = integer(options.maxEntries ?? 100000, "maxEntries");
    this.#pages = integer(options.maxPages ?? 10000, "maxPages");
    this.name = options.name ?? "webhdfs";
  }

  /** The virtual root is encoded by segment; it is not a permission boundary in HDFS. */
  #url(input: string, operation: string, query: Readonly<Record<string, string>> = {}): URL {
    const relative = path(input);
    const full = this.#root === "/" ? relative : `${this.#root}${relative === "/" ? "" : relative}`;
    const url = new URL(this.#endpoint);
    url.pathname += full.split("/").map(encodeURIComponent).join("/");
    url.searchParams.set("op", operation);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url;
  }

  /** Credential failures before dispatch stay ordinary failures; dispatched mutation transport faults are uncertain. */
  async #request(
    url: URL,
    target: "namenode" | "datanode",
    method: string,
    signal?: AbortSignal,
    bytes?: Uint8Array,
    mutation = false,
  ): Promise<Response> {
    signal?.throwIfAborted();
    let dispatched = false;
    try {
      return await sendRequest(async (attemptSignal) => {
        const auth = await this.#auth?.(new URL(url), target);
        attemptSignal?.throwIfAborted();
        const input = new URL(url);
        for (const name of ["user.name", "doas", "delegation"]) input.searchParams.delete(name);
        for (const [name, value] of Object.entries(auth?.query ?? {})) {
          if (!["user.name", "doas", "delegation"].includes(name) || typeof value !== "string") {
            throw new TypeError("Unsupported WebHDFS authentication query field.");
          }
          input.searchParams.set(name, value);
        }
        const headers = new Headers(auth?.headers);
        for (
          const name of [
            "host",
            "content-length",
            "transfer-encoding",
            "range",
            "if-range",
            "if-match",
            "if-none-match",
            "if-modified-since",
            "if-unmodified-since",
          ]
        ) headers.delete(name);
        headers.set("accept-encoding", "identity");
        if (bytes !== undefined) headers.set("content-type", "application/octet-stream");
        return {
          input,
          init: {
            method,
            headers,
            credentials: "omit",
            redirect: "manual",
            ...(bytes === undefined ? {} : { body: bytes as Uint8Array<ArrayBuffer> }),
            ...(attemptSignal === undefined ? {} : { signal: attemptSignal }),
          },
        };
      }, {
        fetch: (input, init) => {
          dispatched = true;
          return this.#fetch(input, init);
        },
        replayable: !mutation,
        metrics: this.#metrics,
        ...(this.#policy === undefined ? {} : { policy: this.#policy }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (reason) {
      if (mutation && dispatched) throw new WebhdfsPublicationError(url.searchParams.get("op")!, reason);
      throw reason;
    }
  }

  /** Only one same-path allowed-origin 307 is followed; auth is reacquired by target role.
   * Documented server defaults may be added, but selected byte and write semantics cannot change.
   */
  #redirect(response: Response, original: URL): URL {
    if (response.status !== 307) throw new WebhdfsError(response.status, original.searchParams.get("op")!);
    const location = response.headers.get("location");
    if (location === null || location.length > 65536) {
      throw new TypeError("WebHDFS redirect requires a Location within 64 KiB.");
    }
    const next = new URL(location, original);
    if (
      !this.#origins.has(next.origin) || next.username || next.password || next.hash ||
      next.pathname !== original.pathname || (original.protocol === "https:" && next.protocol !== "https:")
    ) throw new TypeError("WebHDFS redirect target is outside the admitted DataNode route.");
    const operation = original.searchParams.get("op")!;
    const allowed = new Set([
      "op",
      "namenoderpcaddress",
      "buffersize",
      "user.name",
      "doas",
      "delegation",
      ...(operation === "OPEN"
        ? ["offset", "length"]
        : operation === "CREATE"
        ? ["overwrite", "createparent", "permission", "unmaskedpermission", "blocksize", "replication", "createflag"]
        : []),
    ]);
    for (const [name, value] of next.searchParams) {
      if (!allowed.has(name) || next.searchParams.getAll(name).length !== 1) {
        throw new TypeError("Unexpected or duplicate WebHDFS redirect query field.");
      }
      if (
        ["buffersize", "blocksize", "replication"].includes(name) &&
        (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
      ) throw new TypeError("Invalid WebHDFS redirect numeric default.");
      if (["permission", "unmaskedpermission"].includes(name) && !/^[0-7]{3,4}$/.test(value)) {
        throw new TypeError("Invalid WebHDFS redirect permission default.");
      }
      // Hadoop's CreateFlagParam.DEFAULT is the empty set; DataNode then applies
      // CREATE plus the separately pinned overwrite parameter. Other flags alter semantics.
      if (name === "createflag" && value !== "" && value !== "CREATE") {
        throw new TypeError("Unsupported WebHDFS create flags.");
      }
    }
    for (const [name, value] of original.searchParams) {
      if (next.searchParams.get(name) !== value) {
        throw new TypeError("WebHDFS redirect changes operation parameters.");
      }
    }
    for (const name of ["user.name", "doas", "delegation"]) next.searchParams.delete(name);
    return next;
  }

  /** Control JSON is bounded by the shared 8 MiB response owner. */
  async #json(url: URL, method: string, signal?: AbortSignal, mutation = false): Promise<unknown> {
    const response = await this.#request(url, "namenode", method, signal, undefined, mutation);
    return await readResponse(response, async (text) => {
      const operation = url.searchParams.get("op")!;
      if (
        mutation &&
        (response.status >= 500 || response.status === 408 ||
          (response.status >= 200 && response.status < 400 && response.status !== 200))
      ) throw new WebhdfsPublicationError(operation, new WebhdfsError(response.status, operation));
      if (response.status !== 200) throw new WebhdfsError(response.status, operation);
      try {
        return JSON.parse(await text()) as unknown;
      } catch (reason) {
        if (mutation) throw new WebhdfsPublicationError(operation, reason);
        throw reason;
      }
    });
  }

  async stat(input: string, { signal }: FileDriverSignalOptionsType = {}): Promise<WebhdfsEntryType | null> {
    try {
      return entry(object(await this.#json(this.#url(input, "GETFILESTATUS"), "GET", signal)).FileStatus, false);
    } catch (reason) {
      if (reason instanceof WebhdfsError && reason.status === 404) return null;
      throw reason;
    }
  }

  async list(input: string, { signal }: FileDriverSignalOptionsType = {}): Promise<readonly WebhdfsEntryType[]> {
    const canonical = path(input);
    const result: WebhdfsEntryType[] = [];
    const seen = new Set<string>();
    let after = "";
    for (let page = 0; page < this.#pages; page++) {
      signal?.throwIfAborted();
      const listing = object(
        object(await this.#json(this.#url(canonical, "LISTSTATUS_BATCH", { startAfter: after }), "GET", signal))
          .DirectoryListing,
      );
      if (typeof listing.remainingEntries !== "number") throw new TypeError("Missing WebHDFS remainingEntries.");
      const remaining = integer(listing.remainingEntries, "remaining entries");
      const values = object(object(listing.partialListing).FileStatuses).FileStatus;
      if (!Array.isArray(values)) throw new TypeError("Malformed WebHDFS partial listing.");
      if (values.length > this.#entries - result.length) throw new RangeError("WebHDFS listing exceeds maxEntries.");
      for (const value of values) {
        const next = entry(value, true);
        if (seen.has(next.name) || !advances(result.at(-1)?.name ?? "", next.name)) {
          throw new TypeError("WebHDFS listing repeats a child or moves its cursor backwards.");
        }
        seen.add(next.name);
        result.push(next);
      }
      if (remaining === 0) return Object.freeze(result);
      const last = result.at(-1)?.name;
      if (values.length === 0 || last === undefined || last === after) {
        throw new TypeError("WebHDFS listing has no cursor progress.");
      }
      after = last;
    }
    throw new RangeError("WebHDFS listing exceeds maxPages.");
  }

  async get(input: string, options: FileDriverReadOptionsType = {}): Promise<ReadableStream<Uint8Array>> {
    const selected = range(options);
    const canonical = path(input);
    if (selected.empty) return new Blob([]).stream();
    const length = selected.end === undefined ? undefined : selected.end - selected.start + 1;
    if (length !== undefined && length > this.#readBytes) throw new RangeError("WebHDFS read exceeds maxReadBytes.");
    const url = this.#url(canonical, "OPEN", {
      offset: String(selected.start),
      ...(length === undefined ? {} : { length: String(length) }),
    });
    let response = await this.#request(url, "namenode", "GET", selected.signal);
    if (response.status === 307) {
      const next = await readResponse(response, () => this.#redirect(response, url));
      response = await this.#request(next, "datanode", "GET", selected.signal);
    }
    try {
      selected.signal?.throwIfAborted();
      if (response.status !== 200) throw new WebhdfsError(response.status, "OPEN");
      const encoding = response.headers.get("content-encoding");
      if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
        throw new TypeError("Encoded WebHDFS responses cannot preserve offsets.");
      }
      const text = response.headers.get("content-length");
      const expected = text === null ? undefined : /^\d+$/.test(text) ? integer(Number(text), "Content-Length") : NaN;
      const maximum = Math.min(length ?? this.#readBytes, this.#readBytes);
      if (expected !== undefined && (!Number.isSafeInteger(expected) || expected > maximum)) {
        throw new RangeError("WebHDFS Content-Length exceeds its extent or limit.");
      }
      if (response.body === null) throw new TypeError("WebHDFS OPEN requires a body.");
      return body(response.body, maximum, expected);
    } catch (reason) {
      return await readResponse(response, () => {
        throw reason;
      });
    }
  }

  /** Never sends the payload to the NameNode or retries after DataNode mutation dispatch. */
  async #write(
    input: string,
    bytes: Uint8Array,
    operation: "CREATE" | "APPEND",
    signal: AbortSignal | undefined,
    overwrite: boolean,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (!isBytes(bytes)) throw new TypeError("WebHDFS writes require a Uint8Array.");
    const view = toView(bytes);
    if (view.byteLength > this.#writeBytes) throw new RangeError("WebHDFS write exceeds maxWriteBytes.");
    const snapshot = new Uint8Array(view);
    const url = this.#url(
      input,
      operation,
      operation === "CREATE" ? { overwrite: String(overwrite), createparent: "false" } : {},
    );
    const method = operation === "CREATE" ? "PUT" : "POST";
    const response = await this.#request(url, "namenode", method, signal, undefined, true);
    const next = await readResponse(response, () => {
      if (response.status >= 500 || response.status === 408 || (response.status >= 200 && response.status < 300)) {
        throw new WebhdfsPublicationError(operation, new WebhdfsError(response.status, operation));
      }
      return this.#redirect(response, url);
    });
    const published = await this.#request(next, "datanode", method, signal, snapshot, true);
    await readResponse(published, () => {
      if (published.status !== (operation === "CREATE" ? 201 : 200)) {
        const reason = new WebhdfsError(published.status, operation);
        if (published.status >= 500 || published.status === 408 || published.status < 400) {
          throw new WebhdfsPublicationError(operation, reason);
        }
        throw reason;
      }
    });
  }

  put(
    input: string,
    bytes: Uint8Array,
    { signal, overwrite = false }: FileDriverSignalOptionsType & { readonly overwrite?: boolean } = {},
  ): Promise<void> {
    if (typeof overwrite !== "boolean") throw new TypeError("overwrite must be boolean.");
    return this.#write(input, bytes, "CREATE", signal, overwrite);
  }
  append(input: string, bytes: Uint8Array, { signal }: FileDriverSignalOptionsType = {}): Promise<void> {
    return this.#write(input, bytes, "APPEND", signal, false);
  }

  /** A malformed/false boolean cannot become a successful namespace receipt. */
  async #boolean(url: URL, method: string, signal?: AbortSignal): Promise<void> {
    const value = await this.#json(url, method, signal, true);
    let result: Record<string, unknown>;
    try {
      result = object(value);
    } catch (reason) {
      throw new WebhdfsPublicationError(url.searchParams.get("op")!, reason);
    }
    if (result.boolean === false) throw new WebhdfsRejectionError(url.searchParams.get("op")!);
    if (result.boolean !== true) {
      throw new WebhdfsPublicationError(
        url.searchParams.get("op")!,
        new TypeError("Missing WebHDFS boolean acknowledgement."),
      );
    }
  }
  mkdir(input: string, { signal }: FileDriverSignalOptionsType = {}): Promise<void> {
    return this.#boolean(this.#url(input, "MKDIRS"), "PUT", signal);
  }
  remove(
    input: string,
    { signal, recursive = false }: FileDriverSignalOptionsType & { readonly recursive?: boolean } = {},
  ): Promise<void> {
    if (typeof recursive !== "boolean") throw new TypeError("recursive must be boolean.");
    return this.#boolean(this.#url(input, "DELETE", { recursive: String(recursive) }), "DELETE", signal);
  }
  rename(source: string, destination: string, { signal }: FileDriverSignalOptionsType = {}): Promise<void> {
    const relative = path(destination);
    const full = this.#root === "/" ? relative : `${this.#root}${relative === "/" ? "" : relative}`;
    return this.#boolean(this.#url(source, "RENAME", { destination: full }), "PUT", signal);
  }
  getMetrics(): RequestMetricsType {
    return this.#metrics.snapshot();
  }
}

/** Captures configuration only; every request and credential callback starts from an explicit operation. */
export function createWebhdfsClient(options: WebhdfsClientOptionsType): WebhdfsClientType {
  return new WebhdfsClient(options);
}
