import type { FetchType } from "./request.ts";
import type { UploadDestinationType, UploadStatusType } from "./transfer.ts";
import { isBytes, toView } from "./bytes.ts";

/** Options for one tus request; cancellation never terminates remote upload state. */
export interface TusRequestOptionsType {
  readonly signal?: AbortSignal;
}

/** Explicit transport and authentication policy for a tus 1.0 endpoint. */
export interface TusClientOptionsType {
  readonly endpoint: string | URL;
  /** Borrowed Fetch implementation, acquired only when constructing this client. */
  readonly fetch?: FetchType;
  /** Called separately for every request, allowing application-owned token refresh. */
  readonly headers?: HeadersInit | ((url: URL) => HeadersInit | Promise<HeadersInit>);
  /** Cookie/client-certificate policy. Defaults to omit; browser credentials require explicit selection. */
  readonly credentials?: RequestCredentials;
  /** Default allows only the endpoint origin. Override explicitly for cross-origin upload resources. */
  readonly allowUploadURL?: (url: URL) => boolean;
}

/** Live endpoint discovery; advertised extensions are not all implemented by this client. */
export interface TusCapabilitiesType {
  readonly versions: readonly string[];
  readonly extensions: readonly string[];
  readonly maxSize?: number;
}

/** Protocol failure. Transport failures preserve their original rejection reason instead. */
export class TusError extends Error {
  readonly code: "protocol" | "conflict" | "missing" | "unsupported";
  readonly status: number | undefined;
  constructor(code: TusError["code"], message: string, status?: number) {
    super(message);
    this.name = "TusError";
    this.code = code;
    this.status = status;
  }
}

