/** One HTTP resource as an exact revision-bound source; arbitrary URLs do not imply a directory. @module */
import { sendRequest } from "./request.ts";
import type { FetchType, RequestPolicyType } from "./request.ts";
import { readResponse } from "./response.ts";
import { assertRangeResponse, range } from "./range.ts";
import { objectETag } from "./publication.ts";
import { openObjectSource } from "./source.ts";
import type { ByteSourceType, ObjectSourceBackendType, ObjectSourceOptionsType } from "./source.ts";

/** HTTP failure retains status and operation without retaining a credential-bearing URL. */
export class HttpError extends Error {
  readonly status: number;
  readonly operation: string;
  constructor(status: number, operation: string) {
    super(`HTTP ${operation} failed with status ${status}.`);
    this.name = "HttpError";
    this.status = status;
    this.operation = operation;
  }
}

/** Caller-owned HTTP authentication and exact-byte admission. */
export interface HttpSourceOptionsType extends Omit<ObjectSourceOptionsType, "namespace"> {
  readonly fetch?: FetchType;
  /** Evaluated per attempt. Host, framing, range and conditional fields are removed; the source owns them. */
  readonly headers?: HeadersInit | ((url: URL) => HeadersInit | Promise<HeadersInit>);
  readonly credentials?: RequestCredentials;
  readonly policy?: RequestPolicyType;
  /** Caller assertion binding the complete resource URL and authentication context. No automatic URL identity. */
  readonly identity?: string;
}

/** Opens through HEAD, then exact conditional GETs. Redirects never forward caller credentials. */
export async function openHttpSource(
  input: string | URL,
  options: HttpSourceOptionsType = {},
): Promise<ByteSourceType> {
  const url = new URL(input);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash) {
    throw new TypeError("An HTTP source requires an HTTP(S) URL without embedded credentials or a fragment.");
  }
  const { signal, identity, assumeStable, maxReadBytes, credentials = "omit" } = options;
  signal?.throwIfAborted();
  const fetcher = options.fetch ?? globalThis.fetch;
  const auth = typeof options.headers === "function" ? options.headers : new Headers(options.headers);
  const policy = options.policy === undefined ? undefined : { ...options.policy };
  const request = (method: string, headers: Headers, requestSignal?: AbortSignal): Promise<Response> =>
    sendRequest(async (attemptSignal) => {
      const admitted = new Headers(typeof auth === "function" ? await auth(new URL(url)) : auth);
      // Absence is also protocol authority: HEAD must be unconditional, and a
      // caller If-Range/If-None-Match must not suppress or change a later range.
      // The URL owns Host and these bodyless methods own request framing.
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
      ) admitted.delete(name);
      headers.forEach((value, name) => admitted.set(name, value));
      admitted.set("accept-encoding", "identity");
      return {
        input: new URL(url),
        init: {
          method,
          headers: admitted,
          credentials,
          redirect: "manual",
          ...(attemptSignal === undefined ? {} : { signal: attemptSignal }),
        },
      };
    }, {
      fetch: fetcher,
      replayable: true,
      ...(policy === undefined ? {} : { policy }),
      ...(requestSignal === undefined ? {} : { signal: requestSignal }),
    });
  const backend: ObjectSourceBackendType = {
    ...(identity === undefined ? {} : { identity }),
    capabilities: { rangeRead: true },
    async head(_key, requestOptions) {
      const response = await request("HEAD", new Headers(), requestOptions?.signal);
      return await readResponse(response, () => {
        if (response.status === 404) return null;
        if (response.status !== 200) throw new HttpError(response.status, "HEAD");
        const encoding = response.headers.get("content-encoding");
        if (encoding !== null && encoding.toLowerCase().trim() !== "identity") {
          throw new TypeError("Encoded HTTP resources cannot preserve byte offsets.");
        }
        const text = response.headers.get("content-length");
        if (text === null || !/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
          throw new TypeError("HTTP HEAD requires a finite Content-Length.");
        }
        const etag = response.headers.get("etag");
        return { size: Number(text), ...(etag === null ? {} : { etag }) };
      });
    },
    async get(_key, requestOptions = {}) {
      const selected = range(requestOptions);
      const etag = objectETag(requestOptions.revision);
      if (selected.empty) return new Blob().stream();
      const headers = new Headers();
      if (selected.header !== undefined) headers.set("range", selected.header);
      if (etag !== undefined) headers.set("if-match", etag);
      const response = await request("GET", headers, selected.signal);
      if (!response.ok) {
        return await readResponse(response, () => {
          throw new HttpError(response.status, "GET");
        });
      }
      await assertRangeResponse(response, selected);
      if (etag !== undefined && response.headers.has("etag") && response.headers.get("etag") !== etag) {
        return await readResponse(response, () => {
          throw new TypeError("HTTP GET returned a different revision.");
        });
      }
      return response.body ?? new Blob().stream();
    },
  };
  return await openObjectSource(backend, "", {
    ...(signal === undefined ? {} : { signal }),
    ...(assumeStable === undefined ? {} : { assumeStable }),
    ...(maxReadBytes === undefined ? {} : { maxReadBytes }),
  });
}
