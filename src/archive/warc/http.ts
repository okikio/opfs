/**
 * HTTP request and response records for WARC files.
 *
 * A WARC `response` or `request` record holds the HTTP message as it went over
 * the wire: the start line, the header lines, an empty line, then the body.
 * {@link createResponseRecord} and {@link createRequestRecord} build that block and the record
 * around it. {@link readHttpHead} reads the start line and `Content-Type` back,
 * and finds where the body starts, so the writer can compute
 * `WARC-Payload-Digest` and report the status and media type for a CDXJ index.
 *
 * @module
 */
import type { WarcWriteRecordType } from "./write.ts";

/** Input for {@link createResponseRecord}. */
export interface HttpResponseInputType {
  /** The URL that was fetched. It becomes `WARC-Target-URI`. */
  readonly url: string;
  /** HTTP status code, from 100 to 599. */
  readonly status: number;
  /** Reason phrase. Defaults to `OK` for 200 and an empty phrase otherwise. */
  readonly statusText?: string;
  /** Response headers, in the order received. */
  readonly headers?: HeadersInit;
  /** Response body as received. */
  readonly body?: Uint8Array;
  /** Capture time. Defaults to the time the record is written. */
  readonly date?: Date | string;
  /** HTTP version on the status line. Defaults to `HTTP/1.1`. */
  readonly version?: string;
}

/** Input for {@link createRequestRecord}. */
export interface HttpRequestInputType {
  /** The URL that was requested. It becomes `WARC-Target-URI`. */
  readonly url: string;
  /** HTTP method. Defaults to `GET`. */
  readonly method?: string;
  /** Request headers, in the order sent. */
  readonly headers?: HeadersInit;
  /** Request body. */
  readonly body?: Uint8Array;
  /** Capture time. Defaults to the time the record is written. */
  readonly date?: Date | string;
  /** HTTP version on the request line. Defaults to `HTTP/1.1`. */
  readonly version?: string;
}

/** The start of an HTTP message, read from a WARC block. */
export interface HttpHeadType {
  /** Status code, for a response. */
  readonly status?: number;
  /** Media type from `Content-Type`, lowercased and without parameters. */
  readonly mime?: string;
  /** Byte offset where the body starts, after the empty line. */
  readonly bodyOffset: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Refuses CR, LF and NUL, which would split or end a header line. */
function assertLine(value: string, label: string): void {
  if (/[\r\n\0]/.test(value)) throw new TypeError(`${label} contains a line break or NUL.`);
}

/** Joins a start line, header lines and the body into one HTTP message. */
function getMessage(start: string, headers: HeadersInit | undefined, body: Uint8Array | undefined): Uint8Array {
  // Keep the caller's order and casing: a WARC records what was on the wire.
  const pairs: [string, string][] = headers instanceof Headers
    ? [...headers]
    : Array.isArray(headers)
    ? headers.map(([name, value]) => [name, value])
    : Object.entries(headers ?? {});
  const lines = [start];
  for (const [name, value] of pairs) {
    assertLine(name, "HTTP header name");
    assertLine(value, "HTTP header value");
    lines.push(`${name}: ${value}`);
  }
  const head = encoder.encode(`${lines.join("\r\n")}\r\n\r\n`);
  const bytes = new Uint8Array(head.length + (body?.length ?? 0));
  bytes.set(head);
  if (body !== undefined) bytes.set(body, head.length);
  return bytes;
}

/**
 * Builds a WARC `response` record from a fetched HTTP response.
 *
 * The writer adds `WARC-Payload-Digest` over `body`, and reports `status` and
 * `mime` to `onRecord`, so a CDXJ line can be built from the report alone.
 *
 * @example
 * ```ts
 * import { createResponseRecord, createWarcStream } from "@okikio/opfs/archive/warc/write";
 *
 * const body = new TextEncoder().encode("<!doctype html><title>Hi</title>");
 * const stream = createWarcStream([
 *   createResponseRecord({ url: "https://example.com/", status: 200, headers: { "content-type": "text/html" }, body }),
 * ], { compression: "gzip" });
 * ```
 */
export function createResponseRecord(input: HttpResponseInputType): WarcWriteRecordType {
  if (!Number.isInteger(input.status) || input.status < 100 || input.status > 599) {
    throw new RangeError("HTTP status must be an integer from 100 to 599.");
  }
  const reason = input.statusText ?? (input.status === 200 ? "OK" : "");
  const version = input.version ?? "HTTP/1.1";
  assertLine(reason, "HTTP reason phrase");
  assertLine(version, "HTTP version");
  return {
    type: "response",
    targetUri: input.url,
    ...(input.date === undefined ? {} : { date: input.date }),
    contentType: "application/http; msgtype=response",
    // HTTP/1.1 keeps the space after the code even when the reason phrase is empty.
    block: getMessage(`${version} ${input.status} ${reason}`, input.headers, input.body),
  };
}

/**
 * Builds a WARC `request` record from the HTTP request that was sent.
 *
 * The request line uses the URL's path and query, as HTTP/1.1 sends it.
 */
export function createRequestRecord(input: HttpRequestInputType): WarcWriteRecordType {
  const url = new URL(input.url);
  const method = input.method ?? "GET";
  const version = input.version ?? "HTTP/1.1";
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(method)) throw new TypeError("HTTP method must be a token.");
  assertLine(version, "HTTP version");
  return {
    type: "request",
    targetUri: input.url,
    ...(input.date === undefined ? {} : { date: input.date }),
    contentType: "application/http; msgtype=request",
    block: getMessage(`${method} ${url.pathname || "/"}${url.search} ${version}`, input.headers, input.body),
  };
}

/**
 * Reads the start line and `Content-Type` of an HTTP message, and where its body starts.
 *
 * Returns `undefined` when `bytes` has no complete header block within
 * `maxBytes`. Only the head is decoded; the body is never copied.
 */
export function readHttpHead(bytes: Uint8Array, maxBytes = 64 * 1024): HttpHeadType | undefined {
  const limit = Math.min(bytes.length, maxBytes);
  let end = -1;
  for (let at = 0; at + 3 < limit; at++) {
    if (bytes[at] === 13 && bytes[at + 1] === 10 && bytes[at + 2] === 13 && bytes[at + 3] === 10) {
      end = at;
      break;
    }
  }
  if (end < 0) return undefined;
  const lines = decoder.decode(bytes.subarray(0, end)).split("\r\n");
  const status = /^HTTP\/\d(?:\.\d)? (\d{3})(?: |$)/.exec(lines[0] ?? "");
  let mime: string | undefined;
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === "content-type") {
      mime = line.slice(colon + 1).split(";")[0]!.trim().toLowerCase() || undefined;
    }
  }
  return {
    ...(status === null ? {} : { status: Number(status[1]) }),
    ...(mime === undefined ? {} : { mime }),
    bodyOffset: end + 4,
  };
}
