/** ID-based Google Drive stored-file operations. No filesystem namespace is implied. @module */
import { z } from "zod";
import { isBytes, toRequestBytes, toView } from "./bytes.ts";
import { assertRangeResponse, range } from "./range.ts";
import { RequestMetrics, sendRequest } from "./request.ts";
import type { FetchType, RequestPolicyType } from "./request.ts";
import { readResponse } from "./response.ts";
import type { UploadDestinationType } from "./transfer.ts";

/** Nonfinal resumable extents must be multiples of this protocol alignment. */
export const DRIVE_CHUNK_BYTES = 256 * 1024;
const fields = "id,name,mimeType,size,parents,trashed,version";
const FileSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  name: z.string(),
  mimeType: z.string(),
  size: z.string().regex(/^\d+$/).optional(),
  parents: z.array(z.string()).optional(),
  trashed: z.boolean().optional(),
  version: z.string().optional(),
});
/** A Drive resource is addressed by ID. Names are neither unique nor paths. */
export interface DriveFileType {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size?: number;
  readonly parents?: readonly string[];
  readonly trashed?: boolean;
  /** Opaque informational version; not a read precondition or immutable identity. */
  readonly version?: string;
}
/** The caller owns OAuth acquisition, scopes, refresh and account selection. */
export interface DriveOptionsType {
  readonly token: (url: URL, signal?: AbortSignal) => string | Promise<string>;
  readonly fetch?: FetchType;
  readonly endpoint?: string | URL;
  readonly uploadEndpoint?: string | URL;
  readonly request?: RequestPolicyType;
  readonly maxPages?: number;
  readonly maxEntries?: number;
}
/** Explicit list corpus. Omit sharedDriveId for the authenticated user's corpus. */
export interface DriveListOptionsType {
  readonly sharedDriveId?: string;
  readonly parent?: string;
  readonly pageToken?: string;
  readonly pageSize?: number;
  readonly signal?: AbortSignal;
}
/** Native page evidence remains visible, including incomplete search. */
export interface DrivePageType {
  readonly files: readonly DriveFileType[];
  readonly nextPageToken?: string;
  readonly incompleteSearch: boolean;
}
/** Protect resumable URLs as credentials; caller retains the fixed source and session exclusively. */
export interface DriveUploadType {
  readonly url: string;
  readonly size: number;
  readonly fileId?: string;
}
/** Only a validated final file receipt represents completed publication. */
export type DriveUploadStatusType =
  | Readonly<{ complete: false; offset: number }>
  | Readonly<{ complete: true; offset: number; file: DriveFileType }>;
