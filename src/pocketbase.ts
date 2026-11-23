/** PocketBase record-file operations with explicit API and protected-file authority. @module */
import { z } from "zod";
import { isBytes, toView } from "./bytes.ts";
import { close } from "./close.ts";
import { assertRangeResponse, range } from "./range.ts";
import { RequestMetrics, sendRequest } from "./request.ts";
import type { FetchType, RequestPolicyType } from "./request.ts";
import { readResponse } from "./response.ts";
import { collectBytes, openBytes, withAbortSignal } from "./stream.ts";

/** Implementation ceiling for one copied multipart upload or materialized download. */
export const POCKETBASE_BUFFER_BYTES = 64 * 1024 * 1024;
/** The caller selects a collection and file field; no schema or login is discovered. */
export interface PocketbaseOptionsType {
  readonly endpoint: string | URL;
  readonly collection: string;
  readonly field: string;
  /** Return the complete native Authorization header value. Never invoked for file downloads. */
  readonly credentials?: (url: URL, signal?: AbortSignal) => string | undefined | PromiseLike<string | undefined>;
  readonly fetch?: FetchType;
  readonly request?: RequestPolicyType;
  readonly allowHttp?: boolean;
  readonly maxBytes?: number;
}
/** File names are server-returned names, not the original local upload names. Data remains inert native record data. */
export interface PocketbaseRecordType {
  readonly id: string;
  readonly collectionId: string;
  readonly collectionName: string;
  readonly files: readonly string[];
  readonly data: Readonly<Record<string, unknown>>;
}
/** Native page evidence; pages are not a snapshot and totals can change. */
export interface PocketbasePageType {
  readonly page: number;
  readonly perPage: number;
  readonly totalItems: number;
  readonly totalPages: number;
  readonly items: readonly PocketbaseRecordType[];
}
/** Byte parts are copied before asynchronous credential acquisition. Original names can be sanitized by the server. */
export interface PocketbaseFileType {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
}
/** Small scalar record fields only; collection administration and relation expansion are separate APIs. */
export type PocketbaseDataType = Readonly<Record<string, string | number | boolean | null>>;
/** A file token is separate from an API Authorization token. No automatic token acquisition occurs. */
export interface PocketbaseReadOptionsType {
  readonly token?: string;
  readonly at?: number;
  readonly length?: number;
  readonly signal?: AbortSignal;
}
/** A caller-owned stream; consume to EOF or await cancellation. Size is only response extent evidence. */
export interface PocketbaseDownloadType {
  readonly bytes: ReadableStream<Uint8Array>;
  readonly size?: number;
  readonly evidence: "server-trusted";
}
/** Sanitized native HTTP status; server diagnostics and token URLs are not echoed. */
export class PocketbaseError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`PocketBase request failed: status ${status}.`);
    this.name = "PocketbaseError";
    this.status = status;
  }
}
/** A dispatched record mutation did not deliver a valid acknowledgement. Reconcile before retrying. */
export class PocketbasePublicationError extends Error {
  readonly outcome = "unknown";
  constructor(cause: unknown) {
    super("PocketBase mutation outcome is unknown; reconcile the record before retrying.", { cause });
    this.name = "PocketbasePublicationError";
  }
}
function integer(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new RangeError("Invalid PocketBase budget or extent.");
  }
  return value;
}
/** Literal components cannot become path separators or URL-normalized dot aliases. */
function component(value: string): string {
  if (
    typeof value !== "string" || !value || value.length > 1024 || !value.isWellFormed() ||
    value.includes("/") || value.includes("\\") || value === "." || value === ".."
  ) {
    throw new TypeError("Invalid PocketBase path component.");
  }
  for (const char of value) {
    if (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) {
      throw new TypeError("Invalid PocketBase path component.");
    }
  }
  return value;
}
function field(value: string): string {
  if (
    typeof value !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(value) ||
    ["__proto__", "constructor", "prototype", "id", "collectionId", "collectionName"].includes(value)
  ) throw new TypeError("Invalid PocketBase file field.");
  return value;
}
function secret(value: string): string {
  if (typeof value !== "string" || !value || value.length > 8192 || /[^\x21-\x7e]/.test(value)) {
    throw new TypeError("Invalid PocketBase token.");
  }
  return value;
}
/** API authorization is a complete header, including optional native Bearer spelling; file query tokens are separate. */
function authorization(value: string): string {
  if (typeof value !== "string" || !value || value.length > 8192 || /[^\x20-\x7e]/.test(value)) {
    throw new TypeError("Invalid PocketBase API authorization header.");
  }
  return value;
}
/** Refuse duplicate authority, prototype keys, deep inputs and imprecise numbers before JSON parsing. */
function json(text: string): unknown {
  let at = 0, tokens = 0;
  const fail = (): never => {
    throw new TypeError("Malformed or over-budget PocketBase JSON.");
  };
  const space = (): void => {
    while (/[ \t\r\n]/.test(text[at] ?? "x")) at++;
  };
  function string(): string {
    const start = at++;
    while (at < text.length) {
      if (at - start > 65536) fail();
      const char = text[at++];
      if (char === "\\") {
        at++;
        continue;
      }
      if (char === '"') {
        try {
          return JSON.parse(text.slice(start, at)) as string;
        } catch {
          return fail();
        }
      }
    }
    return fail();
  }
  function value(depth: number): void {
    if (++tokens > 100000 || depth > 32) fail();
    space();
    if (text[at] === '"') {
      string();
      return;
    }
    if (text[at] === "{" || text[at] === "[") {
      const object = text[at++] === "{", end = object ? "}" : "]", keys = new Set<string>();
      space();
      if (text[at] === end) {
        at++;
        return;
      }
      while (true) {
        if (object) {
          space();
          if (text[at] !== '"') fail();
          const key = string();
          if (keys.has(key) || ["__proto__", "constructor", "prototype"].includes(key)) fail();
          keys.add(key);
          space();
          if (text[at++] !== ":") fail();
        }
        value(depth + 1);
        space();
        const char = text[at++];
        if (char === end) return;
        if (char !== ",") fail();
      }
    }
    const start = at;
    while (at < text.length && !/[ \t\r\n,}\]]/.test(text[at]!)) {
      if (at - start >= 128) fail();
      at++;
    }
    const raw = text.slice(start, at);
    if (!["true", "false", "null"].includes(raw)) {
      if (
        !/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(raw) || !Number.isFinite(Number(raw)) ||
        Number.isInteger(Number(raw)) && !Number.isSafeInteger(Number(raw))
      ) fail();
    }
  }
  value(0);
  space();
  if (at !== text.length) fail();
  try {
    return JSON.parse(text);
  } catch {
    return fail();
  }
}
const RecordSchema = z.looseObject({ id: z.string(), collectionId: z.string(), collectionName: z.string() });
const PageSchema = z.object({
  page: z.number(),
  perPage: z.number(),
  totalItems: z.number(),
  totalPages: z.number(),
  items: z.array(z.unknown()).max(500),
});
/** Preserve native terminal read errors; cancel only independently detected local extent failures. */
function extent(
  body: ReadableStream<Uint8Array>,
  expected: number | undefined,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = openBytes(body);
  let seen = 0, empty = 0, terminal = false;
  return withAbortSignal(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          let next: ReadableStreamReadResult<Uint8Array>;
          try {
            next = await reader.read();
          } catch (reason) {
            terminal = true;
            throw reason;
          }
          if (next.done) {
            terminal = true;
            if (expected !== undefined && seen !== expected) {
              throw new TypeError("PocketBase file extent is truncated.");
            }
            reader.releaseLock();
            controller.close();
            return;
          }
          if (!isBytes(next.value)) throw new TypeError("PocketBase file stream requires bytes.");
          const bytes = toView(next.value);
          if (
            bytes.length > Number.MAX_SAFE_INTEGER - seen || expected !== undefined && bytes.length > expected - seen
          ) throw new TypeError("PocketBase file exceeds its declared extent.");
          seen += bytes.length;
          if (!bytes.length) { if (++empty > 16) throw new TypeError("PocketBase file makes no progress."); }
          else empty = 0;
          controller.enqueue(bytes);
        } catch (reason) {
          try {
            await close([...(terminal ? [] : [() => reader.cancel(reason)]), () => reader.releaseLock()], [reason]);
          } catch (failure) {
            controller.error(failure);
          }
          terminal = true;
        }
      },
      async cancel(reason) {
        if (terminal) return;
        terminal = true;
        await close([() => reader.cancel(reason), () => reader.releaseLock()]);
      },
    }, { highWaterMark: 0 }),
    signal,
    "PocketBase content",
    "download",
  );
}
/** Native collection-file service, not an arbitrary filesystem or a transactional record store. */
export class PocketbaseClient {
  readonly #base: URL;
  readonly #collection: string;
  readonly #field: string;
  readonly #credentials: PocketbaseOptionsType["credentials"];
  readonly #fetch: FetchType;
  readonly #request: RequestPolicyType | undefined;
  readonly #max: number;
  readonly #metrics = new RequestMetrics();
  constructor(options: PocketbaseOptionsType) {
    const endpoint = options.endpoint;
    if (typeof endpoint === "string" && endpoint.length > 8192) {
      throw new RangeError("PocketBase endpoint exceeds its budget.");
    }
    try {
      this.#base = new URL(endpoint);
    } catch {
      throw new TypeError("Invalid PocketBase endpoint.");
    }
    if (
      this.#base.protocol !== "https:" && !(options.allowHttp === true && this.#base.protocol === "http:") ||
      this.#base.username || this.#base.password || this.#base.hash || this.#base.search ||
      !this.#base.pathname.endsWith("/")
    ) throw new TypeError("Invalid PocketBase endpoint authority.");
    this.#collection = component(options.collection);
    this.#field = field(options.field);
    this.#credentials = options.credentials;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#request = options.request === undefined ? undefined : { ...options.request };
    this.#max = integer(options.maxBytes ?? 8 * 1024 * 1024, POCKETBASE_BUFFER_BYTES);
  }
  #url(path: string): URL {
    return new URL(`api/${path}`, this.#base);
  }
  #recordPath(id?: string): string {
    return `collections/${encodeURIComponent(this.#collection)}/records${
      id === undefined ? "" : "/" + encodeURIComponent(component(id))
    }`;
  }
  #record(value: unknown, id?: string): PocketbaseRecordType {
    const data = RecordSchema.parse(value), selected = data[this.#field];
    component(data.id);
    component(data.collectionId);
    component(data.collectionName);
    if (
      data.collectionId !== this.#collection && data.collectionName !== this.#collection ||
      id !== undefined && data.id !== id
    ) throw new TypeError("PocketBase record identity differs.");
    const files = selected === ""
      ? []
      : typeof selected === "string"
      ? [selected]
      : Array.isArray(selected)
      ? selected
      : undefined;
    if (
      files === undefined || files.length > 100 || files.some((name) => typeof name !== "string") ||
      new Set(files).size !== files.length
    ) throw new TypeError("PocketBase file field does not match the configured schema.");
    return {
      id: data.id,
      collectionId: data.collectionId,
      collectionName: data.collectionName,
      files: files.map((name) => component(name as string)),
      data,
    };
  }
  /** No redirect is followed; only record/token API requests acquire the ordinary authorization header. */
  async #send<Value>(
    target: URL,
    method: string,
    body: FormData | string | undefined,
    signal: AbortSignal | undefined,
    mutation: boolean,
    consume: (response: Response, text: () => PromiseLike<string>) => Value | PromiseLike<Value>,
  ): Promise<Value> {
    signal?.throwIfAborted();
    const token = await this.#credentials?.(new URL(target), signal);
    signal?.throwIfAborted();
    const headers = new Headers({ Accept: "application/json" });
    if (token !== undefined) headers.set("Authorization", authorization(token));
    if (typeof body === "string") headers.set("Content-Type", "application/json");
    let dispatched = false;
    try {
      const response = await sendRequest(
        async (signal) => ({
          input: target,
          init: {
            method,
            headers,
            redirect: "manual",
            credentials: "omit",
            referrerPolicy: "no-referrer",
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
          ...(this.#request === undefined ? {} : { policy: this.#request }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return await readResponse(response, async (text) => {
        if (response.status !== (method === "DELETE" ? 204 : 200)) throw new PocketbaseError(response.status);
        return await consume(response, text);
      });
    } catch (reason) {
      if (mutation && dispatched) throw new PocketbasePublicationError(reason);
      throw reason;
    }
  }
  /** Get one record's configured file field; no file token or media is acquired. */
  async getRecord(id: string, signal?: AbortSignal): Promise<PocketbaseRecordType> {
    const captured = component(id);
    return await this.#send(
      this.#url(this.#recordPath(captured)),
      "GET",
      undefined,
      signal,
      false,
      async (_response, text) => this.#record(json(await text()), captured),
    );
  }
  /** Fetch one finite native offset page. Sorting/filtering, full scans and snapshot consistency are not inferred. */
  async listPage(
    options: { readonly page?: number; readonly perPage?: number; readonly signal?: AbortSignal } = {},
  ): Promise<PocketbasePageType> {
    const page = integer(options.page ?? 1, 1_000_000),
      perPage = integer(options.perPage ?? 30, 500),
      signal = options.signal;
    if (!page || !perPage) throw new RangeError("PocketBase pages start at one.");
    const target = this.#url(this.#recordPath());
    target.searchParams.set("page", String(page));
    target.searchParams.set("perPage", String(perPage));
    target.searchParams.set("sort", "id");
    return await this.#send(target, "GET", undefined, signal, false, async (_response, text) => {
      const data = PageSchema.parse(json(await text()));
      if (data.page !== page || data.perPage !== perPage || data.items.length > perPage) {
        throw new TypeError("PocketBase page extent differs.");
      }
      integer(data.totalItems, Number.MAX_SAFE_INTEGER);
      integer(data.totalPages, Number.MAX_SAFE_INTEGER);
      const items = data.items.map((item) => this.#record(item));
      if (new Set(items.map((item) => item.id)).size !== items.length) {
        throw new TypeError("PocketBase page repeats a record.");
      }
      return { page, perPage, totalItems: data.totalItems, totalPages: data.totalPages, items };
    });
  }
  /** Build copied finite parts before any awaited authorization. FormData owns copied Blob bytes. */
  #form(files: readonly PocketbaseFileType[], data: PocketbaseDataType, append: boolean): FormData {
    if (!Array.isArray(files) || files.length > 100) {
      throw new RangeError("PocketBase upload part count exceeds its budget.");
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new TypeError("PocketBase scalar metadata requires an object.");
    }
    const copiedData: [string, string][] = [];
    let characters = 0, bytes = 0;
    for (const key in data) {
      if (!Object.hasOwn(data, key)) continue;
      if (copiedData.length >= 64) throw new RangeError("PocketBase scalar field count exceeds its budget.");
      const value = data[key];
      field(key);
      if (key === this.#field || key === "expand" || key === "created" || key === "updated") {
        throw new TypeError("PocketBase metadata conflicts with server/file fields.");
      }
      if (
        typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" && value !== null ||
        typeof value === "number" &&
          (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))
      ) throw new TypeError("PocketBase metadata requires finite scalar values.");
      const text = value === null ? "" : String(value);
      if (!text.isWellFormed()) throw new TypeError("PocketBase metadata requires well-formed Unicode.");
      if (text.length > 8192 || (characters += key.length + text.length) > 65536) {
        throw new RangeError("PocketBase metadata exceeds its budget.");
      }
      copiedData.push([key, text]);
    }
    const parts = files.map((file) => {
      const name = component(file.name), mediaType = file.mediaType ?? "application/octet-stream";
      if (typeof mediaType !== "string" || mediaType.length > 256 || !/^[\x20-\x7e]+$/.test(mediaType)) {
        throw new TypeError("Invalid PocketBase file media type.");
      }
      const supplied = file.bytes;
      if (!isBytes(supplied)) throw new TypeError("PocketBase file requires bytes.");
      const view = toView(supplied);
      bytes += view.length;
      integer(bytes, this.#max);
      return { name, blob: new Blob([new Uint8Array(view)], { type: mediaType }) };
    });
    const body = new FormData();
    for (const [key, value] of copiedData) body.append(key, value);
    for (const part of parts) body.append(this.#field + (append ? "+" : ""), part.blob, part.name);
    return body;
  }
  /** Create a record with copied file parts. The returned native names are metadata evidence, not stored-byte proof. */
  async createRecord(
    files: readonly PocketbaseFileType[],
    options: { readonly data?: PocketbaseDataType; readonly signal?: AbortSignal } = {},
  ): Promise<PocketbaseRecordType> {
    const signal = options.signal;
    signal?.throwIfAborted();
    const body = this.#form(files, options.data ?? {}, false);
    return await this.#send(
      this.#url(this.#recordPath()),
      "POST",
      body,
      signal,
      true,
      async (_response, text) => this.#record(json(await text())),
    );
  }
  /** Replace or append file-field entries. Append is not byte append and does not make a read-modify-write promise. */
  async uploadFiles(
    id: string,
    files: readonly PocketbaseFileType[],
    options: { readonly mode: "replace" | "append"; readonly data?: PocketbaseDataType; readonly signal?: AbortSignal },
  ): Promise<PocketbaseRecordType> {
    const captured = component(id), mode = options.mode, signal = options.signal;
    signal?.throwIfAborted();
    if (mode !== "replace" && mode !== "append" || !files.length) {
      throw new TypeError("PocketBase upload needs nonempty files and an explicit mode.");
    }
    const body = this.#form(files, options.data ?? {}, mode === "append");
    return await this.#send(
      this.#url(this.#recordPath(captured)),
      "PATCH",
      body,
      signal,
      true,
      async (_response, text) => this.#record(json(await text()), captured),
    );
  }
  /** Remove named entries through the file-field '-' modifier. This requires record update permission, not delete permission. */
  async deleteFiles(id: string, names: readonly string[], signal?: AbortSignal): Promise<PocketbaseRecordType> {
    const captured = component(id);
    if (!Array.isArray(names) || !names.length || names.length > 100) {
      throw new RangeError("Invalid PocketBase file deletion count.");
    }
    const copied = names.map(component);
    if (new Set(copied).size !== copied.length) throw new TypeError("PocketBase file deletion repeats names.");
    const body = JSON.stringify({ [this.#field + "-"]: copied });
    return await this.#send(
      this.#url(this.#recordPath(captured)),
      "PATCH",
      body,
      signal,
      true,
      async (_response, text) => this.#record(json(await text()), captured),
    );
  }
  /** Delete the entire native record and its associated files. This is never a file-only removal fallback. */
  async deleteRecord(id: string, signal?: AbortSignal): Promise<void> {
    const target = this.#url(this.#recordPath(component(id)));
    await this.#send(target, "DELETE", undefined, signal, true, () => {});
  }
  /** Return an explicit secret file token. It is not cached, automatically refreshed or used as ordinary API authority. */
  async fileToken(signal?: AbortSignal): Promise<string> {
    return await this.#send(
      this.#url("files/token"),
      "POST",
      undefined,
      signal,
      false,
      async (_response, text) => secret(z.object({ token: z.string() }).parse(json(await text())).token),
    );
  }
  /** Original file bytes only. Ordinary API credentials are never acquired or forwarded, including same-origin files. */
  async download(id: string, name: string, options: PocketbaseReadOptionsType = {}): Promise<PocketbaseDownloadType> {
    const suppliedToken = options.token;
    const capturedId = component(id),
      capturedName = component(name),
      token = suppliedToken === undefined ? undefined : secret(suppliedToken),
      selected = range(options);
    if (selected.empty) {
      return {
        bytes: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        size: 0,
        evidence: "server-trusted",
      };
    }
    const target = this.#url(
      `files/${encodeURIComponent(this.#collection)}/${encodeURIComponent(capturedId)}/${
        encodeURIComponent(capturedName)
      }`,
    );
    if (token !== undefined) target.searchParams.set("token", token);
    const headers = new Headers({ "Accept-Encoding": "identity" });
    if (selected.header !== undefined) headers.set("Range", selected.header);
    const response = await sendRequest(
      async (signal) => ({
        input: target,
        init: {
          method: "GET",
          headers,
          redirect: "manual",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          ...(signal === undefined ? {} : { signal }),
        },
      }),
      {
        fetch: this.#fetch,
        replayable: false,
        metrics: this.#metrics,
        ...(this.#request === undefined ? {} : { policy: this.#request }),
        ...(selected.signal === undefined ? {} : { signal: selected.signal }),
      },
    );
    try {
      if (response.status !== 200 && response.status !== 206) throw new PocketbaseError(response.status);
      // The range owner retires rejected bodies itself, so do not cancel twice.
    } catch (reason) {
      await close(response.body === null ? [] : [() => response.body!.cancel(reason)], [reason]);
      throw reason;
    }
    await assertRangeResponse(response, selected);
    try {
      const raw = response.headers.get("content-length"), contentRange = response.headers.get("content-range");
      let size: number | undefined;
      if (raw !== null) {
        if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new TypeError("Invalid PocketBase file length.");
        size = integer(Number(raw), Number.MAX_SAFE_INTEGER);
      }
      if (selected.header !== undefined) {
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange!);
        size = Number(match![2]) - Number(match![1]) + 1;
      }
      if (response.body === null) throw new TypeError("PocketBase file response lacks a readable body.");
      return {
        bytes: extent(response.body, size, selected.signal),
        ...(size === undefined ? {} : { size }),
        evidence: "server-trusted",
      };
    } catch (reason) {
      await close(response.body === null || response.body.locked ? [] : [() => response.body!.cancel(reason)], [
        reason,
      ]);
      throw reason;
    }
  }
  /** Materialize a bounded original/selected extent. This does not provide immutable identity or a content digest. */
  async read(id: string, name: string, options: PocketbaseReadOptionsType = {}): Promise<Uint8Array<ArrayBuffer>> {
    const token = options.token, at = options.at, length = options.length, signal = options.signal;
    const captured: PocketbaseReadOptionsType = {
      ...(token === undefined ? {} : { token }),
      ...(at === undefined ? {} : { at }),
      ...(length === undefined ? {} : { length }),
      ...(signal === undefined ? {} : { signal }),
    };
    const response = await this.download(id, name, captured);
    if (response.size !== undefined && response.size > this.#max) {
      const reason = new RangeError("PocketBase materialized read exceeds its byte budget.");
      await close([() => response.bytes.cancel(reason)], [reason]);
    }
    return new Uint8Array(await collectBytes(response.bytes, this.#max, captured.signal, "PocketBase", "file"));
  }
}
