/** Box native IDs, versioned downloads and part-based upload sessions. @module */
import { digest, endpoint, fields, file, id, item, origins, PartSchema, retry, sha1, target, text } from "./parse.ts";
import { BoxError, BoxPendingError, BoxPublicationError } from "./error.ts";
import type {
  BoxCommitType,
  BoxDownloadType,
  BoxFileType,
  BoxItemType,
  BoxOptionsType,
  BoxPageType,
  BoxPartsPageType,
  BoxPartType,
  BoxReadOptionsType,
  BoxTargetType,
  BoxUploadStatusType,
  BoxUploadType,
  BoxVersionType,
} from "./types.ts";
import { toInteger } from "../../check.ts";
import { exactLength } from "../../body.ts";
import { z } from "zod";
import { isBytes, toRequestBytes, toView } from "../../bytes.ts";
import { close } from "../../close.ts";
import { assertRangeResponse, resolveRange } from "../../range.ts";
import { RequestMetrics, sendRequest } from "../../request.ts";
import type { FetchType, RequestPolicyType } from "../../request.ts";
import { readResponse } from "../../response.ts";
import { collectBytes } from "../../stream/mod.ts";

/** Local finite-buffer ceiling, not an account's provider upload allowance. */
export const BOX_BUFFER_BYTES = 64 * 1024 * 1024;

