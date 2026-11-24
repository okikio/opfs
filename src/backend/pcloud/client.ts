/** pCloud ID-based native HTTP operations with explicit account and download authority. @module */
import { toInteger } from "../../check.ts";
import { exactLength } from "../../body.ts";
import { type JsonLimitsType, parseJson } from "../../json.ts";
import { z } from "zod";
import { isBytes, toView } from "../../bytes.ts";
import { close } from "../../close.ts";
import { assertRangeResponse, resolveRange } from "../../range.ts";
import { RequestMetrics, sendRequest } from "../../request.ts";
import type { FetchType, RequestPolicyType } from "../../request.ts";
import { readResponse } from "../../response.ts";
import { collectBytes } from "../../stream.ts";

/** Local materialization ceiling, not a pCloud file-size limit. */
export const PCLOUD_BUFFER_BYTES = 64 * 1024 * 1024;
/** Native identities stay decimal strings even when JSON encodes them as uint64 numbers. */
export interface PcloudMetadataType {
  readonly kind: "file" | "folder";
  readonly id: string;
  readonly name: string;
  readonly parentId?: string;
  readonly size?: number;
  /** Opaque provider numeric content hash; not an authenticated cryptographic digest. */
  readonly hash?: string;
  readonly deleted: boolean;
}
/** A stored file has a safely indexable size. IDs remain scoped to the caller's account. */
export interface PcloudFileType extends PcloudMetadataType {
  readonly kind: "file";
  readonly size: number;
}
/** Choose the API region explicitly. Connection authentication is reset on every request. */
export interface PcloudOptionsType {
  readonly endpoint: string | URL;
  readonly token: (url: URL, signal?: AbortSignal) => string | Promise<string>;
  readonly fetch?: FetchType;
  readonly request?: RequestPolicyType;
  /** Exact origins admitted for signed content hops, including redirects. Default none. */
  readonly downloadOrigins?: readonly string[];
  /** Private protocol fixtures only; HTTPS is the production default. */
  readonly allowHttp?: boolean;
  /** Default 8 MiB; implementation ceiling 64 MiB. */
  readonly maxBytes?: number;
  /** Direct-child listing cap, default 10,000 and ceiling 100,000. No pagination is invented. */
  readonly maxEntries?: number;
}
/** Revision selection is native request context, not proof of immutable random access. */
export interface PcloudReadOptionsType {
  readonly revisionId?: string;
  readonly at?: number;
  readonly length?: number;
  readonly signal?: AbortSignal;
}
/** Signed URLs are secrets. The caller must not log or persist them as stable identities. */
export interface PcloudLinkType {
  readonly url: string;
  /** UTC Unix timestamp seconds, retained as an exact decimal string. */
  readonly expires: string;
}
/** Server-trusted bytes transfer ownership of the stream; consume or cancel it. */
export interface PcloudDownloadType {
  readonly bytes: ReadableStream<Uint8Array>;
  readonly length: number;
  readonly file: PcloudFileType;
  readonly evidence: "server-trusted";
}
/** Service and HTTP failures expose numeric categories, never raw response text or capability URLs. */
export class PcloudError extends Error {
  readonly status: number;
  readonly result: string | undefined;
  /**
   * Creates the error.
   * @param status HTTP status the service returned.
   */
  constructor(status: number, result?: string) {
    super("pCloud request failed.");
    this.name = "PcloudError";
    this.status = status;
    this.result = result;
  }
}
/** Dispatch occurred but no trustworthy final receipt reached the caller. Do not retry blindly. */
export class PcloudPublicationError extends Error {
  readonly outcome = "unknown";
  /**
   * Creates the error.
   * @param cause Failure that caused this error.
   */
  constructor(cause: unknown) {
    super("pCloud mutation outcome is unknown; reconcile it before retrying.", { cause });
    this.name = "PcloudPublicationError";
  }
}
const MetadataSchema = z.object({
  isfolder: z.boolean(),
  id: z.string(),
  name: z.string(),
  parentfolderid: z.string().optional(),
  fileid: z.string().optional(),
  folderid: z.string().optional(),
  size: z.string().optional(),
  hash: z.string().optional(),
  isdeleted: z.boolean().optional(),
  contents: z.unknown().optional(),
});
/** uint64 protocol fields never pass through Number before identity comparison. */
function id(value: unknown): string {
  if (
    typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value) ||
    value.length === 20 && value > "18446744073709551615"
  ) throw new TypeError("Invalid pCloud uint64 identity.");
  return value;
}
function size(value: unknown): number {
  const exact = id(value);
  return toInteger(Number(exact), "pCloud byte size");
}
/** pCloud names are shorter than 1024 UTF-8 bytes; paths and names are distinct. */
function name(value: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length >= 1024 || /[\0/\\]/.test(value) ||
    new TextEncoder().encode(value).length >= 1024 || !value.isWellFormed()
  ) throw new TypeError("Invalid pCloud UTF-8 name.");
  return value;
}
/** API endpoints and content allowlists contain only exact origins, never URL credentials or prefixes. */
function origin(value: string | URL, http: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Invalid pCloud origin.");
  }
  if (
    (url.protocol !== "https:" && !(http && url.protocol === "http:")) || url.username || url.password || url.search ||
    url.hash || url.pathname !== "/"
  ) throw new TypeError("pCloud requires an explicit clean origin.");
  return url;
}
/** URL/token syntax must not silently trim separators or reinterpret backslashes. */
function separators(value: string): boolean {
  for (let at = 0; at < value.length; at++) {
    const code = value.charCodeAt(at);
    if (code <= 32 || code === 127 || code === 92) return true;
  }
  return false;
}
/** Limits for this service's JSON responses; see `parseJson`. */
const jsonLimits: JsonLimitsType = {
  label: "pCloud",
  maxLength: 8 * 1024 * 1024,
  maxTokens: 1_000_000,
  maxString: 32_768,
  maxScalar: 128,
  number: (raw) => raw,
};

