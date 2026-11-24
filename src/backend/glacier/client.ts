/** Explicit original Glacier vault/archive jobs. This is not an S3 storage-class or filesystem API. @module */
import { checksumScope, decimal, outputBytes, outputSize } from "./output.ts";
import { glacierMultipartHash, partSize, treeImage } from "./hash.ts";
import { GlacierError, GlacierPublicationError } from "./error.ts";
import type {
  GlacierCredentialSourceType,
  GlacierOperationOptionsType,
  GlacierOptionsType,
  GlacierOutputSourceType,
  GlacierPartsType,
  GlacierReceiptType,
  GlacierUploadsType,
} from "./types.ts";
import {
  GLACIER_LIMITS,
  GLACIER_MIB,
  GlacierCredentialsSchema,
  GlacierJobSchema,
  type GlacierJobType,
  type GlacierPartType,
  GlacierUploadSchema,
  type GlacierUploadType,
  GlacierVaultSchema,
  type GlacierVaultType,
  HashSchema,
  IdSchema,
  MarkerSchema,
  SizeSchema,
} from "./schema.ts";
import { z } from "zod";
import { deriveSigningKey, hex, hmac, sha256 } from "../../sigv4.ts";
import { isBytes, toView } from "../../bytes.ts";
import { close } from "../../close.ts";
import { readResponse } from "../../response.ts";
import { getRequestPolicy, sendRequest } from "../../request.ts";
import type { FetchType, RequestPolicyType } from "../../request.ts";
import { assertExtent } from "../../source.ts";

/** Capture the signal object before awaiting; replacement of an options property cannot redirect active ownership. */
function operation(options: GlacierOperationOptionsType): GlacierOperationOptionsType {
  const signal = options.signal;
  return signal === undefined ? {} : { signal };
}
/** RFC3986 component encoding; callers preserve already selected route boundaries. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
/** General AWS signing normalizes path segments and escapes existing percent bytes again.
 * The wire URL remains untouched. S3's exceptional literal-path policy stays
 * with its existing owner and must not use this Glacier canonicalization.
 */
function canonicalPath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const normalized = `${path.startsWith("/") ? "/" : ""}${segments.join("/")}${
    path.endsWith("/") && segments.length > 0 ? "/" : ""
  }`;
  return encode(normalized).replace(/%2F/g, "/");
}
/** Headers cannot carry newlines; reject before invoking a credential supplier. */
function description(value: string | undefined): string | undefined {
  if (value !== undefined && (/[^\x20-\x7e]/.test(value) || value.length > 1024)) {
    throw new TypeError("Archive description must contain at most 1024 printable ASCII characters.");
  }
  return value;
}

