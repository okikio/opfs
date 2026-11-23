/** Nextcloud's chunk-upload wire protocol, separate from generic WebDAV and backend multipart offload. @module */
import { z } from "zod";
import { isBytes, toRequestBytes, toView } from "./bytes.ts";
import { RequestMetrics, sendRequest } from "./request.ts";
import type { FetchType, RequestPolicyType } from "./request.ts";
import { readResponse } from "./response.ts";

/** Local materialization ceiling, not Nextcloud's documented 5 GB chunk maximum. */
export const NEXTCLOUD_BUFFER_BYTES = 64 * 1024 * 1024;
/** Conservative nonfinal chunk minimum that satisfies the documented 5 MB minimum. */
export const NEXTCLOUD_MIN_CHUNK_BYTES = 5 * 1024 * 1024;

/** Validates persisted data before route construction; the client also checks its configured scope. */
export const NextcloudUploadSchema: z.ZodObject<{
  protocol: z.ZodLiteral<"nextcloud-chunks">;
  endpoint: z.ZodString;
  user: z.ZodString;
  name: z.ZodString;
  target: z.ZodString;
  size: z.ZodNumber;
  chunkSize: z.ZodNumber;
  overwrite: z.ZodBoolean;
}, z.core.$strict> = z.object({
  protocol: z.literal("nextcloud-chunks"),
  endpoint: z.string().max(8192),
  user: z.string().min(1).max(1024),
  name: z.string().min(1).max(128),
  target: z.string().min(1).max(8192),
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  chunkSize: z.number().int().min(NEXTCLOUD_MIN_CHUNK_BYTES).max(NEXTCLOUD_BUFFER_BYTES),
  overwrite: z.boolean(),
}).strict().superRefine((upload, context) => {
  try {
    path(upload.user, 1024, true);
    path(upload.target, 8192);
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(upload.name) || Math.ceil(upload.size / upload.chunkSize) > 10000) {
      throw new TypeError("Invalid upload name or part count.");
    }
  } catch {
    context.addIssue({ code: "custom", message: "Invalid Nextcloud upload path, name or part count." });
  }
});
/** Persist this descriptor without credentials. It asserts caller intent, not server state or ownership. */
export type NextcloudUploadType = Readonly<z.infer<typeof NextcloudUploadSchema>>;

/** One successful chunk PUT acknowledgement. This is not remote reconciliation or a content digest. */
export interface NextcloudPartType {
  readonly part: number;
  readonly size: number;
}
/** A final MOVE acknowledgement, which does not authenticate or independently verify the stored bytes. */
export interface NextcloudReceiptType {
  readonly status: 201 | 204;
  readonly upload: NextcloudUploadType;
}
/** Explicit native deployment and authentication capability; no account or app-password discovery. */
export interface NextcloudClientOptionsType {
  readonly endpoint: string | URL;
  readonly user: string;
  /** Complete native Authorization header. The callback must not add cookie or ambient credential discovery. */
  readonly credentials: (url: URL, signal?: AbortSignal) => string | Promise<string>;
  readonly fetch?: FetchType;
  readonly policy?: RequestPolicyType;
  readonly allowHttp?: boolean;
}
/** Native refusal without URLs, credentials or response bodies in its message. */
export class NextcloudError extends Error {
  readonly status: number;
  readonly operation: string;
  constructor(status: number, operation: string) {
    super(`Nextcloud ${operation} failed with HTTP ${status}.`);
    this.name = "NextcloudError";
    this.status = status;
    this.operation = operation;
  }
}
/** Retain this session and reconcile explicitly: a failed acknowledgement does not prove no effect. */
export class NextcloudPublicationError extends Error {
  readonly outcome = "unknown";
  readonly operation: string;
  readonly upload: NextcloudUploadType;
  constructor(operation: string, upload: NextcloudUploadType, cause: unknown) {
    super(`Nextcloud ${operation} has no complete success acknowledgement.`, { cause });
    this.name = "NextcloudPublicationError";
    this.operation = operation;
    this.upload = Object.freeze({ ...upload });
  }
}