/** Unknown publication must be reconciled through the existing session, never blind creation. */
export class DrivePublicationError extends Error {
  constructor(cause: unknown) {
    super("Drive mutation has no validated acknowledgement; reconcile before retrying.", { cause });
    this.name = "DrivePublicationError";
  }
}
/** HTTP failure messages intentionally exclude credential-bearing URLs and bodies. */
export class DriveError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Google Drive request failed with HTTP ${status}.`);
    this.name = "DriveError";
    this.status = status;
  }
}
/** Bound arithmetic before transport or credentials. */
function integer(value: number, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new RangeError(`Invalid ${label}.`);
  return value;
}
/** IDs have no path/query interpretation. Root is a documented Drive alias. */
function id(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/.test(value)) throw new TypeError("Invalid Drive ID.");
  return value;
}
/** Admission does not infer content integrity from service metadata. */
function file(value: unknown, expected?: string): DriveFileType {
  const data = FileSchema.parse(value);
  if (expected !== undefined && expected !== "root" && data.id !== expected) {
    throw new TypeError("Drive receipt names another file.");
  }
  const size = data.size === undefined ? undefined : integer(Number(data.size), "Drive file size");
  // Wire optionals can include explicit undefined. The public exact-optional
  // contract omits those properties instead of spreading the parsed wire shape.
  return {
    id: data.id,
    name: data.name,
    mimeType: data.mimeType,
    ...(size === undefined ? {} : { size }),
    ...(data.parents === undefined ? {} : { parents: data.parents }),
    ...(data.trashed === undefined ? {} : { trashed: data.trashed }),
    ...(data.version === undefined ? {} : { version: data.version }),
  };
}
/** Workspace native documents, shortcuts and folders are not stored-file media. */
function stored(mimeType: string): void {
  if (!mimeType || mimeType.toLowerCase().startsWith("application/vnd.google-apps.")) {
    throw new TypeError("This operation requires stored-file media; Workspace export is separate.");
  }
}
/** Explicit endpoints are credential boundaries, not arbitrary redirect targets. */
function endpoint(value: string | URL): URL {
  const url = new URL(value);
  if (
    !/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash ||
    !url.pathname.endsWith("/")
  ) {
    throw new TypeError("Drive endpoints require HTTP(S), a trailing slash and no credentials, query or fragment.");
  }
  return url;
}

/** Native client owns no ambient credentials, timers or connection pools. */
export class DriveClient {
  readonly #api: URL;
  readonly #upload: URL;
  readonly #token: DriveOptionsType["token"];
  readonly #fetch: FetchType;
  readonly #policy: RequestPolicyType | undefined;
  readonly #pages: number;
  readonly #entries: number;
  readonly #metrics = new RequestMetrics();
  constructor(options: DriveOptionsType) {
    this.#api = endpoint(options.endpoint ?? "https://www.googleapis.com/drive/v3/");
    this.#upload = endpoint(options.uploadEndpoint ?? "https://www.googleapis.com/upload/drive/v3/");
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#policy = options.request;
    this.#pages = integer(options.maxPages ?? 1000, "page budget");
    this.#entries = integer(options.maxEntries ?? 100000, "entry budget");
  }
  /** Control responses are bounded by the shared 8 MiB control-body policy. */
  async #json(response: Response): Promise<unknown> {
    return await readResponse(response, async (text) => {
      if (!response.ok) throw new DriveError(response.status);
      return JSON.parse(await text());
    });
  }
  /** No redirects or mutation retries; per-URL token callbacks cannot change the admitted target. */
  async #request(url: URL, method: string, headers: Headers, body?: BodyInit, signal?: AbortSignal): Promise<Response> {
    signal?.throwIfAborted();
    const token = await this.#token(new URL(url), signal);
    signal?.throwIfAborted();
    if (!token || /[\r\n]/.test(token)) throw new TypeError("Invalid Drive bearer token.");
    headers.set("Authorization", `Bearer ${token}`);
    return await sendRequest(
      async (signal) => ({
        input: url,
        init: {
          method,
          headers,
          ...(signal === undefined ? {} : { signal }),
          redirect: "manual",
          ...(body === undefined ? {} : { body }),
        },
      }),
      {
        fetch: this.#fetch,
        replayable: method === "GET",
        metrics: this.#metrics,
        ...(this.#policy === undefined ? {} : { policy: this.#policy }),
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }
  #url(path: string, upload = false): URL {
    const url = new URL(path, upload ? this.#upload : this.#api);
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("fields", fields);
    return url;
  }
  /** Read metadata by ID; a name collision cannot select another file. */
  async stat(fileId: string, signal?: AbortSignal): Promise<DriveFileType> {
    const selected = id(fileId);
    return file(
      await this.#json(await this.#request(this.#url(`files/${selected}`), "GET", new Headers(), undefined, signal)),
      selected,
    );
  }
  /** One bounded native page; duplicate names are retained. */
  async listPage(options: DriveListOptionsType = {}): Promise<DrivePageType> {
    const { parent, sharedDriveId, pageToken, signal } = options;
    const pageSize = integer(options.pageSize ?? 100, "page size", 1000);
    if (pageSize === 0 || (pageToken !== undefined && (!pageToken || pageToken.length > 16384))) {
      throw new TypeError("Invalid Drive page request.");
    }
    const url = this.#url("files");
    url.searchParams.set("fields", `files(${fields}),nextPageToken,incompleteSearch`);
    url.searchParams.set("pageSize", String(pageSize));
    url.searchParams.set("corpora", sharedDriveId === undefined ? "user" : "drive");
    if (sharedDriveId !== undefined) {
      url.searchParams.set("driveId", id(sharedDriveId));
      url.searchParams.set("includeItemsFromAllDrives", "true");
    }
    url.searchParams.set("q", `trashed = false${parent === undefined ? "" : ` and '${id(parent)}' in parents`}`);
    if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
    const data = z.object({
      files: z.array(z.unknown()),
      nextPageToken: z.string().min(1).max(16384).optional(),
      incompleteSearch: z.boolean().optional(),
    })
      .parse(await this.#json(await this.#request(url, "GET", new Headers(), undefined, signal)));
    if (data.files.length > pageSize) throw new RangeError("Drive page exceeds the requested entry budget.");
    return {
      files: data.files.map((entry) => file(entry)),
      incompleteSearch: data.incompleteSearch ?? false,
      ...(data.nextPageToken === undefined ? {} : { nextPageToken: data.nextPageToken }),
    };
  }
  /** Complete iteration is bounded and refuses server-reported incomplete searches or cursor cycles. */
  async *list(options: DriveListOptionsType = {}): AsyncGenerator<DriveFileType> {
    const selected = { ...options };
    let pageToken = selected.pageToken;
    let count = 0;
    const tokens = new Set<string>();
    for (let page = 0; page < this.#pages; page++) {
      if (pageToken !== undefined) {
        if (tokens.has(pageToken)) throw new TypeError("Drive page token repeated.");
        tokens.add(pageToken);
      }
      const result = await this.listPage({ ...selected, ...(pageToken === undefined ? {} : { pageToken }) });
      if (result.incompleteSearch) throw new TypeError("Drive search is incomplete; narrow its corpus.");
      count += result.files.length;
      if (count > this.#entries) throw new RangeError("Drive listing exceeds the entry budget.");
      yield* result.files;
      if (result.nextPageToken === undefined) return;
      pageToken = result.nextPageToken;
    }
    throw new RangeError("Drive listing exceeds the page budget.");
  }
  /** Borrowed mutable-file read, not a pinned snapshot. Caller owns draining/cancelling the returned stream. */
  async download(
    fileId: string,
    options: { readonly at?: number; readonly length?: number; readonly signal?: AbortSignal } = {},
  ): Promise<ReadableStream<Uint8Array>> {
    const selected = range(options);
    const selectedId = id(fileId);
    if (selected.empty) {
      return new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
    }
    stored((await this.stat(selectedId, selected.signal)).mimeType);
    const url = this.#url(`files/${selectedId}`);
    url.searchParams.delete("fields");
    url.searchParams.set("alt", "media");
    const headers = new Headers({ "Accept-Encoding": "identity" });
    if (selected.header !== undefined) headers.set("Range", selected.header);
    const response = await this.#request(url, "GET", headers, undefined, selected.signal);
    if (!response.ok) await this.#json(response);
    await assertRangeResponse(response, selected);
    if (response.body === null) throw new TypeError("Drive media response has no body.");
    return response.body;
  }
  /** Metadata changes never assert optimistic concurrency or content replacement. */
  async update(
    fileId: string,
    changes: { readonly name?: string; readonly trashed?: boolean },
    signal?: AbortSignal,
  ): Promise<DriveFileType> {
    const selected = id(fileId);
    const data = z.object({ name: z.string().optional(), trashed: z.boolean().optional() }).strict().parse(changes);
    try {
      return file(
        await this.#json(
          await this.#request(
            this.#url(`files/${selected}`),
            "PATCH",
            new Headers({ "Content-Type": "application/json" }),
            JSON.stringify(data),
            signal,
          ),
        ),
        selected,
      );
    } catch (cause) {
      if (cause instanceof DriveError && cause.status >= 400 && cause.status < 500) throw cause;
      throw new DrivePublicationError(cause);
    }
  }
  /** Trash is reversible metadata; permanent deletion is a separate operation. */
  async trash(fileId: string, signal?: AbortSignal): Promise<DriveFileType> {
    return await this.update(fileId, { trashed: true }, signal);
  }
  /** Permanently delete by ID. Folder deletion can affect descendants; this is not a filesystem primitive. */
  async remove(fileId: string, signal?: AbortSignal): Promise<void> {
    const url = this.#url(`files/${id(fileId)}`);
    try {
      const response = await this.#request(url, "DELETE", new Headers(), undefined, signal);
      await readResponse(response, () => {
        if (response.status !== 204) throw new DriveError(response.status);
      });
    } catch (cause) {
      if (cause instanceof DriveError && cause.status >= 400 && cause.status < 500) throw cause;
      throw new DrivePublicationError(cause);
    }
  }
  /** Admit restored session authority before any token callback; only this configured upload route is allowed. */
  #session(upload: DriveUploadType): { url: URL; size: number; fileId?: string } {
    const { url: address, fileId, size } = upload;
    const url = new URL(address);
    const expected = fileId === undefined ? "files" : `files/${id(fileId)}`;
    const keys = new Set<string>();
    // A session query carries upload authority, not a second OAuth channel or
    // an arbitrary Drive API operation. Reject duplicates rather than depending
    // on which proxy/server selects the first or last value.
    for (const key of url.searchParams.keys()) {
      if (keys.has(key) || !["uploadType", "upload_id", "fields", "supportsAllDrives"].includes(key)) {
        throw new TypeError("Drive upload session has unsupported or repeated query fields.");
      }
      keys.add(key);
    }
    if (
      url.origin !== this.#upload.origin || url.pathname !== new URL(expected, this.#upload).pathname || url.username ||
      url.password || url.hash || url.href.length > 65536 || url.searchParams.get("uploadType") !== "resumable" ||
      !url.searchParams.get("upload_id") || fileId === "root"
    ) {
      throw new TypeError("Drive upload session is outside the configured upload route.");
    }
    return {
      url,
      size: integer(size, "upload size"),
      ...(fileId === undefined ? {} : { fileId }),
    };
  }
  /** Create or replace stored content through a fixed-size session. No session is automatically restarted. */
  async createUpload(
    options: {
      readonly size: number;
      readonly fileId?: string;
      readonly name?: string;
      readonly mimeType: string;
      readonly parent?: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<DriveUploadType> {
    const { size, fileId, name, mimeType, parent, signal } = options;
    integer(size, "upload size");
    stored(mimeType);
    if (fileId === undefined && (typeof name !== "string" || !name)) {
      throw new TypeError("New Drive files require a name.");
    }
    if (fileId !== undefined && parent !== undefined) throw new TypeError("Content updates do not move Drive parents.");
    if (fileId === "root") throw new TypeError("Drive root is not a stored file upload target.");
    const url = this.#url(fileId === undefined ? "files" : `files/${id(fileId)}`, true);
    url.searchParams.set("uploadType", "resumable");
    const metadata = {
      ...(name === undefined ? {} : { name }),
      mimeType,
      ...(parent === undefined ? {} : { parents: [id(parent)] }),
    };
    const response = await this.#request(
      url,
      fileId === undefined ? "POST" : "PATCH",
      new Headers({
        "Content-Type": "application/json",
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": String(size),
      }),
      JSON.stringify(metadata),
      signal,
    );
    return await readResponse(response, () => {
      if (!response.ok) throw new DriveError(response.status);
      const location = response.headers.get("location");
      if (location === null) throw new TypeError("Drive did not return an upload session.");
      const upload = { url: new URL(location, url).href, size, ...(fileId === undefined ? {} : { fileId }) };
      this.#session(upload);
      return upload;
    });
  }
  /** Consume only server acknowledgements; sent bytes are never an acknowledged offset. */
  async #status(response: Response, upload: { size: number; fileId?: string }): Promise<DriveUploadStatusType> {
    return await readResponse(response, async (text) => {
      if (response.status === 308) {
        const value = response.headers.get("range");
        const match = value === null ? undefined : /^bytes=0-(\d+)$/.exec(value);
        if (value !== null && !match) throw new TypeError("Malformed Drive acknowledged range.");
        const offset = match ? integer(Number(match[1]) + 1, "acknowledged offset", upload.size) : 0;
        return { complete: false, offset };
      }
      if (response.status !== 200 && response.status !== 201) throw new DriveError(response.status);
      const receipt = file(JSON.parse(await text()), upload.fileId);
      stored(receipt.mimeType);
      if (receipt.size !== upload.size) throw new TypeError("Drive completed receipt has a different byte count.");
      return { complete: true, offset: upload.size, file: receipt };
    });
  }
  /** Reconcile after interruption; 404 expires the session and never starts another creation. */
  async queryUpload(upload: DriveUploadType, signal?: AbortSignal): Promise<DriveUploadStatusType> {
    const selected = this.#session(upload);
    return await this.#status(
      await this.#request(
        selected.url,
        "PUT",
        new Headers({ "Content-Range": `bytes */${selected.size}` }),
        new Uint8Array(0),
        signal,
      ),
      selected,
    );
  }
  /** Snapshot a bounded caller extent before awaiting OAuth. Nonfinal writes are 256 KiB aligned. */
  async writeUpload(
    upload: DriveUploadType,
    offset: number,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<DriveUploadStatusType> {
    const selected = this.#session(upload);
    integer(offset, "upload offset", selected.size);
    if (!isBytes(bytes)) throw new TypeError("Drive upload requires a Uint8Array.");
    const view = toView(bytes);
    const end = offset + view.byteLength;
    if (
      end > selected.size || view.byteLength > 8 * 1024 * 1024 ||
      (end !== selected.size && (view.byteLength === 0 || view.byteLength % DRIVE_CHUNK_BYTES !== 0))
    ) throw new RangeError("Invalid Drive upload extent (8 MiB implementation ceiling).");
    const body = toRequestBytes(new Uint8Array(view));
    const header = view.byteLength === 0 ? `bytes */${selected.size}` : `bytes ${offset}-${end - 1}/${selected.size}`;
    try {
      const status = await this.#status(
        await this.#request(
          selected.url,
          "PUT",
          new Headers({ "Content-Range": header, "Content-Type": "application/octet-stream" }),
          body,
          signal,
        ),
        selected,
      );
      if (status.offset < offset || status.offset > end) {
        throw new TypeError("Drive acknowledged an extent outside this write.");
      }
      return status;
    } catch (cause) {
      if (cause instanceof DriveError && cause.status >= 400 && cause.status < 500) throw cause;
      throw new DrivePublicationError(cause);
    }
  }
  /** Fixed-size transfer seam. Caller owns an immutable source and exclusive session use. */
  destination(upload: DriveUploadType): UploadDestinationType {
    const selected = this.#session(upload);
    const saved: DriveUploadType = {
      url: selected.url.href,
      size: selected.size,
      ...(selected.fileId === undefined ? {} : { fileId: selected.fileId }),
    };
    return {
      protocol: "drive-resumable",
      url: saved.url,
      status: async (options = {}) => ({ ...await this.queryUpload(saved, options.signal), size: saved.size }),
      write: async (offset, bytes, options = {}) =>
        (await this.writeUpload(saved, offset, bytes, options.signal)).offset,
    };
  }
}