/** Native scoped client. Imports and construction perform no provider I/O or credential discovery. */
export class GlacierClient {
  readonly #endpoint: URL;
  readonly #prefix: string;
  readonly #account: string;
  readonly #region: string;
  readonly #credentials: GlacierCredentialSourceType;
  readonly #fetch: FetchType;
  readonly #subtle: SubtleCrypto;
  readonly #now: () => Date;
  readonly #policy: RequestPolicyType | undefined;
  readonly #max: number;
  /**
   * Creates the client from `options`.
   * @param options Options that configure the client.
   */
  constructor(options: GlacierOptionsType) {
    const endpoint = new URL(options.endpoint);
    if (
      !["https:", "http:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search ||
      endpoint.hash
    ) throw new TypeError("Glacier endpoint requires an HTTP(S) origin/path without credentials, query, or fragment.");
    if (options.account !== "-" && (options.account.length !== 12 || /[^0-9]/.test(options.account))) {
      throw new TypeError("Account must be 12 ASCII digits or '-'.");
    }
    if (
      /[^A-Za-z0-9_.-]/.test(options.vault) || options.vault === "." || options.vault === ".." ||
      options.vault.length > 255 || options.vault.length === 0
    ) throw new TypeError("Invalid Glacier vault name.");
    if (options.region.length === 0 || /[^a-z0-9-]/.test(options.region)) {
      throw new TypeError("Invalid Glacier region.");
    }
    if (
      typeof options.fetch !== "function" || typeof options.now !== "function" ||
      typeof options.subtle?.digest !== "function" || typeof options.subtle?.sign !== "function" ||
      typeof options.subtle?.importKey !== "function"
    ) throw new TypeError("Glacier requires explicit Fetch, SubtleCrypto, and clock capabilities.");
    const credentials = typeof options.credentials === "function"
      ? options.credentials
      : Object.freeze(GlacierCredentialsSchema.parse(options.credentials));
    const max = options.maxBodyBytes ?? 16 * GLACIER_MIB;
    SizeSchema.positive().parse(max);
    const policy = Object.freeze(getRequestPolicy(options.requestPolicy));
    this.#endpoint = endpoint;
    this.#prefix = `${endpoint.pathname.replace(/\/$/, "")}/${encode(options.account)}/vaults/${encode(options.vault)}`;
    this.#account = options.account;
    this.#region = options.region;
    this.#credentials = credentials;
    this.#fetch = options.fetch;
    this.#subtle = options.subtle;
    this.#now = options.now;
    this.#policy = policy;
    this.#max = max;
  }
  /** Builds and checks the exact Fetch path before any credential or crypto work. */
  #url(route: string, query: Readonly<Record<string, string | undefined>> = {}): URL {
    const url = new URL(this.#endpoint);
    const path = `${this.#prefix}${route}`;
    url.pathname = path;
    if (url.pathname !== path) throw new TypeError("Fetch URL normalization changed the Glacier route.");
    url.search = Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined).map((
      [key, value],
    ) => [encode(key), encode(value)]).sort(([a, av], [b, bv]) =>
      a! < b! ? -1 : a! > b! ? 1 : av! < bv! ? -1 : av! > bv! ? 1 : 0
    ).map(([key, value]) => `${key}=${value}`).join("&");
    return url;
  }
  /** A materialized immutable request image separates repeatable bytes from mutation idempotence. */
  #image(bytes: Uint8Array, maximum = this.#max): Uint8Array<ArrayBuffer> {
    if (!isBytes(bytes)) throw new TypeError("Glacier bodies require Uint8Array bytes.");
    if (bytes.byteLength > Math.min(this.#max, maximum)) {
      throw new RangeError("Glacier body exceeds the configured materialization ceiling or provider bound.");
    }
    return new Uint8Array(toView(bytes));
  }
  /** Every attempt signs exact selected bytes; no redirect or ambient credential chain is admitted. */
  async #send(
    method: string,
    url: URL,
    headers: Headers,
    body: Uint8Array<ArrayBuffer> | undefined,
    options: GlacierOperationOptionsType,
    replayable: boolean,
    dispatch: () => void,
  ): Promise<Response> {
    const captured = operation(options);
    captured.signal?.throwIfAborted();
    const payload = hex(await sha256(this.#subtle, body ?? new Uint8Array()));
    return await sendRequest(async (signal) => {
      const timestamp = this.#now().toISOString().replace(/[:-]|\.\d{3}/g, "");
      const credentials = GlacierCredentialsSchema.parse(
        typeof this.#credentials === "function" ? await this.#credentials() : this.#credentials,
      );
      const actual = new Headers(headers);
      actual.set("x-amz-date", timestamp);
      actual.set("x-amz-glacier-version", "2012-06-01");
      actual.set("x-amz-content-sha256", payload);
      if (credentials.sessionToken !== undefined) actual.set("x-amz-security-token", credentials.sessionToken);
      const signed = new Headers(actual);
      signed.set("host", url.host);
      const names = [...signed.keys()].sort();
      const canonical = names.map((name) => `${name}:${signed.get(name)!.trim().replace(/\s+/g, " ")}`).join("\n") +
        "\n";
      const scope = `${timestamp.slice(0, 8)}/${this.#region}/glacier/aws4_request`;
      const request = [method, canonicalPath(url.pathname), url.search.slice(1), canonical, names.join(";"), payload]
        .join("\n");
      const key = await deriveSigningKey(
        this.#subtle,
        credentials.secretAccessKey,
        timestamp.slice(0, 8),
        this.#region,
        "glacier",
      );
      const signature = hex(
        await hmac(
          this.#subtle,
          key,
          `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${
            hex(await sha256(this.#subtle, new TextEncoder().encode(request)))
          }`,
        ),
      );
      actual.set(
        "authorization",
        `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${
          names.join(";")
        }, Signature=${signature}`,
      );
      return {
        input: url,
        init: {
          method,
          headers: actual,
          redirect: "manual",
          ...(body === undefined ? {} : { body }),
          ...(signal === undefined ? {} : { signal }),
        },
      };
    }, {
      fetch: (input, init) => {
        dispatch();
        return this.#fetch(input, init);
      },
      replayable,
      ...captured,
      ...(this.#policy === undefined ? {} : { policy: this.#policy }),
    });
  }
  /** A service refusal is known; a lost receipt after dispatch is not a rollback. */
  async #control<Value>(
    method: string,
    url: URL,
    status: number,
    parse: (response: Response, text: () => PromiseLike<string>) => Value | PromiseLike<Value>,
    options: GlacierOperationOptionsType = {},
    headers = new Headers(),
    body?: Uint8Array<ArrayBuffer>,
    publication?: string,
  ): Promise<Value> {
    let dispatched = false;
    let refused = false;
    let receipt: GlacierReceiptType | undefined;
    try {
      const response = await this.#send(method, url, headers, body, options, publication === undefined, () => {
        dispatched = true;
      });
      return await readResponse(response, async (text) => {
        if (response.status !== status) {
          refused = response.status >= 400 && response.status < 500;
          throw new GlacierError(response);
        }
        if (publication !== undefined) {
          receipt = this.#receipt(
            response,
            publication === "job initiation"
              ? "x-amz-job-id"
              : publication === "multipart initiation"
              ? "x-amz-multipart-upload-id"
              : "x-amz-archive-id",
          );
        }
        const result = await parse(response, text);
        return result;
      });
    } catch (cause) {
      if (publication !== undefined && dispatched && !refused) {
        throw new GlacierPublicationError(publication, cause, receipt);
      }
      throw cause;
    }
  }
  /** Headers acknowledge native identity. Location is retained as evidence and never followed. */
  #receipt(response: Response, header: string): GlacierReceiptType {
    const id = IdSchema.parse(response.headers.get(header));
    const location = z.string().min(1).parse(response.headers.get("location"));
    const target = new URL(location, this.#endpoint);
    const resource = header === "x-amz-job-id"
      ? "jobs"
      : header === "x-amz-multipart-upload-id"
      ? "multipart-uploads"
      : "archives";
    const vaultPath = this.#prefix.slice(this.#prefix.lastIndexOf("/vaults/"));
    if (target.origin !== this.#endpoint.origin || target.username || target.password || target.search || target.hash) {
      throw new TypeError("Glacier receipt location disagrees with its scope or identity.");
    }
    const beforeVault = target.pathname.slice(0, target.pathname.lastIndexOf("/vaults/"));
    const account = beforeVault.slice(beforeVault.lastIndexOf("/") + 1);
    if (
      this.#account !== "-"
        ? account !== this.#account
        : account !== "-" && (account.length !== 12 || /[^0-9]/.test(account))
    ) throw new TypeError("Glacier receipt location disagrees with its account scope.");
    const expectedPath = `${this.#endpoint.pathname.replace(/\/$/, "")}/${account}${vaultPath}/${resource}/${
      encode(id)
    }`;
    if (target.pathname !== expectedPath) {
      throw new TypeError("Glacier receipt location disagrees with its configured endpoint prefix.");
    }
    const requestId = response.headers.get("x-amzn-requestid");
    return Object.freeze({ id, location, ...(requestId === null ? {} : { requestId }) });
  }
  /** Scoped vault metadata only; this does not provision, lock, or change policies. */
  async describeVault(options: GlacierOperationOptionsType = {}): Promise<GlacierVaultType> {
    return await this.#control("GET", this.#url(""), 200, async (_response, text) => {
      const value = GlacierVaultSchema.parse(JSON.parse(await text()));
      if (value.VaultName !== decodeURIComponent(this.#prefix.slice(this.#prefix.lastIndexOf("/") + 1))) {
        throw new TypeError("Glacier returned another vault identity.");
      }
      return value;
    }, options);
  }
  /** One bounded native job page. Marker null means terminal; no background traversal occurs. */
  async listJobsPage(
    options: GlacierOperationOptionsType & { readonly marker?: string; readonly limit?: number } = {},
  ): Promise<{ readonly jobs: readonly GlacierJobType[]; readonly marker: string | null }> {
    const limit = z.number().int().min(1).max(50).parse(options.limit ?? 50);
    if (options.marker !== undefined) MarkerSchema.parse(options.marker);
    return await this.#control(
      "GET",
      this.#url("/jobs", { limit: String(limit), marker: options.marker }),
      200,
      async (_response, text) => {
        const page = z.object({ JobList: z.array(GlacierJobSchema).max(limit), Marker: MarkerSchema.nullable() })
          .passthrough().parse(JSON.parse(await text()));
        return { jobs: page.JobList, marker: page.Marker };
      },
      options,
    );
  }
  /** Inspect pending, failed, or completed jobs without polling or interpreting failure as output. */
  async describeJob(id: string, options: GlacierOperationOptionsType = {}): Promise<GlacierJobType> {
    IdSchema.parse(id);
    return await this.#control("GET", this.#url(`/jobs/${encode(id)}`), 200, async (_response, text) => {
      const job = GlacierJobSchema.parse(JSON.parse(await text()));
      if (job.JobId !== id) throw new TypeError("Glacier returned a different job identity.");
      return job;
    }, options);
  }
  /** Explicit potentially billable retrieval. Starting twice can create two jobs; never automatically replayed. */
  async startArchiveJob(
    id: string,
    options: GlacierOperationOptionsType & {
      readonly tier?: "Bulk" | "Standard" | "Expedited";
      readonly start?: number;
      readonly end?: number;
      readonly archiveSize?: number;
    } = {},
  ): Promise<GlacierReceiptType> {
    IdSchema.parse(id);
    const tier = z.enum(["Bulk", "Standard", "Expedited"]).parse(options.tier ?? "Standard");
    let selected: string | undefined;
    if (options.start !== undefined || options.end !== undefined) {
      const start = SizeSchema.parse(options.start);
      const end = SizeSchema.parse(options.end);
      const size = SizeSchema.positive().parse(options.archiveSize);
      if (
        end < start || end >= size || start % GLACIER_MIB !== 0 || ((end + 1) % GLACIER_MIB !== 0 && end !== size - 1)
      ) throw new RangeError("Archive retrieval requires MiB boundaries or the declared actual archive tail.");
      selected = `${start}-${end}`;
    }
    return await this.#startJob({
      Type: "archive-retrieval",
      ArchiveId: id,
      Tier: tier,
      ...(selected === undefined ? {} : { RetrievalByteRange: selected }),
    }, options);
  }
  /** Explicit historical inventory snapshot, not a strongly consistent archive directory. Pagination creates another job. */
  async startInventoryJob(
    options: GlacierOperationOptionsType & {
      readonly marker?: string;
      readonly limit?: number;
      readonly format?: "JSON" | "CSV";
    } = {},
  ): Promise<GlacierReceiptType> {
    const format = z.enum(["JSON", "CSV"]).parse(options.format ?? "JSON");
    if (options.marker !== undefined) MarkerSchema.parse(options.marker);
    if (options.limit !== undefined) SizeSchema.positive().parse(options.limit);
    return await this.#startJob({
      Type: "inventory-retrieval",
      Format: format,
      InventoryRetrievalParameters: {
        ...(options.marker === undefined ? {} : { Marker: options.marker }),
        ...(options.limit === undefined ? {} : { Limit: String(options.limit) }),
      },
    }, options);
  }
  /** JSON admission and byte ceiling precede signing/credentials. */
  async #startJob(
    value: Readonly<Record<string, unknown>>,
    options: GlacierOperationOptionsType,
  ): Promise<GlacierReceiptType> {
    const body = this.#image(new TextEncoder().encode(JSON.stringify(value)));
    return await this.#control(
      "POST",
      this.#url("/jobs"),
      202,
      (response) => this.#receipt(response, "x-amz-job-id"),
      options,
      new Headers({ "content-type": "application/json" }),
      body,
      "job initiation",
    );
  }
  /** Bounded single-request archive publication. Persist its opaque ID; identical bytes need not identify the same archive. */
  async uploadArchive(
    bytes: Uint8Array,
    options: GlacierOperationOptionsType & { readonly description?: string } = {},
  ): Promise<GlacierReceiptType> {
    const captured = operation(options);
    const note = description(options.description);
    const image = this.#image(bytes, GLACIER_LIMITS.maxPartBytes);
    captured.signal?.throwIfAborted();
    const headers = new Headers({
      "content-type": "application/octet-stream",
      "x-amz-sha256-tree-hash": await treeImage(image, this.#subtle),
    });
    if (note !== undefined) headers.set("x-amz-archive-description", note);
    return await this.#control(
      "POST",
      this.#url("/archives"),
      201,
      (response) => {
        if (
          HashSchema.parse(response.headers.get("x-amz-sha256-tree-hash")) !== headers.get("x-amz-sha256-tree-hash")
        ) throw new TypeError("Glacier acknowledged a different archive checksum.");
        return this.#receipt(response, "x-amz-archive-id");
      },
      captured,
      headers,
      image,
      "archive upload",
    );
  }
  /** Explicit idempotent deletion. It can interfere with pending retrievals and is never preview cleanup. */
  async deleteArchive(id: string, options: GlacierOperationOptionsType = {}): Promise<void> {
    IdSchema.parse(id);
    await this.#control("DELETE", this.#url(`/archives/${encode(id)}`), 204, () => undefined, options);
  }
  /** Initiation allocates native upload state. A lost receipt is unknown and is never retried implicitly. */
  async createUpload(
    size: number,
    options: GlacierOperationOptionsType & { readonly description?: string } = {},
  ): Promise<GlacierReceiptType & GlacierUploadType> {
    partSize(size);
    const note = description(options.description);
    const headers = new Headers({ "x-amz-part-size": String(size) });
    if (note !== undefined) headers.set("x-amz-archive-description", note);
    return await this.#control(
      "POST",
      this.#url("/multipart-uploads"),
      201,
      (response) => ({ ...this.#receipt(response, "x-amz-multipart-upload-id"), partSize: size }),
      options,
      headers,
      undefined,
      "multipart initiation",
    );
  }
  /** One upload page; completed IDs disappear and disappearance does not recover an archive receipt. */
  async listUploadsPage(
    options: GlacierOperationOptionsType & { readonly marker?: string; readonly limit?: number } = {},
  ): Promise<GlacierUploadsType> {
    const limit = z.number().int().min(1).max(1000).parse(options.limit ?? 1000);
    if (options.marker !== undefined) MarkerSchema.parse(options.marker);
    return await this.#control(
      "GET",
      this.#url("/multipart-uploads", { limit: String(limit), marker: options.marker }),
      200,
      async (_response, text) => {
        const page = z.object({
          UploadsList: z.array(z.object({ MultipartUploadId: IdSchema, PartSizeInBytes: SizeSchema }).passthrough())
            .max(limit),
          Marker: MarkerSchema.nullable(),
        }).passthrough().parse(JSON.parse(await text()));
        return {
          uploads: page.UploadsList.map((value) => ({
            id: value.MultipartUploadId,
            partSize: partSize(value.PartSizeInBytes),
          })),
          marker: page.Marker,
        };
      },
      options,
    );
  }
  /** Exact native part page, retaining sparse extents. This does not acknowledge a contiguous transfer offset. */
  async listPartsPage(
    upload: GlacierUploadType,
    options: GlacierOperationOptionsType & { readonly marker?: string; readonly limit?: number } = {},
  ): Promise<GlacierPartsType> {
    const captured = GlacierUploadSchema.parse(upload);
    partSize(captured.partSize);
    const limit = z.number().int().min(1).max(1000).parse(options.limit ?? 1000);
    if (options.marker !== undefined) MarkerSchema.parse(options.marker);
    return await this.#control(
      "GET",
      this.#url(`/multipart-uploads/${encode(captured.id)}`, { limit: String(limit), marker: options.marker }),
      200,
      async (_response, text) => {
        const page = z.object({
          MultipartUploadId: IdSchema,
          PartSizeInBytes: SizeSchema,
          Parts: z.array(z.object({ RangeInBytes: z.string(), SHA256TreeHash: HashSchema }).passthrough()).max(limit),
          Marker: MarkerSchema.nullable(),
        }).passthrough().parse(JSON.parse(await text()));
        if (page.MultipartUploadId !== captured.id || page.PartSizeInBytes !== captured.partSize) {
          throw new TypeError(
            "Glacier multipart scope changed.",
          );
        }
        const parts = page.Parts.map((value) => {
          const fields = value.RangeInBytes.split("-");
          if (fields.length !== 2) throw new TypeError("Malformed native part range.");
          const start = decimal(fields[0]!);
          const end = decimal(fields[1]!);
          if (
            start % captured.partSize !== 0 || end < start || end - start + 1 > captured.partSize
          ) throw new RangeError("Malformed native part extent.");
          return { start, end, treeHash: value.SHA256TreeHash };
        });
        if (new Set(parts.map((part) => part.start)).size !== parts.length) {
          throw new TypeError(
            "Duplicate native part extent.",
          );
        }
        return { parts, marker: page.Marker };
      },
      options,
    );
  }
  /** Reconcile every bounded page; marker cycles or duplicate extents fail rather than inventing resumability. */
  async listParts(
    upload: GlacierUploadType,
    options: GlacierOperationOptionsType & { readonly maxPages: number },
  ): Promise<readonly GlacierPartType[]> {
    const captured = GlacierUploadSchema.parse(upload);
    partSize(captured.partSize);
    const requestOptions = operation(options);
    const maxPages = z.number().int().min(1).max(10000).parse(options.maxPages);
    const parts: GlacierPartType[] = [];
    const markers = new Set<string>();
    let marker: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const result = await this.listPartsPage(captured, {
        ...requestOptions,
        ...(marker === undefined ? {} : { marker }),
      });
      parts.push(...result.parts);
      if (parts.length > GLACIER_LIMITS.maxParts || new Set(parts.map((part) => part.start)).size !== parts.length) {
        throw new TypeError("Multipart listing exceeded its bounds or repeated extents.");
      }
      if (result.marker === null) return parts.sort((a, b) => a.start - b.start);
      if (markers.has(result.marker)) throw new TypeError("Multipart listing repeated its marker.");
      markers.add(result.marker);
      marker = result.marker;
    }
    throw new RangeError("Multipart listing exhausted its page budget.");
  }
  /** Replacing the same immutable part is native-idempotent. Parts may be sparse; completion validates all coverage. */
  async uploadPart(
    upload: GlacierUploadType,
    start: number,
    bytes: Uint8Array,
    options: GlacierOperationOptionsType = {},
  ): Promise<GlacierPartType> {
    const requestOptions = operation(options);
    const captured = GlacierUploadSchema.parse(upload);
    partSize(captured.partSize);
    SizeSchema.parse(start);
    const image = this.#image(bytes, captured.partSize);
    if (
      start % captured.partSize !== 0 || image.length === 0 || image.length > captured.partSize ||
      start / captured.partSize >= GLACIER_LIMITS.maxParts || image.length - 1 > Number.MAX_SAFE_INTEGER - start
    ) throw new RangeError("Part extent violates the fixed upload layout.");
    requestOptions.signal?.throwIfAborted();
    const treeHash = await treeImage(image, this.#subtle);
    const end = start + image.length - 1;
    const headers = new Headers({
      "content-type": "application/octet-stream",
      "content-range": `bytes ${start}-${end}/*`,
      "x-amz-sha256-tree-hash": treeHash,
    });
    return await this.#control(
      "PUT",
      this.#url(`/multipart-uploads/${encode(captured.id)}`),
      204,
      (response) => {
        if (HashSchema.parse(response.headers.get("x-amz-sha256-tree-hash")) !== treeHash) {
          throw new TypeError(
            "Glacier acknowledged a different part checksum.",
          );
        }
        return { start, end, treeHash };
      },
      requestOptions,
      headers,
      image,
    );
  }
  /** Completion is sent once. Callers may explicitly retry identical receipts promptly; AWS documents no durable retry window. */
  async completeUpload(
    upload: GlacierUploadType,
    parts: readonly GlacierPartType[],
    size: number,
    options: GlacierOperationOptionsType = {},
  ): Promise<GlacierReceiptType> {
    const requestOptions = operation(options);
    const captured = GlacierUploadSchema.parse(upload);
    requestOptions.signal?.throwIfAborted();
    const treeHash = await glacierMultipartHash(captured, parts, size, this.#subtle);
    return await this.#control(
      "POST",
      this.#url(`/multipart-uploads/${encode(captured.id)}`),
      201,
      (response) => this.#receipt(response, "x-amz-archive-id"),
      requestOptions,
      new Headers({ "x-amz-archive-size": String(size), "x-amz-sha256-tree-hash": treeHash }),
      undefined,
      "multipart completion",
    );
  }
  /** Explicitly discard unfinished multipart state. The caller must settle its concurrent part requests first. */
  async abortUpload(upload: GlacierUploadType, options: GlacierOperationOptionsType = {}): Promise<void> {
    const captured = GlacierUploadSchema.parse(upload);
    partSize(captured.partSize);
    await this.#control(
      "DELETE",
      this.#url(`/multipart-uploads/${encode(captured.id)}`),
      204,
      () => undefined,
      options,
    );
  }
  /** Read a bounded exact extent relative to a completed job's output. Does not initiate retrieval or poll. */
  async readOutput(
    job: GlacierJobType,
    offset: number,
    length: number,
    options: GlacierOperationOptionsType & { readonly expectedTreeHash?: string; readonly requireChecksum?: boolean } =
      {},
  ): Promise<{ readonly bytes: Uint8Array; readonly checksum: "none" | "service" | "caller" }> {
    const requestOptions = operation(options);
    const requireChecksum = options.requireChecksum === undefined ? false : z.boolean().parse(options.requireChecksum);
    const expectedInput = options.expectedTreeHash;
    const snapshot = GlacierJobSchema.parse(job);
    if (!snapshot.Completed || snapshot.StatusCode !== "Succeeded") {
      throw new TypeError("Glacier output requires a successfully completed job.");
    }
    const size = outputSize(snapshot);
    assertExtent(size, offset, length);
    if (length > this.#max) throw new RangeError("Output extent exceeds the configured materialization ceiling.");
    const expected = expectedInput === undefined ? undefined : HashSchema.parse(expectedInput);
    requestOptions.signal?.throwIfAborted();
    if (length === 0) {
      if (requireChecksum || expected !== undefined) {
        throw new TypeError("A local empty read supplies no remote checksum evidence.");
      }
      return { bytes: new Uint8Array(), checksum: "none" };
    }
    const eligible = checksumScope(snapshot, offset, length);
    if (requireChecksum && expected === undefined && !eligible) {
      throw new TypeError("This job and output extent are not eligible for a service tree checksum.");
    }
    const whole = offset === 0 && length === size;
    const headers = new Headers();
    if (!whole) headers.set("range", `bytes=${offset}-${offset + length - 1}`);
    const response = await this.#send(
      "GET",
      this.#url(`/jobs/${encode(snapshot.JobId)}/output`),
      headers,
      undefined,
      requestOptions,
      true,
      () => {},
    );
    // Header admission precedes reader acquisition. The owner retires an unused
    // body on every refusal, including a proxy that ignores or changes Range.
    let admitted = false;
    try {
      if (response.status !== (whole ? 200 : 206)) throw new GlacierError(response);
      const encoding = response.headers.get("content-encoding");
      if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
        throw new TypeError("Encoded Glacier output cannot preserve byte offsets.");
      }
      if (!whole && response.headers.get("content-range") !== `bytes ${offset}-${offset + length - 1}/${size}`) {
        throw new TypeError("Glacier output Content-Range differs from the requested job extent.");
      }
      if (whole && response.headers.has("content-range")) {
        throw new TypeError("A complete Glacier output cannot report a partial Content-Range.");
      }
      const declared = response.headers.get("content-length");
      if (declared !== null && decimal(declared) !== length) {
        throw new TypeError("Glacier output Content-Length differs from the requested extent.");
      }
      const reported = response.headers.get("x-amz-sha256-tree-hash");
      if (reported !== null && !eligible) {
        throw new TypeError("A service tree checksum is not applicable to this job and output extent.");
      }
      const service = reported === null ? undefined : HashSchema.parse(reported);
      if (requireChecksum && expected === undefined && service === undefined) {
        throw new TypeError("This output extent has no applicable checksum evidence.");
      }
      admitted = true;
      const bytes = await outputBytes(response, length, requestOptions.signal);
      if (expected !== undefined || service !== undefined) {
        const actual = await treeImage(bytes, this.#subtle);
        if ((expected !== undefined && actual !== expected) || (service !== undefined && actual !== service)) {
          throw new TypeError("Glacier output tree checksum mismatch.");
        }
      }
      requestOptions.signal?.throwIfAborted();
      return { bytes, checksum: expected !== undefined ? "caller" : service !== undefined ? "service" : "none" };
    } catch (reason) {
      if (!admitted) await close(response.body === null ? [] : [() => response.body!.cancel(reason)], [reason]);
      throw reason;
    }
  }
  /** Describe once, then borrow completed finite output. Identity is stable; availability can expire after completion. */
  async openOutput(id: string, options: GlacierOperationOptionsType = {}): Promise<GlacierOutputSourceType> {
    const job = await this.describeJob(id, options);
    if (!job.Completed || job.StatusCode !== "Succeeded") throw new TypeError("Glacier output is pending or failed.");
    const size = outputSize(job);
    return Object.freeze({
      size,
      identity: `glacier:${this.#endpoint.href}:${this.#prefix}:${encode(id)}`,
      stability: "provider" as const,
      job: Object.freeze(job),
      archiveOffset: job.Action === "ArchiveRetrieval"
        ? job.RetrievalByteRange == null ? 0 : decimal(job.RetrievalByteRange.split("-")[0]!)
        : null,
      read: async (offset: number, length: number, read: GlacierOperationOptionsType = {}) =>
        (await this.readOutput(job, offset, length, read)).bytes,
    });
  }
}

/** Construct a native scoped client without connecting or reading credentials. */
export function createGlacierClient(options: GlacierOptionsType): GlacierClient {
  return new GlacierClient(options);
}

export {
  GLACIER_LIMITS,
  GLACIER_MIB,
  GlacierCredentialsSchema,
  GlacierJobSchema,
  GlacierPartSchema,
  GlacierUploadSchema,
  GlacierVaultSchema,
} from "./schema.ts";
export type {
  GlacierCredentialsType,
  GlacierJobType,
  GlacierPartType,
  GlacierUploadType,
  GlacierVaultType,
} from "./schema.ts";

export type {
  GlacierCredentialSourceType,
  GlacierOperationOptionsType,
  GlacierOptionsType,
  GlacierOutputSourceType,
  GlacierPartsType,
  GlacierReceiptType,
  GlacierUploadsType,
} from "./types.ts";

export { GlacierError, GlacierPublicationError } from "./error.ts";

export { glacierMultipartHash, glacierTreeHash } from "./hash.ts";