/** Metadata identity must agree with both its prefixed ID and concrete native kind. */
function metadata(value: unknown): PcloudMetadataType {
  const data = MetadataSchema.parse(value), selected = id(data.isfolder ? data.folderid : data.fileid);
  if (data.isfolder ? data.fileid !== undefined : data.folderid !== undefined) {
    throw new TypeError("pCloud metadata mixes file and folder identity.");
  }
  if (data.id !== `${data.isfolder ? "d" : "f"}${selected}`) throw new TypeError("pCloud metadata identities differ.");
  const parent = data.parentfolderid === undefined ? undefined : id(data.parentfolderid);
  if (!(data.isfolder && selected === "0") && parent === undefined) {
    throw new TypeError("pCloud metadata lacks parent identity.");
  }
  const filename = data.isfolder && selected === "0" && data.name === "/" ? "/" : name(data.name);
  return {
    kind: data.isfolder ? "folder" : "file",
    id: selected,
    name: filename,
    deleted: data.isdeleted === true,
    ...(parent === undefined ? {} : { parentId: parent }),
    ...(!data.isfolder ? { size: size(data.size) } : {}),
    ...(data.hash === undefined ? {} : { hash: id(data.hash) }),
  };
}
function file(value: unknown, expected?: string): PcloudFileType {
  const data = metadata(value);
  if (data.kind !== "file" || data.size === undefined || expected !== undefined && data.id !== expected) {
    throw new TypeError("pCloud returned another file or resource kind.");
  }
  return { ...data, kind: "file", size: data.size };
}

