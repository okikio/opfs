import { z } from "zod";
import { isBytes, toRequestBytes, toView } from "./bytes.ts";
import type { FetchType } from "./request.ts";
import { readResponse, readText } from "./response.ts";
import type {
  ObjectBackendType,
  ObjectGetOptionsType,
  ObjectListOptionsType,
  ObjectPutOptionsType,
  ObjectStatType,
} from "./driver/object.ts";

/** Implementation buffering ceiling, independent of B2's larger provider upload limit. */
export const B2_UPLOAD_BYTES: number = 64 * 1024 * 1024;
/** A validated upload version; fileId is an immutable identity, not an ETag. */
export const B2FileSchema: z.ZodObject<{
  fileId: z.ZodString;
  fileName: z.ZodString;
  bucketId: z.ZodString;
  action: z.ZodLiteral<"upload">;
  contentLength: z.ZodNumber;
  contentSha1: z.ZodString;
  contentType: z.ZodString;
  uploadTimestamp: z.ZodNumber;
  fileInfo: z.ZodRecord<z.ZodString, z.ZodString>;
}> = z.object({
  fileId: z.string().min(1),
  fileName: z.string().min(1),
  bucketId: z.string().min(1),
  action: z.literal("upload"),
  contentLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  contentSha1: z.string(),
  contentType: z.string(),
  uploadTimestamp: z.number().int().nonnegative(),
  fileInfo: z.record(z.string(), z.string()),
});
/** Metadata received from the B2 native protocol. */
export type B2FileType = z.infer<typeof B2FileSchema>;
/** Explicit account token and the endpoints to which that token may be sent. */
export const B2AuthorizationSchema: z.ZodObject<{
  accountId: z.ZodString;
  authorizationToken: z.ZodString;
  apiUrl: z.ZodString;
  downloadUrl: z.ZodString;
}, z.core.$strict> = z.object({
  accountId: z.string().min(1),
  authorizationToken: z.string().min(1),
  apiUrl: z.string().url(),
  downloadUrl: z.string().url(),
}).strict();
/** Secrets must be stored and rotated by the caller. */
export type B2AuthorizationType = z.infer<typeof B2AuthorizationSchema>;
/** B2 service rejection. No request is automatically retried, including uploads. */
export class B2Error extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`B2 request failed: HTTP ${status} (${code}).`);
    this.name = "B2Error";
    this.status = status;
    this.code = code;
  }
}
/** A write was sent but no attributable valid success receipt was received. Inspect versions before retrying. */
export class B2PublicationError extends Error {
  readonly outcome = "unknown";
  constructor(cause: unknown) {
    super("B2 publication outcome is unknown; do not blindly repeat the write.", { cause });
    this.name = "B2PublicationError";
  }
}
/** Explicit client inputs. Fetch and SHA1 capability are borrowed; construction does not connect. */
export interface B2ClientOptionsType {
  readonly authorization: B2AuthorizationType;
  readonly bucketId: string;
  readonly fetch: FetchType;
  readonly subtle: SubtleCrypto;
  readonly maxUploadBytes?: number;
}
/** Native operations remain available independently of the object/filesystem projection. */
export interface B2ClientType extends ObjectBackendType {
  readonly maxUploadBytes: number;
  getFileInfo(fileId: string, options?: { readonly signal?: AbortSignal }): Promise<B2FileType>;
  download(file: B2FileType, options?: ObjectGetOptionsType): Promise<ReadableStream<Uint8Array>>;
  deleteVersion(file: B2FileType, options?: { readonly signal?: AbortSignal }): Promise<void>;
}
/** Only HTTPS service URLs without embedded credentials, queries or fragments are admitted. */
function endpoint(value: string, upload = false): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (!upload && url.search) || url.hash) {
    throw new TypeError("B2 endpoints require HTTPS without credentials, query or fragment.");
  }
  return url;
}
/** B2 names have UTF-8 byte limits and cannot contain control characters. */
function name(value: string): string {
  if (
    typeof value !== "string" || !value || value.length > 1024 || Array.from(value).some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127 || (code >= 0xd800 && code <= 0xdfff);
    }) ||
    new TextEncoder().encode(value).byteLength > 1024
  ) {
    throw new TypeError("Invalid B2 file name.");
  }
  return value;
}
/** Safe integers prevent Range construction from losing precision. */
function integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a nonnegative safe integer.`);
  return value;
}
/** Convert version metadata without assigning a B2 identity to an ETag. */
function stat(file: B2FileType): ObjectStatType {
  return {
    size: file.contentLength,
    lastModified: file.uploadTimestamp,
    mediaType: file.contentType,
    version: file.fileId,
    revision: { kind: "version", value: file.fileId },
    metadata: file.fileInfo,
  };
}
/** Reads bounded control JSON and always retires the internally owned response. */
async function json(response: Response): Promise<unknown> {
  const text = await readText(response);
  if (!response.ok) {
    let code = "service-error";
    try {
      code = z.object({ code: z.string() }).parse(JSON.parse(text)).code;
    } catch { /* A malformed service error still retains its HTTP status. */ }
    throw new B2Error(response.status, code);
  }
  return JSON.parse(text);
}
/** Explicit v4 account authorization; no environment, bucket or credential discovery occurs. */
export async function authorizeB2(options: {
  readonly applicationKeyId: string;
  readonly applicationKey: string;
  readonly fetch: FetchType;
  readonly signal?: AbortSignal;
}): Promise<B2AuthorizationType> {
  if (
    !/^[\x21-\x7e]+$/.test(options.applicationKeyId) || options.applicationKeyId.includes(":") ||
    !/^[\x21-\x7e]+$/.test(options.applicationKey)
  ) throw new TypeError("B2 application credentials must be nonempty ASCII without a colon in the key ID.");
  const response = await options.fetch("https://api.backblazeb2.com/b2api/v4/b2_authorize_account", {
    headers: { authorization: `Basic ${btoa(`${options.applicationKeyId}:${options.applicationKey}`)}` },
    redirect: "error",
    credentials: "omit",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const parsed = z.object({
    accountId: z.string(),
    authorizationToken: z.string(),
    apiInfo: z.object({ storageApi: z.object({ apiUrl: z.string(), downloadUrl: z.string() }) }),
  }).parse(await json(response));
  const result = B2AuthorizationSchema.parse({
    accountId: parsed.accountId,
    authorizationToken: parsed.authorizationToken,
    ...parsed.apiInfo.storageApi,
  });
  endpoint(result.apiUrl);
  endpoint(result.downloadUrl);
  return result;
}
/** Create a single-bucket native B2 client. Uploads buffer admitted bytes for native SHA1; streams are rejected before I/O. */
export function createB2Client(options: B2ClientOptionsType): B2ClientType {
  const auth = B2AuthorizationSchema.parse(options.authorization);
  const api = endpoint(auth.apiUrl);
  const downloadUrl = endpoint(auth.downloadUrl);
  if (!options.bucketId) throw new TypeError("B2 bucketId is required.");
  const bucketId = options.bucketId;
  const fetch = options.fetch;
  const subtle = options.subtle;
  const maxUploadBytes = options.maxUploadBytes ?? B2_UPLOAD_BYTES;
  if (integer(maxUploadBytes, "maxUploadBytes") < 1 || maxUploadBytes > B2_UPLOAD_BYTES) {
    throw new RangeError("B2 upload policy exceeds the implementation ceiling.");
  }
  /** Every call is one attempt; redirect refusal prevents token forwarding to another endpoint. */
  async function call(operation: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(new URL(`/b2api/v4/${operation}`, api), {
      method: "POST",
      headers: { authorization: auth.authorizationToken, "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      credentials: "omit",
      ...(signal === undefined ? {} : { signal }),
    });
    return await json(response);
  }
  /** Receipt attribution checks the configured bucket and exact requested name/ID. */
  function file(value: unknown, expected?: { readonly fileId?: string; readonly fileName?: string }): B2FileType {
    const parsed = B2FileSchema.parse(value);
    if (
      parsed.bucketId !== bucketId || (expected?.fileId !== undefined && parsed.fileId !== expected.fileId) ||
      (expected?.fileName !== undefined && parsed.fileName !== expected.fileName)
    ) throw new TypeError("B2 returned a different file identity.");
    return parsed;
  }
  async function getFileInfo(fileId: string, request: { readonly signal?: AbortSignal } = {}): Promise<B2FileType> {
    if (!fileId) throw new TypeError("B2 file ID is required.");
    return file(await call("b2_get_file_info", { fileId }, request.signal), { fileId });
  }
  async function current(key: string, signal?: AbortSignal): Promise<B2FileType | null> {
    name(key);
    const result = z.object({ files: z.array(z.unknown()).max(1) }).parse(
      await call("b2_list_file_names", { bucketId, prefix: key, startFileName: key, maxFileCount: 1 }, signal),
    );
    const first = result.files[0];
    if (first === undefined) return null;
    const parsed = file(first);
    return parsed.fileName === key ? parsed : null;
  }
  async function download(input: B2FileType, request: ObjectGetOptionsType = {}): Promise<ReadableStream<Uint8Array>> {
    const snapshot = file(input);
    name(snapshot.fileName);
    if (
      request.revision !== undefined &&
      (request.revision.kind !== "version" || request.revision.value !== snapshot.fileId)
    ) throw new TypeError("B2 snapshot revision must equal its native file ID.");
    const at = integer(request.at ?? 0, "Read offset");
    const length = request.length === undefined ? snapshot.contentLength - at : integer(request.length, "Read length");
    if (at > snapshot.contentLength || length < 0 || !Number.isSafeInteger(at + length)) {
      throw new RangeError("B2 range exceeds safe offsets.");
    }
    const expected = Math.min(length, snapshot.contentLength - at);
    request.signal?.throwIfAborted();
    if (expected === 0) {
      return new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
    }
    const ranged = at !== 0 || expected !== snapshot.contentLength;
    const url = new URL("/b2api/v4/b2_download_file_by_id", downloadUrl);
    url.searchParams.set("fileId", snapshot.fileId);
    const response = await fetch(url, {
      headers: {
        authorization: auth.authorizationToken,
        ...(ranged ? { range: `bytes=${at}-${at + expected - 1}` } : {}),
      },
      redirect: "error",
      credentials: "omit",
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    try {
      if (!response.ok) {
        await json(response);
        throw new TypeError("Unreachable B2 response.");
      }
      if (
        response.status !== (ranged ? 206 : 200) || response.headers.get("x-bz-file-id") !== snapshot.fileId ||
        decodeURIComponent((response.headers.get("x-bz-file-name") ?? "").replaceAll("+", " ")) !== snapshot.fileName ||
        (response.headers.get("content-encoding") ?? "identity") !== "identity" ||
        response.headers.get("content-length") !== String(expected)
      ) throw new TypeError("B2 download identity or extent mismatch.");
      if (
        ranged && response.headers.get("content-range") !== `bytes ${at}-${at + expected - 1}/${snapshot.contentLength}`
      ) throw new TypeError("B2 ignored the exact requested range.");
      if (response.body === null) throw new TypeError("B2 download has no body.");
      let received = 0;
      return response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            if (!isBytes(chunk)) throw new TypeError("B2 body must contain bytes.");
            const bytes = toView(chunk);
            received += bytes.byteLength;
            if (received > expected) throw new RangeError("B2 body exceeds declared extent.");
            controller.enqueue(bytes);
          },
          flush() {
            if (received !== expected) throw new TypeError("B2 download was truncated.");
          },
        }),
      );
    } catch (reason) {
      return await readResponse(response, () => {
        throw reason;
      });
    }
  }
  return {
    name: "b2",
    identity: `b2:${api.origin}:${auth.accountId}:${bucketId}`,
    maxUploadBytes,
    capabilities: {
      rangeRead: true,
      streamRead: true,
      streamWrite: false,
      copy: false,
      conditionalWrite: false,
      multipart: false,
      metadata: true,
      versions: true,
    },
    getFileInfo,
    download,
    async head(key, request) {
      const value = await current(key, request?.signal);
      return value === null ? null : stat(value);
    },
    async get(key, request = {}) {
      name(key);
      if (request.revision !== undefined && request.revision.kind !== "version") {
        throw new TypeError("B2 only admits native file-ID revisions.");
      }
      const value = request.revision === undefined
        ? await current(key, request.signal)
        : await getFileInfo(request.revision.value, request);
      if (value === null) throw new B2Error(404, "file_not_present");
      if (value.fileName !== key) throw new TypeError("B2 revision belongs to another file name.");
      return await download(value, request);
    },
    async put(key, body, request: ObjectPutOptionsType = {}) {
      name(key);
      if (request.revision !== undefined || request.ifMatch !== undefined || request.ifNoneMatch !== undefined) {
        throw new TypeError("B2 native upload cannot enforce destination write conditions.");
      }
      if (!isBytes(body)) throw new TypeError("B2 single-file upload requires materialized bytes.");
      const view = toView(body);
      if (view.byteLength > maxUploadBytes || (request.size !== undefined && request.size !== view.byteLength)) {
        throw new RangeError("B2 upload exceeds policy or differs from the declared size.");
      }
      const metadata = Object.entries(request.metadata ?? {});
      if (metadata.length > 10) throw new RangeError("B2 file info admits at most ten entries.");
      const infoHeaders: Record<string, string> = {};
      let headerBytes = "X-Bz-File-Name: ".length + encodeURIComponent(key).length + 2;
      for (const [field, value] of metadata) {
        if (!/^[a-z0-9_-]{1,50}$/.test(field) || field.startsWith("b2-") || typeof value !== "string") {
          throw new TypeError(
            "B2 metadata keys require 1..50 lowercase ASCII letters, digits, underscores or hyphens, excluding reserved b2- names.",
          );
        }
        if (value.length > 2048) throw new RangeError("B2 metadata exceeds the preliminary string budget.");
        const encoded = encodeURIComponent(value);
        headerBytes += "X-Bz-Info-".length + field.length + 2 + encoded.length + 2;
        if (headerBytes > 2048) {
          throw new RangeError("B2 name and metadata exceed the conservative 2048-byte header budget.");
        }
        infoHeaders[`x-bz-info-${field}`] = encoded;
      }
      if (headerBytes > 2048) throw new RangeError("B2 name exceeds the upload header safety budget.");
      const bytes = new Uint8Array(view); // Freeze admitted bytes before asynchronous hashing and URL acquisition.
      request.signal?.throwIfAborted();
      const digest = new Uint8Array(await subtle.digest("SHA-1", bytes));
      const sha1 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
      const target = z.object({ bucketId: z.string(), uploadUrl: z.string(), authorizationToken: z.string().min(1) })
        .parse(await call("b2_get_upload_url", { bucketId }, request.signal));
      if (target.bucketId !== bucketId) throw new TypeError("B2 upload URL belongs to another bucket.");
      const url = endpoint(target.uploadUrl, true);
      const headers = new Headers({
        authorization: target.authorizationToken,
        "x-bz-file-name": encodeURIComponent(key),
        "content-type": request.mediaType ?? "application/octet-stream",
        "content-length": String(bytes.byteLength),
        "x-bz-content-sha1": sha1,
        ...infoHeaders,
      });
      request.signal?.throwIfAborted();
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers,
          body: toRequestBytes(bytes),
          redirect: "error",
          credentials: "omit",
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
      } catch (cause) {
        throw new B2PublicationError(cause);
      }
      if (response.status !== 200) {
        // A server timeout/failure can follow publication. Only a concrete client
        // rejection is a known negative acknowledgement; never replay ambiguity.
        const ambiguous = response.status < 400 || response.status >= 500 || response.status === 408;
        try {
          await json(response);
          throw new B2Error(response.status, "unexpected-upload-status");
        } catch (cause) {
          if (ambiguous) throw new B2PublicationError(cause);
          throw cause;
        }
      }
      try {
        const receipt = file(await json(response), { fileName: key });
        if (receipt.contentLength !== bytes.byteLength || receipt.contentSha1 !== sha1) {
          throw new TypeError("B2 upload receipt differs from admitted bytes.");
        }
        for (const [field, value] of metadata) {
          if (receipt.fileInfo[field] !== value) throw new TypeError("B2 receipt differs from admitted metadata.");
        }
        return stat(receipt);
      } catch (cause) {
        throw new B2PublicationError(cause);
      }
    },
    async delete(key, request = {}) {
      name(key);
      if (request.revision !== undefined) {
        throw new TypeError(
          "B2 hide cannot enforce a current-version condition; use deleteVersion for exact version removal.",
        );
      }
      try {
        const hidden = z.object({
          action: z.literal("hide"),
          bucketId: z.literal(bucketId),
          fileName: z.literal(key),
          fileId: z.string().min(1),
        }).parse(await call("b2_hide_file", { bucketId, fileName: key }, request.signal));
        void hidden;
      } catch (cause) {
        if (cause instanceof B2Error) throw cause;
        throw new B2PublicationError(cause);
      }
    },
    async deleteVersion(input, request = {}) {
      const snapshot = file(input);
      name(snapshot.fileName);
      try {
        z.object({ fileId: z.literal(snapshot.fileId), fileName: z.literal(snapshot.fileName) }).parse(
          await call(
            "b2_delete_file_version",
            { fileId: snapshot.fileId, fileName: snapshot.fileName },
            request.signal,
          ),
        );
      } catch (cause) {
        if (cause instanceof B2Error) throw cause;
        throw new B2PublicationError(cause);
      }
    },
    async list(request: ObjectListOptionsType) {
      if (request.prefix) name(request.prefix);
      if (request.cursor !== undefined) name(request.cursor);
      if (request.delimiter !== undefined && request.delimiter !== "/") {
        throw new TypeError("This B2 profile admits only the slash delimiter.");
      }
      const limit = request.limit ?? 1000;
      if (integer(limit, "List limit") < 1 || limit > 10000) throw new RangeError("B2 list limit must be 1..10000.");
      const result = z.object({ files: z.array(z.unknown()).max(limit), nextFileName: z.string().nullable() }).parse(
        await call("b2_list_file_names", {
          bucketId,
          prefix: request.prefix,
          maxFileCount: limit,
          ...(request.delimiter === undefined ? {} : { delimiter: request.delimiter }),
          ...(request.cursor === undefined ? {} : { startFileName: request.cursor }),
        }, request.signal),
      );
      const objects = [];
      const prefixes: string[] = [];
      for (const value of result.files) {
        const entry = z.object({ action: z.string(), fileName: z.string() }).parse(value);
        if (!entry.fileName.startsWith(request.prefix)) throw new TypeError("B2 listing escaped its requested prefix.");
        if (entry.action === "folder") prefixes.push(entry.fileName);
        else {
          const item = file(value);
          objects.push({ key: item.fileName, ...stat(item) });
        }
      }
      if (
        result.nextFileName !== null &&
        (!result.nextFileName.startsWith(request.prefix) || result.nextFileName === request.cursor)
      ) throw new TypeError("B2 returned an invalid or repeated cursor.");
      return { objects, prefixes, ...(result.nextFileName === null ? {} : { cursor: result.nextFileName }) };
    },
  };
}