/** Native stateless client. Import and construction perform no network or account discovery. */
export class BoxClient {
  readonly #api: URL;
  readonly #upload: URL;
  readonly #uploadOrigins: ReadonlySet<string>;
  readonly #downloads: ReadonlySet<string>;
  readonly #http: boolean;
  readonly #token: BoxOptionsType["token"];
  readonly #fetch: FetchType;
  readonly #policy: RequestPolicyType | undefined;
  readonly #context: Headers;
  readonly #bytes: number;
  readonly #pages: number;
  readonly #entries: number;
  readonly #parts: number;
  readonly #metrics = new RequestMetrics();
  /**
   * Creates the client from `options`.
   * @param options Options that configure the client.
   */
  constructor(options: BoxOptionsType) {
    this.#http = options.allowHttp === true;
    this.#api = endpoint(options.endpoint ?? "https://api.box.com/2.0/", this.#http);
    this.#upload = endpoint(options.uploadEndpoint ?? "https://upload.box.com/api/2.0/", this.#http);
    this.#uploadOrigins = origins([this.#upload.origin, ...options.uploadOrigins ?? []], this.#http);
    this.#downloads = origins(options.downloadOrigins ?? [], this.#http);
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#policy = options.request === undefined ? undefined : { ...options.request };
    this.#bytes = toInteger(options.maxBytes ?? 8 * 1024 * 1024, "Box byte budget", BOX_BUFFER_BYTES);
    this.#pages = toInteger(options.maxPages ?? 1000, "Box page budget", 100000);
    this.#entries = toInteger(options.maxEntries ?? 100000, "Box entry budget", 1000000);
    this.#parts = toInteger(options.maxParts ?? 10000, "Box part budget", 10000);
    this.#context = new Headers();
    if (options.asUser !== undefined) this.#context.set("As-User", id(options.asUser));
  }
  /** A request-local mutation receipt tracks actual transport dispatch, never shared mutable client state. */
  async #send(
    url: URL,
    method: string,
    headers: Headers,
    body: BodyInit | undefined,
    signal?: AbortSignal,
    mutation = false,
    authenticate = true,
  ): Promise<Response> {
    signal?.throwIfAborted();
    if (authenticate) {
      const token = await this.#token(new URL(url), signal);
      signal?.throwIfAborted();
      headers.set("Authorization", `Bearer ${text(token, "bearer token", 32768)}`);
      for (const [key, value] of this.#context) headers.set(key, value);
    }
    let dispatched = false;
    try {
      return await sendRequest(
        async (signal) => ({
          input: url,
          init: {
            method,
            headers,
            redirect: "manual",
            ...(body === undefined ? {} : { body }),
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
          ...(this.#policy === undefined ? {} : { policy: this.#policy }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
    } catch (reason) {
      if (mutation && dispatched) throw new BoxPublicationError(reason);
      throw reason;
    }
  }
  /** Response validation happens before cleanup; cleanup cannot erase a valid publication receipt. */
  async #json<Value>(
    response: Response,
    status: number,
    parse: (value: unknown) => Value,
    mutation = false,
  ): Promise<Value> {
    return await readResponse(response, async (text) => {
      if (response.status !== status) {
        const failure = new BoxError(response.status);
        if (mutation && (response.ok || response.status >= 500 || response.status >= 300 && response.status < 400)) {
          throw new BoxPublicationError(failure);
        }
        throw failure;
      }
      try {
        return parse(JSON.parse(await text()));
      } catch (reason) {
        if (mutation) throw new BoxPublicationError(reason);
        throw reason;
      }
    });
  }
  #url(route: string): URL {
    const url = new URL(route, this.#api);
    url.searchParams.set("fields", fields);
    return url;
  }
  /** Get one file by ID, with the explicit current version required for a pinned read. */
  async statFile(fileId: string, signal?: AbortSignal): Promise<BoxFileType> {
    const selected = id(fileId);
    return await this.#json(
      await this.#send(this.#url(`files/${selected}`), "GET", new Headers(), undefined, signal),
      200,
      (value) => file(value, selected),
    );
  }
  /** A retained version has its own ID and size, selected through the requested file route. */
  async statVersion(fileId: string, versionId: string, signal?: AbortSignal): Promise<BoxVersionType> {
    const selected = id(versionId);
    const url = new URL(`files/${id(fileId)}/versions/${selected}`, this.#api);
    url.searchParams.set("fields", "id,type,size,sha1");
    return await this.#json(
      await this.#send(url, "GET", new Headers(), undefined, signal),
      200,
      (value) => {
        const data = z.object({
          id: z.string(),
          type: z.literal("file_version"),
          size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          sha1: z.string().optional(),
        }).parse(value);
        if (data.id !== selected) throw new TypeError("Box returned another version.");
        return { id: selected, size: data.size, ...(data.sha1 === undefined ? {} : { sha1: sha1(data.sha1) }) };
      },
    );
  }
  /** Direct native children, marker pagination only. No folder snapshot or name uniqueness claim. */
  async listPage(
    folderId: string,
    options: { readonly marker?: string; readonly signal?: AbortSignal } = {},
  ): Promise<BoxPageType> {
    const url = this.#url(`folders/${id(folderId)}/items`);
    url.searchParams.set("usemarker", "true");
    url.searchParams.set("limit", "1000");
    if (options.marker !== undefined) url.searchParams.set("marker", text(options.marker, "marker", 8192));
    return await this.#json(await this.#send(url, "GET", new Headers(), undefined, options.signal), 200, (value) => {
      const data = z.object({
        entries: z.array(z.unknown()).max(Math.min(this.#entries, 1000)),
        next_marker: z.string().max(8192).nullable().optional(),
      }).parse(value);
      return {
        entries: data.entries.map(item),
        ...(data.next_marker ? { nextMarker: text(data.next_marker, "marker", 8192) } : {}),
      };
    });
  }
  /** Bound all pages and preserve provider order. Early return performs no background requests. */
  async *list(folderId: string, signal?: AbortSignal): AsyncIterableIterator<BoxItemType> {
    const selected = id(folderId), seen = new Set<string>();
    let marker: string | undefined, count = 0;
    for (let page = 0; page < this.#pages; page++) {
      const result = await this.listPage(selected, {
        ...(marker === undefined ? {} : { marker }),
        ...(signal === undefined ? {} : { signal }),
      });
      count += result.entries.length;
      if (count > this.#entries) throw new RangeError("Box listing exceeds its entry budget.");
      for (const entry of result.entries) {
        signal?.throwIfAborted();
        yield entry;
      }
      if (result.nextMarker === undefined) return;
      if (seen.has(result.nextMarker)) throw new TypeError("Box listing repeated a marker.");
      seen.add(result.nextMarker);
      marker = result.nextMarker;
    }
    throw new RangeError("Box listing exceeds its page budget.");
  }
  /** Reject every capability outside caller-granted origins; signed query contents remain opaque secrets. */
  #capability(value: string, seen: ReadonlySet<string>): URL {
    if (value.length > 16384) throw new TypeError("Box download capability exceeds its URL budget.");
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new TypeError("Invalid Box download capability.");
    }
    if (
      (url.protocol !== "https:" && !(this.#http && url.protocol === "http:")) || url.username || url.password ||
      url.hash || !this.#downloads.has(url.origin) || seen.has(url.href) || url.href.length > 16384
    ) throw new TypeError("Box download capability is outside its admitted authority or repeats.");
    return url;
  }
  /** Pin native version selection, then transfer server-trusted exact bytes. No range checksum claim. */
  async download(fileId: string, options: BoxReadOptionsType = {}): Promise<BoxDownloadType> {
    const selected = id(fileId),
      selectedRange = resolveRange(options),
      selectedVersion = options.versionId === undefined ? undefined : id(options.versionId);
    if (selectedRange.empty) throw new RangeError("Box download requires a nonempty extent.");
    const signal = selectedRange.signal;
    let version: BoxVersionType;
    if (selectedVersion !== undefined) version = await this.statVersion(selected, selectedVersion, signal);
    else {
      const data = await this.statFile(selected, signal);
      version = { id: data.versionId, size: data.size, ...(data.sha1 === undefined ? {} : { sha1: data.sha1 }) };
    }
    let url = new URL(`files/${selected}/content`, this.#api);
    url.searchParams.set("version", version.id);
    let authenticate = true;
    const seen = new Set<string>();
    for (let hop = 0; hop <= 3; hop++) {
      const headers = new Headers({ "Accept-Encoding": "identity" });
      if (selectedRange.header !== undefined) headers.set("Range", selectedRange.header);
      const response = await this.#send(url, "GET", headers, undefined, signal, false, authenticate);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        url = await readResponse(response, () => {
          if (hop === 3) throw new TypeError("Box download exceeded its redirect budget.");
          const location = response.headers.get("location");
          if (location === null) throw new TypeError("Box download redirect requires Location.");
          return this.#capability(location, seen);
        });
        seen.add(url.href);
        authenticate = false;
        continue;
      }
      if (
        response.status === 202 ||
        response.headers.has("retry-after") && response.status !== 200 && response.status !== 206
      ) {
        await readResponse(response, () => {
          throw new BoxPendingError(retry(response));
        });
      }
      if (!response.ok) {
        return await this.#json(response, 200, () => {
          throw new TypeError("Invalid Box download.");
        });
      }
      await assertRangeResponse(response, selectedRange);
      try {
        let length = version.size;
        if (selectedRange.header !== undefined) {
          if (Number(response.headers.get("content-range")!.split("/")[1]) !== version.size) {
            throw new TypeError("Box range total differs from selected version size.");
          }
          length = Math.min(selectedRange.end ?? version.size - 1, version.size - 1) - selectedRange.start + 1;
        }
        const declared = response.headers.get("content-length");
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== length)) {
          throw new TypeError("Box declared length differs from selected version size.");
        }
        if (response.body === null && length !== 0) throw new TypeError("Box download is missing its body.");
        return {
          fileId: selected,
          version,
          bytes: exactLength(
            response.body ?? new ReadableStream({
              start(controller) {
                controller.close();
              },
            }),
            length,
            { label: "Box body", resource: "Box content", signal: signal },
          ),
        };
      } catch (reason) {
        await close(response.body === null ? [] : [() => response.body!.cancel(reason)], [reason]);
        throw reason;
      }
    }
    throw new TypeError("Box download redirect budget exhausted.");
  }
  /** Finite read checks metadata admission before buffering. Zero length is local without existence evidence. */
  async read(fileId: string, options: BoxReadOptionsType = {}): Promise<Uint8Array> {
    const selected = resolveRange(options);
    if (selected.empty) return new Uint8Array();
    const captured = {
      ...(options.versionId === undefined ? {} : { versionId: id(options.versionId) }),
      ...(options.at === undefined ? {} : { at: selected.start }),
      ...(options.length === undefined ? {} : { length: options.length }),
      ...(selected.signal === undefined ? {} : { signal: selected.signal }),
    };
    const data = await this.download(fileId, captured);
    const length = selected.header === undefined
      ? data.version.size
      : Math.max(0, Math.min(selected.end ?? data.version.size - 1, data.version.size - 1) - selected.start + 1);
    if (length > this.#bytes) {
      const reason = new RangeError("Box read exceeds its byte budget.");
      await close([() => data.bytes.cancel(reason)], [reason]);
    }
    return await collectBytes(data.bytes, this.#bytes, selected.signal, "read", "Box content");
  }
  /** Native slots prevent byteLength/property shadowing from bypassing admission. */
  #owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    if (!isBytes(bytes)) throw new TypeError("Box upload requires Uint8Array bytes.");
    const view = toView(bytes);
    if (view.length > this.#bytes) throw new RangeError("Box upload exceeds its byte budget.");
    return new Uint8Array(view);
  }
  /** Exactly one complete File receipt is required before reporting publication. */
  #receipt(value: unknown, selected: BoxTargetType, size: number, expected?: string): BoxFileType {
    const data = z.object({ total_count: z.literal(1), entries: z.array(z.unknown()).length(1) }).parse(value);
    const stored = file(data.entries[0], selected.kind === "replace" ? selected.fileId : undefined);
    if (
      stored.size !== size || expected !== undefined && stored.sha1 !== expected ||
      selected.kind === "create" && stored.parentId !== undefined && stored.parentId !== selected.folderId
    ) throw new TypeError("Box publication receipt differs from the requested file.");
    return stored;
  }
  /** Bounded multipart upload; FormData owns copied bytes before OAuth awaits. */
  async upload(
    selectedTarget: BoxTargetType,
    bytes: Uint8Array,
    options: { readonly sha1?: string; readonly name?: string; readonly signal?: AbortSignal } = {},
  ): Promise<BoxFileType> {
    const selected = target(selectedTarget),
      owned = this.#owned(bytes),
      expected = options.sha1 === undefined ? undefined : sha1(options.sha1),
      signal = options.signal;
    // The pinned OpenAPI calls name optional in prose but requires it in the
    // multipart schema. This profile requires an explicit replacement name.
    const name = selected.kind === "create" ? selected.name : text(options.name!, "replacement file name", 255);
    if (name === "." || name === ".." || /[\\/]/u.test(name)) throw new TypeError("Invalid Box file name.");
    const body = new FormData();
    body.append(
      "attributes",
      JSON.stringify(selected.kind === "create" ? { name, parent: { id: selected.folderId } } : { name }),
    );
    body.append("file", new Blob([owned]), name);
    const headers = new Headers();
    if (expected !== undefined) headers.set("Content-MD5", expected);
    if (selected.kind === "replace" && selected.ifMatch !== undefined) headers.set("If-Match", selected.ifMatch);
    const url = new URL(
      selected.kind === "create" ? "files/content" : `files/${selected.fileId}/content`,
      this.#upload,
    );
    url.searchParams.set("fields", fields);
    return await this.#json(
      await this.#send(url, "POST", headers, body, signal, true),
      selected.kind === "create" ? 201 : 200,
      (value) => this.#receipt(value, selected, owned.length, expected),
      true,
    );
  }
  /** Session paths bind every advertised endpoint to its ID and configured upload path. */
  #sessionUrl(value: string, sessionId: string, suffix = ""): URL {
    if (typeof value !== "string" || value.length > 16384) {
      throw new TypeError("Box session endpoint exceeds its URL budget.");
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new TypeError("Invalid Box session endpoint.");
    }
    const expected = new URL(`files/upload_sessions/${sessionId}${suffix}`, this.#upload).pathname;
    if (
      (url.protocol !== "https:" && !(this.#http && url.protocol === "http:")) ||
      !this.#uploadOrigins.has(url.origin) || url.username || url.password || url.search || url.hash ||
      url.pathname !== expected
    ) throw new TypeError("Box session endpoint differs from its admitted authority, path or ID.");
    return url;
  }
  /** Captures a resumed session before any I/O; caller still owns source identity/exclusive use. */
  #capture(upload: BoxUploadType): BoxUploadType {
    const sessionId = text(upload.id, "session ID", 256);
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new TypeError("Invalid Box session ID.");
    const size = toInteger(upload.size, "Box session file size"),
      partSize = toInteger(upload.partSize, "Box part size", this.#bytes),
      totalParts = toInteger(upload.totalParts, "Box total parts", this.#parts);
    if (size === 0 || partSize === 0 || totalParts !== Math.ceil(size / partSize)) {
      throw new TypeError("Box session has inconsistent fixed extents.");
    }
    return {
      id: sessionId,
      size,
      partSize,
      totalParts,
      expires: text(upload.expires, "session expiry", 128),
      target: target(upload.target),
      endpoint: this.#sessionUrl(upload.endpoint, sessionId).href,
    };
  }
  /** Server-selected part size and every endpoint are validated before follow-up OAuth grants. */
  #session(value: unknown, selected: BoxTargetType, size: number, expectedId?: string): BoxUploadStatusType {
    const data = z.object({
      id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
      type: z.literal("upload_session"),
      session_expires_at: z.string().max(128),
      part_size: z.number(),
      total_parts: z.number(),
      num_parts_processed: z.number(),
      session_endpoints: z.object({
        upload_part: z.string().max(16384),
        status: z.string().max(16384),
        abort: z.string().max(16384),
        commit: z.string().max(16384),
        list_parts: z.string().max(16384),
      }),
    }).parse(value);
    if (expectedId !== undefined && data.id !== expectedId) throw new TypeError("Box returned another upload session.");
    const authority = this.#sessionUrl(data.session_endpoints.upload_part, data.id).origin;
    for (
      const [key, suffix] of [["upload_part", ""], ["status", ""], ["abort", ""], ["commit", "/commit"], [
        "list_parts",
        "/parts",
      ]] as const
    ) {
      if (this.#sessionUrl(data.session_endpoints[key], data.id, suffix).origin !== authority) {
        throw new TypeError("Box session endpoints must share one explicitly admitted authority in this profile.");
      }
    }
    const upload = this.#capture({
      id: data.id,
      size,
      partSize: data.part_size,
      totalParts: data.total_parts,
      expires: data.session_expires_at,
      target: selected,
      endpoint: data.session_endpoints.upload_part,
    });
    return {
      upload,
      processedParts: toInteger(data.num_parts_processed, "Box processed part count", upload.totalParts),
    };
  }
  /** Native create/replace sessions; account size permissions and minimum-size enforcement remain provider-owned. */
  async startUpload(selectedTarget: BoxTargetType, size: number, signal?: AbortSignal): Promise<BoxUploadType> {
    const selected = target(selectedTarget), amount = toInteger(size, "Box file size");
    if (amount === 0) {
      throw new RangeError("Box chunked sessions require a nonempty file; use multipart for empty files.");
    }
    const url = new URL(
      selected.kind === "create" ? "files/upload_sessions" : `files/${selected.fileId}/upload_sessions`,
      this.#upload,
    );
    const body = JSON.stringify(
      selected.kind === "create"
        ? { folder_id: selected.folderId, file_name: selected.name, file_size: amount }
        : { file_size: amount },
    );
    return await this.#json(
      await this.#send(url, "POST", new Headers({ "Content-Type": "application/json" }), body, signal, true),
      201,
      (value) => this.#session(value, selected, amount).upload,
      true,
    );
  }
  /** A processed count is not an acknowledged prefix. Inspect individual parts to recover gaps. */
  async statusUpload(upload: BoxUploadType, signal?: AbortSignal): Promise<BoxUploadStatusType> {
    const captured = this.#capture(upload);
    return await this.#json(
      await this.#send(new URL(captured.endpoint), "GET", new Headers(), undefined, signal),
      200,
      (value) => {
        const data = this.#session(value, captured.target, captured.size, captured.id);
        if (
          data.upload.partSize !== captured.partSize || data.upload.totalParts !== captured.totalParts ||
          data.upload.endpoint !== captured.endpoint
        ) throw new TypeError("Box upload session changed its fixed layout.");
        return data;
      },
    );
  }
  #part(value: unknown, upload: BoxUploadType): BoxPartType {
    const data = PartSchema.parse(value);
    if (
      data.offset % upload.partSize !== 0 || data.offset >= upload.size ||
      data.size !== Math.min(upload.partSize, upload.size - data.offset)
    ) throw new TypeError("Box part differs from its fixed source extent.");
    return { id: data.part_id, offset: data.offset, size: data.size, sha1: sha1(data.sha1) };
  }
  /** One native offset page of processed parts. This SHA-1 profile rejects foreign hash-only part receipts. */
  async partsPage(
    upload: BoxUploadType,
    options: { readonly offset?: number; readonly signal?: AbortSignal } = {},
  ): Promise<BoxPartsPageType> {
    const captured = this.#capture(upload),
      offset = toInteger(options.offset ?? 0, "Box part page offset", 10000),
      signal = options.signal;
    const url = new URL(`${captured.endpoint}/parts`);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("limit", "1000");
    return await this.#json(await this.#send(url, "GET", new Headers(), undefined, signal), 200, (value) => {
      const data = z.object({
        entries: z.array(z.unknown()).max(1000),
        offset: z.number(),
        limit: z.number(),
        total_count: z.number(),
      }).parse(value);
      const total = toInteger(data.total_count, "Box part collection bound", this.#parts),
        limit = toInteger(data.limit, "Box part page limit", 1000);
      if (
        data.offset !== offset || limit === 0 || data.entries.length > limit || total < offset + data.entries.length
      ) throw new TypeError("Box part page has inconsistent positions.");
      const parts = data.entries.map((value) => this.#part(value, captured));
      this.#validateParts(parts, captured, false);
      return { parts, offset, limit, total };
    });
  }
  /** Bounded complete traversal advances by returned limit, not sparse entry count. */
  async listParts(upload: BoxUploadType, signal?: AbortSignal): Promise<readonly BoxPartType[]> {
    const captured = this.#capture(upload), parts: BoxPartType[] = [];
    let offset = 0, total: number | undefined;
    for (let page = 0; page < this.#pages; page++) {
      const result = await this.partsPage(captured, { offset, ...(signal === undefined ? {} : { signal }) });
      if (total !== undefined && result.total !== total) {
        throw new TypeError("Box part collection changed during traversal.");
      }
      total = result.total;
      parts.push(...result.parts);
      this.#validateParts(parts, captured, false);
      offset += result.limit;
      if (offset >= total) return parts;
    }
    throw new RangeError("Box parts exceed the page budget.");
  }
  /** Hash and snapshot one bounded part before upload. SHA-1 remains native error detection only. */
  async uploadPart(
    upload: BoxUploadType,
    at: number,
    bytes: Uint8Array,
    options: { readonly subtle: Pick<SubtleCrypto, "digest">; readonly signal?: AbortSignal },
  ): Promise<BoxPartType> {
    const captured = this.#capture(upload),
      offset = toInteger(at, "Box part offset"),
      owned = this.#owned(bytes),
      subtle = options.subtle,
      signal = options.signal;
    if (
      offset % captured.partSize !== 0 || offset >= captured.size ||
      owned.length !== Math.min(captured.partSize, captured.size - offset)
    ) throw new TypeError("Box part does not match its required alignment/length.");
    signal?.throwIfAborted();
    const hashBytes = new Uint8Array(await subtle.digest("SHA-1", owned));
    signal?.throwIfAborted();
    if (hashBytes.length !== 20) throw new TypeError("SHA-1 capability returned an invalid digest length.");
    const expected = Array.from(hashBytes, (value) => value.toString(16).padStart(2, "0")).join("");
    const headers = new Headers({
      "Content-Type": "application/octet-stream",
      Digest: digest(expected),
      "Content-Range": `bytes ${offset}-${offset + owned.length - 1}/${captured.size}`,
    });
    return await this.#json(
      await this.#send(new URL(captured.endpoint), "PUT", headers, toRequestBytes(owned), signal, true),
      200,
      (value) => {
        const wire = z.object({ part: z.unknown() }).parse(value), data = this.#part(wire.part, captured);
        if (data.offset !== offset || data.size !== owned.length || data.sha1 !== expected) {
          throw new TypeError(
            "Box part receipt differs from the uploaded bytes.",
          );
        }
        return data;
      },
      true,
    );
  }
  /** One identity per nonoverlapping extent; complete commits require a gap-free source cover. */
  #validateParts(parts: readonly BoxPartType[], upload: BoxUploadType, complete: boolean): readonly BoxPartType[] {
    if (parts.length > this.#parts || parts.length > upload.totalParts) {
      throw new RangeError("Box parts exceed their budget.");
    }
    const ids = new Set<string>();
    const sorted = parts.map((part) =>
      this.#part({ part_id: part.id, offset: part.offset, size: part.size, sha1: part.sha1 }, upload)
    ).sort((a, b) => a.offset - b.offset);
    let end = 0;
    for (const part of sorted) {
      if (ids.has(part.id) || part.offset < end || complete && part.offset !== end) {
        throw new TypeError("Box parts overlap, repeat or leave a commit gap.");
      }
      ids.add(part.id);
      end = part.offset + part.size;
    }
    if (complete && (sorted.length !== upload.totalParts || end !== upload.size)) {
      throw new TypeError("Box commit requires a complete source cover.");
    }
    return sorted;
  }
  /** One explicit commit attempt. 202 advises a later caller-owned attempt; only 201 is a file receipt. */
  async commitUpload(
    upload: BoxUploadType,
    parts: readonly BoxPartType[],
    options: { readonly sha1: string; readonly signal?: AbortSignal },
  ): Promise<BoxCommitType> {
    const captured = this.#capture(upload), expected = sha1(options.sha1), signal = options.signal;
    const sorted = this.#validateParts(parts, captured, true);
    const body = JSON.stringify({
      parts: sorted.map((part) => ({ part_id: part.id, offset: part.offset, size: part.size, sha1: part.sha1 })),
    });
    if (body.length > 8 * 1024 * 1024) throw new RangeError("Box commit body exceeds its control budget.");
    const headers = new Headers({ "Content-Type": "application/json", Digest: digest(expected) });
    if (captured.target.kind === "replace" && captured.target.ifMatch !== undefined) {
      headers.set("If-Match", captured.target.ifMatch);
    }
    const response = await this.#send(new URL(`${captured.endpoint}/commit`), "POST", headers, body, signal, true);
    if (response.status === 202) {
      return await readResponse(response, () => {
        try {
          return { complete: false as const, retryAfterSeconds: retry(response) };
        } catch (reason) {
          throw new BoxPublicationError(reason);
        }
      });
    }
    return await this.#json(
      response,
      201,
      (value) => ({ complete: true, file: this.#receipt(value, captured.target, captured.size, expected) }),
      true,
    );
  }
  /** Explicit session cancellation does not delete a published file or reconcile an ambiguous commit. */
  async abortUpload(upload: BoxUploadType, signal?: AbortSignal): Promise<void> {
    const captured = this.#capture(upload);
    const response = await this.#send(new URL(captured.endpoint), "DELETE", new Headers(), undefined, signal, true);
    await readResponse(response, () => {
      if (response.status !== 204) {
        const failure = new BoxError(response.status);
        if (response.ok || response.status >= 500 || response.status >= 300 && response.status < 400) {
          throw new BoxPublicationError(failure);
        }
        throw failure;
      }
    });
  }
}

export type {
  BoxCommitType,
  BoxDownloadType,
  BoxFileType,
  BoxItemType,
  BoxOptionsType,
  BoxPageType,
  BoxPartsPageType,
  BoxPartType,
  BoxReadOptionsType,
  BoxTargetType,
  BoxUploadStatusType,
  BoxUploadType,
  BoxVersionType,
} from "./types.ts";

export { BoxError, BoxPendingError, BoxPublicationError } from "./error.ts";