/** Reject aliases before URL normalization. Literal percent characters are encoded once, not decoded as paths. */
function path(value: string, maximum: number, single = false): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !value.isWellFormed()) {
    throw new TypeError("Nextcloud path is outside the selected literal UTF-8 profile.");
  }
  const parts = value.split("/");
  // deno-lint-ignore no-control-regex -- Controls are deliberately outside the literal path profile.
  const forbidden = /[\\\u0000-\u001f\u007f]/u;
  if (
    (single && parts.length !== 1) ||
    parts.some((part) => part === "" || part === "." || part === ".." || part.length > 1024 || forbidden.test(part))
  ) throw new TypeError("Nextcloud path contains an unsupported component.");
  return parts.map(encodeURIComponent).join("/");
}

/** Native upload-only client. Caller exclusively owns each session, its immutable source and its acknowledgement ledger. */
export class NextcloudClient {
  readonly #endpoint: string;
  readonly #user: string;
  readonly #encodedUser: string;
  readonly #credentials: NextcloudClientOptionsType["credentials"];
  readonly #fetch: FetchType;
  readonly #policy: RequestPolicyType | undefined;
  readonly #metrics = new RequestMetrics();

  constructor(options: NextcloudClientOptionsType) {
    const raw = String(options.endpoint);
    // deno-lint-ignore no-control-regex -- Validate before URL parsing can silently strip control characters.
    const forbidden = /[\\\u0000-\u0020\u007f]/u;
    if (raw.length > 8192 || forbidden.test(raw)) throw new TypeError("Invalid Nextcloud endpoint.");
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new TypeError("Invalid Nextcloud endpoint.");
    }
    if (
      url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/") ||
      !(url.protocol === "https:" || (url.protocol === "http:" && options.allowHttp === true)) ||
      /%(?:2f|5c|2e)/iu.test(raw) || raw.split("/").some((part) => part === "." || part === "..")
    ) throw new TypeError("Nextcloud endpoint must be an explicit HTTP(S) deployment root without URL credentials.");
    const user = options.user;
    this.#encodedUser = path(user, 1024, true);
    this.#user = user;
    this.#endpoint = url.href;
    this.#credentials = options.credentials;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#policy = options.policy === undefined ? undefined : { ...options.policy };
  }

  /** Validates a saved descriptor without network I/O. No server existence, expiry or part state is inferred. */
  openUpload(value: unknown): NextcloudUploadType {
    const parsed = NextcloudUploadSchema.safeParse(value);
    if (!parsed.success) throw new TypeError("Invalid Nextcloud upload descriptor.");
    const upload = parsed.data;
    if (upload.endpoint !== this.#endpoint || upload.user !== this.#user) {
      throw new TypeError("Nextcloud upload belongs to another configured scope.");
    }
    return Object.freeze({ ...upload });
  }

  /** Routes are constructed solely from validated literal components, never from a server-supplied upload URL. */
  #url(upload: NextcloudUploadType, suffix = ""): URL {
    return new URL(`remote.php/dav/uploads/${this.#encodedUser}/${upload.name}${suffix}`, this.#endpoint);
  }

  /** One mutation dispatch, with response ownership retired even when status or cleanup fails. */
  async #mutate(
    upload: NextcloudUploadType,
    operation: string,
    method: string,
    suffix: string,
    accepted: readonly number[],
    signal: AbortSignal | undefined,
    body?: Uint8Array,
  ): Promise<number> {
    signal?.throwIfAborted();
    const url = this.#url(upload, suffix);
    const headers = new Headers();
    if (method !== "DELETE") {
      headers.set(
        "destination",
        new URL(`remote.php/dav/files/${this.#encodedUser}/${path(upload.target, 8192)}`, this.#endpoint).href,
      );
      headers.set("oc-total-length", String(upload.size));
    }
    if (method === "MOVE") headers.set("overwrite", upload.overwrite ? "T" : "F");
    if (body !== undefined) headers.set("content-type", "application/octet-stream");
    let dispatched = false;
    try {
      const response = await sendRequest(async (attemptSignal) => {
        attemptSignal?.throwIfAborted();
        const authorization = await this.#credentials(new URL(url), attemptSignal);
        if (
          typeof authorization !== "string" || authorization.length === 0 || authorization.length > 8192 ||
          /[^\u0020-\u007e]/u.test(authorization)
        ) {
          throw new TypeError("Invalid Nextcloud Authorization header.");
        }
        attemptSignal?.throwIfAborted();
        const admitted = new Headers(headers);
        admitted.set("authorization", authorization);
        return {
          input: url,
          init: {
            method,
            headers: admitted,
            redirect: "manual",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            ...(attemptSignal === undefined ? {} : { signal: attemptSignal }),
            ...(body === undefined ? {} : { body: toRequestBytes(body) }),
          },
        };
      }, {
        fetch: (input, init) => {
          dispatched = true;
          return this.#fetch(input, init);
        },
        metrics: this.#metrics,
        replayable: false,
        ...(signal === undefined ? {} : { signal }),
        ...(this.#policy === undefined ? {} : { policy: this.#policy }),
      });
      return await readResponse(response, () => {
        if (!accepted.includes(response.status)) throw new NextcloudError(response.status, operation);
        return response.status;
      });
    } catch (cause) {
      if (dispatched) throw new NextcloudPublicationError(operation, upload, cause);
      throw cause;
    }
  }

  /** Creates a uniquely caller-named session; source size must remain fixed and positive. No automatic name or retry. */
  async createUpload(
    name: string,
    target: string,
    size: number,
    options: { readonly chunkSize?: number; readonly overwrite?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<NextcloudUploadType> {
    const signal = options.signal;
    const upload = this.openUpload({
      protocol: "nextcloud-chunks",
      endpoint: this.#endpoint,
      user: this.#user,
      name,
      target,
      size,
      chunkSize: options.chunkSize ?? 8 * 1024 * 1024,
      overwrite: options.overwrite ?? false,
    });
    await this.#mutate(upload, "create upload", "MKCOL", "", [201], signal);
    return upload;
  }

  /** Copies one planned chunk before authentication awaits. The returned part is caller-held acknowledgement evidence only. */
  async putPart(
    value: NextcloudUploadType,
    part: number,
    bytes: Uint8Array,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<NextcloudPartType> {
    const upload = this.openUpload(value), signal = options.signal;
    signal?.throwIfAborted();
    const count = Math.ceil(upload.size / upload.chunkSize);
    if (!Number.isSafeInteger(part) || part < 1 || part > count) throw new RangeError("Invalid Nextcloud part number.");
    if (!isBytes(bytes)) throw new TypeError("Nextcloud chunk must be a Uint8Array.");
    const view = toView(bytes), size = Math.min(upload.chunkSize, upload.size - (part - 1) * upload.chunkSize);
    if (view.byteLength !== size) throw new RangeError("Nextcloud chunk does not match its planned extent.");
    const owned = new Uint8Array(view);
    await this.#mutate(upload, "upload part", "PUT", `/${String(part).padStart(5, "0")}`, [201, 204], signal, owned);
    return Object.freeze({ part, size });
  }

  /** A complete ordered caller ledger permits dispatch, but does not prove current remote chunks or their contents. */
  async finishUpload(
    value: NextcloudUploadType,
    acknowledged: readonly NextcloudPartType[],
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<NextcloudReceiptType> {
    const upload = this.openUpload(value), signal = options.signal, count = Math.ceil(upload.size / upload.chunkSize);
    if (!Array.isArray(acknowledged) || acknowledged.length !== count) {
      throw new TypeError("Nextcloud finish needs every planned acknowledgement.");
    }
    for (let i = 0; i < count; i++) {
      const entry = acknowledged[i];
      if (entry?.part !== i + 1 || entry.size !== Math.min(upload.chunkSize, upload.size - i * upload.chunkSize)) {
        throw new TypeError("Nextcloud acknowledgement ledger has a missing, duplicate or incorrect part.");
      }
    }
    const status = await this.#mutate(upload, "finish upload", "MOVE", "/.file", [201, 204], signal);
    return Object.freeze({ status: status as 201 | 204, upload });
  }

  /** Deletes only this explicit upload session. It cannot undo a final MOVE or prove its outcome. */
  async abortUpload(value: NextcloudUploadType, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    const upload = this.openUpload(value), signal = options.signal;
    await this.#mutate(upload, "abort upload", "DELETE", "/", [204], signal);
  }
}