/** Native ID client; construction has no network, login, region or cookie discovery. */
export class PcloudClient {
  readonly #endpoint: URL;
  readonly #token: PcloudOptionsType["token"];
  readonly #fetch: FetchType;
  readonly #request: RequestPolicyType | undefined;
  readonly #downloads: ReadonlySet<string>;
  readonly #http: boolean;
  readonly #bytes: number;
  readonly #entries: number;
  readonly #metrics = new RequestMetrics();
  /**
   * Creates the client from `options`.
   * @param options Options that configure the client.
   */
  constructor(options: PcloudOptionsType) {
    this.#http = options.allowHttp === true;
    this.#endpoint = origin(options.endpoint, this.#http);
    this.#downloads = new Set((options.downloadOrigins ?? []).map((item) => origin(item, this.#http).origin));
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#request = options.request === undefined ? undefined : { ...options.request };
    this.#bytes = toInteger(options.maxBytes ?? 8 * 1024 * 1024, "pCloud byte budget", PCLOUD_BUFFER_BYTES);
    this.#entries = toInteger(options.maxEntries ?? 10000, "pCloud entry budget", 100000);
  }
  /** Each API operation reauthenticates the connection; credentials never enter its URL. */
  async #call<Value>(
    method: string,
    params: Record<string, string>,
    parse: (value: Record<string, unknown>) => Value,
    signal?: AbortSignal,
    mutation = false,
    upload?: { bytes: Uint8Array<ArrayBuffer>; name: string },
  ): Promise<Value> {
    const url = new URL(method, this.#endpoint);
    const form = upload === undefined ? new URLSearchParams() : new FormData();
    for (
      const [key, value] of Object.entries({
        ...params,
        logout: "1",
        timeformat: "timestamp",
        filtermeta: "0",
        filterfilemeta: "0",
        filterfoldermeta: "0",
      })
    ) form.append(key, value);
    // Bytes and target were copied by admission. The Blob exists before token acquisition.
    const blob = upload === undefined ? undefined : new Blob([upload.bytes]);
    signal?.throwIfAborted();
    const token = await this.#token(new URL(url), signal);
    signal?.throwIfAborted();
    if (typeof token !== "string" || token.length === 0 || token.length > 32768 || separators(token)) {
      throw new TypeError("Invalid pCloud OAuth token.");
    }
    form.append("access_token", token);
    if (blob !== undefined && form instanceof FormData) form.append("file", blob, upload!.name);
    let dispatched = false;
    try {
      const response = await sendRequest(
        async (signal) => ({
          input: url,
          init: {
            method: "POST",
            body: form,
            credentials: "omit",
            redirect: "manual",
            referrerPolicy: "no-referrer",
            ...(signal === undefined ? {} : { signal }),
          },
        }),
        {
          fetch: (input, init) => {
            dispatched = true;
            return this.#fetch(input, init);
          },
          replayable: false,
          metrics: this.#metrics,
          ...(this.#request === undefined ? {} : { policy: this.#request }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return await readResponse(response, async (text) => {
        if (response.status !== 200) throw new PcloudError(response.status);
        const value = z.record(z.string(), z.unknown()).parse(parseJson(await text(), jsonLimits));
        const result = id(value.result);
        if (result !== "0") throw new PcloudError(response.status, result);
        return parse(value);
      });
    } catch (reason) {
      if (mutation && dispatched) throw new PcloudPublicationError(reason);
      throw reason;
    }
  }
  /** File IDs select resources; names do not. Optional revisions use native global context. */
  async statFile(
    fileId: string,
    options: { readonly revisionId?: string; readonly signal?: AbortSignal } = {},
  ): Promise<PcloudFileType> {
    const selected = id(fileId),
      revisionId = options.revisionId === undefined ? undefined : id(options.revisionId),
      signal = options.signal;
    return await this.#call("stat", {
      fileid: selected,
      ...(revisionId === undefined ? {} : { revisionid: revisionId }),
    }, (value) => {
      const data = file(value.metadata, selected);
      if (data.deleted) throw new TypeError("pCloud file is deleted.");
      return data;
    }, signal);
  }
  /** One bounded direct-child response; the native method has no documented continuation cursor. */
  async listFolder(
    folderId: string,
    signal?: AbortSignal,
  ): Promise<{ readonly folder: PcloudMetadataType; readonly entries: readonly PcloudMetadataType[] }> {
    const selected = id(folderId);
    return await this.#call("listfolder", { folderid: selected }, (value) => {
      const folder = metadata(value.metadata), raw = MetadataSchema.parse(value.metadata);
      if (folder.kind !== "folder" || folder.id !== selected || folder.deleted) {
        throw new TypeError("pCloud returned another folder.");
      }
      const contents = z.array(z.unknown()).max(this.#entries).parse(raw.contents),
        seen = new Set<string>(),
        names = new Set<string>();
      const entries = contents.map((value) => {
        const raw = MetadataSchema.parse(value),
          item = metadata(value),
          key = `${item.kind}:${item.id}`,
          spelling = `${item.kind}:${item.name}`;
        if (
          raw.contents !== undefined || item.deleted || item.parentId !== selected ||
          item.kind === "folder" && item.id === selected || seen.has(key) || names.has(spelling)
        ) throw new TypeError("pCloud child identity, parent or direct-list scope differs.");
        seen.add(key);
        names.add(spelling);
        return item;
      });
      return { folder, entries };
    }, signal);
  }
  /** Server-computed checksums have regional availability; none is publisher authentication. */
  async checksumFile(
    fileId: string,
    signal?: AbortSignal,
  ): Promise<
    { readonly file: PcloudFileType; readonly sha1: string; readonly md5?: string; readonly sha256?: string }
  > {
    const selected = id(fileId);
    return await this.#call("checksumfile", { fileid: selected }, (value) => {
      const data = z.object({
        sha1: z.string().regex(/^[0-9a-f]{40}$/),
        md5: z.string().regex(/^[0-9a-f]{32}$/).optional(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      }).parse(value);
      return {
        file: file(value.metadata, selected),
        sha1: data.sha1,
        ...(data.md5 === undefined ? {} : { md5: data.md5 }),
        ...(data.sha256 === undefined ? {} : { sha256: data.sha256 }),
      };
    }, signal);
  }
  /** Capability URLs are admitted before use; browser applications are restricted by pCloud. */
  async getFileLink(
    fileId: string,
    options: { readonly revisionId?: string; readonly signal?: AbortSignal } = {},
  ): Promise<PcloudLinkType> {
    const selected = id(fileId),
      revision = options.revisionId === undefined ? undefined : id(options.revisionId),
      signal = options.signal;
    return await this.#call("getfilelink", {
      fileid: selected,
      ...(revision === undefined ? {} : { revisionid: revision }),
    }, (value) => {
      const data = z.object({
        hosts: z.array(z.string().min(1).max(253)).min(1).max(32),
        path: z.string().min(1).max(16384),
        expires: z.string().max(128),
      }).parse(value);
      if (
        !data.path.startsWith("/") || data.path.startsWith("//") || separators(data.path) ||
        data.path.includes("#")
      ) throw new TypeError("Invalid pCloud capability path.");
      for (const host of data.hosts) {
        if (!/^[a-zA-Z0-9.-]+(?::[0-9]{1,5})?$/.test(host)) throw new TypeError("Invalid pCloud content host.");
        for (const protocol of this.#http ? ["https", "http"] : ["https"]) {
          let url: URL;
          try {
            url = new URL(data.path, `${protocol}://${host}/`);
          } catch {
            throw new TypeError("Invalid pCloud content URL.");
          }
          if (url.pathname + url.search !== data.path) {
            throw new TypeError("pCloud capability path requires normalization.");
          }
          if (this.#downloads.has(url.origin)) return { url: url.href, expires: id(data.expires) };
        }
      }
      throw new TypeError("pCloud content origin is not explicitly allowed.");
    }, signal);
  }
  /** Download streams carry server-trusted exact extent evidence, not immutable object identity. */
  async download(fileId: string, options: PcloudReadOptionsType = {}): Promise<PcloudDownloadType> {
    const selectedId = id(fileId), selected = resolveRange(options);
    const revisionId = options.revisionId === undefined ? undefined : id(options.revisionId), signal = selected.signal;
    const captured = {
      ...(revisionId === undefined ? {} : { revisionId }),
      ...(signal === undefined ? {} : { signal }),
    };
    if (selected.empty) throw new RangeError("Use read() for a local empty pCloud read.");
    const stored = await this.statFile(selectedId, captured);
    if (selected.start >= stored.size && selected.header !== undefined) {
      throw new RangeError("pCloud range starts beyond EOF.");
    }
    const expected = selected.header === undefined
      ? stored.size
      : Math.min(selected.end ?? stored.size - 1, stored.size - 1) - selected.start + 1;
    let url = new URL((await this.getFileLink(selectedId, captured)).url);
    const visited = new Set<string>();
    for (let hop = 0; hop <= 3; hop++) {
      if (!this.#downloads.has(url.origin) || url.username || url.password || url.hash || visited.has(url.href)) {
        throw new TypeError("Invalid or repeated pCloud content hop.");
      }
      visited.add(url.href);
      const headers = new Headers();
      if (selected.header !== undefined) headers.set("Range", selected.header);
      const response = await sendRequest(
        async (signal) => ({
          input: url,
          init: {
            headers,
            method: "GET",
            credentials: "omit",
            redirect: "manual",
            referrerPolicy: "no-referrer",
            ...(signal === undefined ? {} : { signal }),
          },
        }),
        {
          fetch: this.#fetch,
          replayable: false,
          metrics: this.#metrics,
          ...(this.#request === undefined ? {} : { policy: this.#request }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await close(response.body === null ? [] : [() => response.body!.cancel()]);
        if (location === null || location.length > 16384 || separators(location)) {
          throw new TypeError("Invalid pCloud redirect.");
        }
        try {
          url = new URL(location, url);
        } catch {
          throw new TypeError("Invalid pCloud redirect URL.");
        }
        continue;
      }
      await assertRangeResponse(response, selected);
      try {
        const declared = response.headers.get("content-length"), contentRange = response.headers.get("content-range");
        if (
          selected.header !== undefined && Number(contentRange?.split("/")[1]) !== stored.size ||
          declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) !== expected)
        ) throw new TypeError("pCloud content extent differs from described size.");
        if (response.body === null && expected !== 0) throw new TypeError("pCloud content body is missing.");
        const body = response.body ?? new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
        return {
          file: stored,
          bytes: exactLength(body, expected, { label: "pCloud body", resource: "pCloud content", signal: signal }),
          length: expected,
          evidence: "server-trusted",
        };
      } catch (reason) {
        await close(response.body === null ? [] : [() => response.body!.cancel(reason)], [reason]);
        throw reason;
      }
    }
    throw new TypeError("pCloud redirect budget exhausted.");
  }
  /** Bounded materialization; zero length is local and does not prove existence. */
  async read(fileId: string, options: PcloudReadOptionsType = {}): Promise<Uint8Array> {
    const selected = resolveRange(options), selectedId = id(fileId);
    const revisionId = options.revisionId === undefined ? undefined : id(options.revisionId);
    if (selected.empty) return new Uint8Array();
    const captured = {
      ...(revisionId === undefined ? {} : { revisionId }),
      ...(selected.header === undefined
        ? {}
        : { at: selected.start, ...(selected.end === undefined ? {} : { length: selected.end - selected.start + 1 }) }),
      ...(selected.signal === undefined ? {} : { signal: selected.signal }),
    };
    const data = await this.download(selectedId, captured);
    if (data.length > this.#bytes) {
      const reason = new RangeError("pCloud read exceeds its byte budget.");
      await close([() => data.bytes.cancel(reason)], [reason]);
    }
    return await collectBytes(data.bytes, this.#bytes, selected.signal, "read", "pCloud content");
  }
  /** Native overwrite or conflict rename must be explicit. Neither is compare-and-swap. */
  async upload(
    folderId: string,
    filename: string,
    bytes: Uint8Array,
    options: { readonly conflict: "overwrite" | "rename"; readonly signal?: AbortSignal },
  ): Promise<PcloudFileType> {
    const parent = id(folderId), spelling = name(filename), conflict = options.conflict, signal = options.signal;
    signal?.throwIfAborted();
    if (conflict !== "overwrite" && conflict !== "rename") {
      throw new TypeError("Choose pCloud native conflict behavior explicitly.");
    }
    if (!isBytes(bytes)) throw new TypeError("pCloud upload requires Uint8Array bytes.");
    const view = toView(bytes);
    if (view.length > this.#bytes) throw new RangeError("pCloud upload exceeds its byte budget.");
    const owned = new Uint8Array(view);
    return await this.#call(
      "uploadfile",
      { folderid: parent, nopartial: "1", ...(conflict === "rename" ? { renameifexists: "1" } : {}) },
      (value) => {
        const ids = z.array(z.string()).length(1).parse(value.fileids),
          values = z.array(z.unknown()).length(1).parse(value.metadata);
        const stored = file(values[0], id(ids[0]));
        if (
          stored.parentId !== parent || stored.size !== owned.length || stored.deleted ||
          conflict === "overwrite" && stored.name !== spelling
        ) {
          throw new TypeError("pCloud upload receipt differs from the requested file.");
        }
        return stored;
      },
      signal,
      true,
      { bytes: owned, name: spelling },
    );
  }
  /** Native one-folder creation; server conflict behavior is not an exclusive publication guarantee. */
  async createFolder(parentId: string, filename: string, signal?: AbortSignal): Promise<PcloudMetadataType> {
    const parent = id(parentId), spelling = name(filename);
    return await this.#call(
      "createfolder",
      { folderid: parent, name: spelling },
      (value) => {
        const stored = metadata(value.metadata);
        if (
          stored.kind !== "folder" || stored.parentId !== parent || stored.name !== spelling || stored.deleted
        ) throw new TypeError("pCloud folder receipt differs from the request.");
        return stored;
      },
      signal,
      true,
    );
  }
  /** Delete the current native file, not one revision. No permanent trash-purge claim. */
  async deleteFile(fileId: string, signal?: AbortSignal): Promise<PcloudFileType> {
    const selected = id(fileId);
    return await this.#call(
      "deletefile",
      { fileid: selected },
      (value) => {
        const stored = file(value.metadata, selected);
        if (!stored.deleted) throw new TypeError("pCloud deletion receipt is missing isdeleted.");
        return stored;
      },
      signal,
      true,
    );
  }
}