/** Refuses ambiguous or unsafe offsets rather than rounding a provider value. */
function integer(value: string | null, name: string): number {
  if (value === null || !/^[0-9]+$/.test(value)) {
    throw new TusError("protocol", `Missing or invalid ${name}.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new TusError("protocol", `${name} exceeds safe integer precision.`);
  return number;
}

/** Numeric request values use the same safe range as the replay source. */
function size(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Upload size/offset must be a nonnegative safe integer.");
  }
}

/** Metadata is a bounded UTF-8 header, never interpolated as a raw HTTP value. */
function metadataHeader(metadata: Readonly<Record<string, string>>): string {
  const values: string[] = [];
  let length = 0;
  for (const [key, value] of Object.entries(metadata)) {
    if (!/^[\x21-\x2b\x2d-\x7e]+$/.test(key)) {
      throw new TypeError("tus metadata keys must be nonempty ASCII without comma or space.");
    }
    const bytes = new TextEncoder().encode(value);
    if (bytes.length > 6144) throw new RangeError("tus metadata exceeds the 8 KiB implementation header limit.");
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const field = `${key} ${btoa(binary)}`;
    length += field.length + (values.length ? 1 : 0);
    if (length > 8192) throw new RangeError("tus metadata exceeds the 8 KiB implementation header limit.");
    values.push(field);
  }
  return values.join(",");
}

/** Comma-separated protocol tokens; no environment or global registry is consulted. */
function tokens(value: string | null): string[] {
  return value === null ? [] : value.split(",").map((token) => token.trim()).filter(Boolean);
}

/**
 * Explicit tus 1.0 client for core uploads, creation and negotiated termination.
 *
 * Every request is sent once. After a failed or interrupted PATCH, call status
 * before deciding which bytes to send. Redirects are refused to avoid forwarding
 * credentials to an unapproved target. This client owns response bodies only;
 * transport and credentials remain borrowed. It does not implement a tus server,
 * deferred lengths, concatenation, creation-with-upload or checksum negotiation.
 */
export class TusClient {
  readonly #endpoint: URL;
  readonly #fetch: FetchType;
  readonly #headers: TusClientOptionsType["headers"];
  readonly #credentials: RequestCredentials;
  readonly #allow: (url: URL) => boolean;

  constructor(options: TusClientOptionsType) {
    this.#endpoint = new URL(options.endpoint);
    if (!["http:", "https:"].includes(this.#endpoint.protocol) || this.#endpoint.username || this.#endpoint.password) {
      throw new TypeError("tus endpoint must be an HTTP(S) URL without embedded credentials.");
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#headers = options.headers;
    this.#credentials = options.credentials ?? "omit";
    this.#allow = options.allowUploadURL ?? ((url) => url.origin === this.#endpoint.origin);
  }

  /** Validates each resource before authentication or transport acquires effects. */
  #url(value: string | URL): URL {
    const url = new URL(value, this.#endpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !this.#allow(url)) {
      throw new TypeError("Upload URL is outside the explicitly authorized tus endpoint policy.");
    }
    url.hash = "";
    return url;
  }

  /** Response bodies are never materialized: this protocol consumes headers only. */
  async #request<Value>(
    url: URL,
    method: string,
    fields: HeadersInit,
    options: TusRequestOptionsType,
    accept: (response: Response) => Value,
    body?: Uint8Array<ArrayBuffer>,
  ): Promise<Value> {
    options.signal?.throwIfAborted();
    const headers = new Headers(
      typeof this.#headers === "function" ? await this.#headers(new URL(url)) : this.#headers,
    );
    options.signal?.throwIfAborted();
    if (method !== "OPTIONS") headers.set("Tus-Resumable", "1.0.0");
    else headers.delete("Tus-Resumable");
    new Headers(fields).forEach((value, key) => headers.set(key, value));
    const response = await this.#fetch(url, {
      method,
      headers,
      redirect: "error",
      credentials: this.#credentials,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(body === undefined ? {} : { body }),
    });
    let outcome: { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly reason: unknown };
    try {
      options.signal?.throwIfAborted();
      if (method !== "OPTIONS" && response.headers.get("Tus-Resumable") !== "1.0.0") {
        throw new TusError("protocol", "The response does not confirm tus 1.0.0.", response.status);
      }
      if (!response.ok) {
        const code = response.status === 409
          ? "conflict"
          : [404, 410].includes(response.status)
          ? "missing"
          : "protocol";
        throw new TusError(code, `tus ${method} failed with HTTP ${response.status}.`, response.status);
      }
      outcome = { ok: true, value: accept(response) };
    } catch (reason) {
      outcome = { ok: false, reason };
    }
    try {
      await response.body?.cancel();
    } catch (reason) {
      if (!outcome.ok) {
        throw new AggregateError([outcome.reason, reason], "tus response and response cleanup failed.", {
          cause: outcome.reason,
        });
      }
      throw reason;
    }
    if (!outcome.ok) throw outcome.reason;
    return outcome.value;
  }

  /** Performs explicit capability discovery without creating or modifying an upload. */
  async discover(options: TusRequestOptionsType = {}): Promise<TusCapabilitiesType> {
    return await this.#request(this.#endpoint, "OPTIONS", {}, options, (response) => {
      if (![200, 204].includes(response.status)) {
        throw new TusError("protocol", "Invalid tus OPTIONS status.", response.status);
      }
      const versions = tokens(response.headers.get("Tus-Version"));
      if (!versions.includes("1.0.0")) throw new TusError("unsupported", "The endpoint does not advertise tus 1.0.0.");
      const max = response.headers.get("Tus-Max-Size");
      return {
        versions,
        extensions: tokens(response.headers.get("Tus-Extension")),
        ...(max === null ? {} : { maxSize: integer(max, "Tus-Max-Size") }),
      };
    });
  }

  /** Creates a known-length empty upload after checking the advertised creation capability. */
  async create(
    length: number,
    metadata: Readonly<Record<string, string>> = {},
    options: TusRequestOptionsType = {},
  ): Promise<UploadDestinationType> {
    size(length);
    const encoded = metadataHeader(metadata);
    const capabilities = await this.discover(options);
    if (!capabilities.extensions.includes("creation")) {
      throw new TusError("unsupported", "tus creation is not advertised.");
    }
    if (capabilities.maxSize !== undefined && length > capabilities.maxSize) {
      throw new RangeError("Upload exceeds Tus-Max-Size.");
    }
    const url = await this.#request(
      this.#endpoint,
      "POST",
      {
        "Upload-Length": String(length),
        ...(encoded ? { "Upload-Metadata": encoded } : {}),
      },
      options,
      (response) => {
        if (response.status !== 201) throw new TusError("protocol", "tus creation requires HTTP 201.", response.status);
        const location = response.headers.get("Location");
        if (location === null) throw new TusError("protocol", "tus creation omitted Location.");
        return this.#url(location).href;
      },
    );
    return this.open(url);
  }

  /** Opens a borrowed remote session without I/O; it does not create directories or a filesystem. */
  open(value: string | URL): UploadDestinationType {
    const url = this.#url(value).href;
    return {
      protocol: "tus-1.0.0",
      url,
      status: (options = {}) => this.status(url, options),
      write: (offset, bytes, options = {}) => this.write(url, offset, bytes, options),
      terminate: (options = {}) => this.terminate(url, options),
    };
  }

  /** Reads the server-retained offset and fixed length; expiration is visible as raw HTTP date metadata. */
  async status(value: string | URL, options: TusRequestOptionsType = {}): Promise<UploadStatusType> {
    return await this.#request(this.#url(value), "HEAD", { "Cache-Control": "no-store" }, options, (response) => {
      if (![200, 204].includes(response.status)) {
        throw new TusError("protocol", "Invalid tus HEAD status.", response.status);
      }
      const offset = integer(response.headers.get("Upload-Offset"), "Upload-Offset");
      const length = integer(response.headers.get("Upload-Length"), "Upload-Length");
      if (offset > length) throw new TusError("protocol", "Upload offset exceeds its length.");
      const expires = response.headers.get("Upload-Expires");
      return { offset, size: length, complete: offset === length, ...(expires === null ? {} : { expires }) };
    });
  }

  /** Sends one bounded byte chunk once; an unobserved result must be reconciled using status(). */
  async write(
    value: string | URL,
    offset: number,
    bytes: Uint8Array,
    options: TusRequestOptionsType = {},
  ): Promise<number> {
    size(offset);
    if (!isBytes(bytes)) throw new TypeError("tus upload chunks must be native Uint8Array bytes.");
    const view = toView(bytes);
    size(offset + view.byteLength);
    // Own the admitted byte extent before asynchronous authentication can run.
    const payload = new Uint8Array(view);
    return await this.#request(
      this.#url(value),
      "PATCH",
      {
        "Upload-Offset": String(offset),
        "Content-Type": "application/offset+octet-stream",
      },
      options,
      (response) => {
        if (response.status !== 204) throw new TusError("protocol", "tus PATCH requires HTTP 204.", response.status);
        const next = integer(response.headers.get("Upload-Offset"), "Upload-Offset");
        if (next !== offset + payload.byteLength) {
          throw new TusError(
            "protocol",
            "PATCH acknowledgment does not cover the exact chunk.",
          );
        }
        return next;
      },
      payload,
    );
  }

  /** Explicit remote deletion, available only after fresh termination-capability discovery. */
  async terminate(value: string | URL, options: TusRequestOptionsType = {}): Promise<void> {
    const url = this.#url(value);
    const capabilities = await this.discover(options);
    if (!capabilities.extensions.includes("termination")) {
      throw new TusError("unsupported", "tus termination is not advertised.");
    }
    await this.#request(url, "DELETE", {}, options, (response) => {
      if (response.status !== 204) {
        throw new TusError("protocol", "tus termination requires HTTP 204.", response.status);
      }
    });
  }
}

/** Constructs an import-safe, explicitly configured tus client. */
export function createTusClient(options: TusClientOptionsType): TusClient {
  return new TusClient(options);
}
