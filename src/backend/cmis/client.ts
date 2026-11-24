/** Native CMIS 1.1 Browser Binding operations. Repository objects are not filesystem paths. @module */
import { toInteger } from "../../check.ts";
import { type JsonLimitsType, parseJson } from "../../json.ts";
import { isBytes, toRequestBytes, toView } from "../../bytes.ts";
import { sendRequest } from "../../request.ts";
import type { FetchType, RequestPolicyType } from "../../request.ts";
import { readResponse } from "../../response.ts";
import { collectBytes } from "../../stream.ts";

/** Finite materialized content policy; repository quotas are separate. */
export const CMIS_BUFFER_BYTES = 64 * 1024 * 1024;
/** Integer and decimal property values retain exact JSON numeric spelling as strings. Datetimes are safe epoch milliseconds. */
export type CmisScalarType = string | boolean | number;
/** Standard, non-succinct property. Null means unset; an empty multi-value list remains distinct. */
export interface CmisPropertyType {
  readonly id: string;
  readonly type: "id" | "string" | "uri" | "html" | "boolean" | "integer" | "decimal" | "datetime";
  readonly cardinality: "single" | "multi";
  readonly values: readonly CmisScalarType[] | null;
}
/** Native properties retain versions, change tokens, filing and checked-out state without path projection. */
export interface CmisObjectType {
  readonly id: string;
  readonly name: string;
  readonly baseType: string;
  readonly properties: Readonly<Record<string, CmisPropertyType>>;
}
/** Discovery URLs are inert data. They do not grant credential forwarding or replace configured endpoints. */
export interface CmisRepositoryType {
  readonly id: string;
  readonly root: string;
  readonly repositoryUrl: string;
  readonly rootUrl: string;
  readonly version: string;
  readonly contentUpdates: "anytime" | "pwconly" | "none";
}
/** One bounded offset page. Mutable repository changes can reorder later pages. */
export interface CmisPageType {
  readonly objects: readonly CmisObjectType[];
  readonly more: boolean;
  readonly next?: number;
  readonly total?: number;
}
/** Cancellation does not transfer ownership of Fetch or credential capabilities. */
export interface CmisOperationType {
  readonly signal?: AbortSignal;
}
/** Explicit paging prevents an unbounded repository traversal. */
export interface CmisListType extends CmisOperationType {
  readonly skip?: number;
  readonly limit?: number;
}
/** Versioning is an explicit native choice; repositories can refuse unsupported choices or permissions. */
export interface CmisCreateType extends CmisOperationType {
  readonly versioningState: "none" | "major" | "minor" | "checkedout";
  readonly mediaType?: string;
}
/** A native change token is an opaque mutation condition, not a content digest or read validator. */
export interface CmisReplaceType extends CmisOperationType {
  readonly changeToken: string;
  readonly mediaType?: string;
}
/** Exact caller-granted API endpoints. No repository/account discovery or cookie session is acquired. */
export interface CmisClientOptionsType {
  readonly repository: string;
  readonly repositoryUrl: string | URL;
  readonly rootUrl: string | URL;
  readonly credentials?: (url: URL, signal?: AbortSignal) => HeadersInit | undefined | Promise<HeadersInit | undefined>;
  readonly fetch?: FetchType;
  readonly policy?: RequestPolicyType;
  readonly allowHttp?: boolean;
  /** Defaults to 8 MiB, capped by CMIS_BUFFER_BYTES; applied before copying uploads and while reading payloads. */
  readonly maxBytes?: number;
}
/** Native error status and a sanitized exception category. Foreign transport errors retain their original identity. */
export class CmisError extends Error {
  readonly status: number;
  readonly exception: string | undefined;
  constructor(status: number, exception?: string) {
    super(`CMIS request failed with HTTP ${status}.`);
    this.name = "CmisError";
    this.status = status;
    this.exception = exception;
  }
}
/** A dispatched mutation lacks a complete validated receipt. Reconcile by object/folder ID; never blindly replay. */
export class CmisPublicationError extends Error {
  readonly outcome = "unknown";
  readonly operation: "createDocument" | "setContent";
  readonly target: string;
  constructor(operation: "createDocument" | "setContent", target: string, cause: unknown) {
    super("CMIS mutation has no complete success acknowledgement.", { cause });
    this.name = "CmisPublicationError";
    this.operation = operation;
    this.target = target;
  }
}

function text(value: unknown, maximum = 4096, empty = false): string {
  if (
    typeof value !== "string" || value.length > maximum || (!empty && value.length === 0) ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw new TypeError("Invalid CMIS text field.");
  }
  try {
    encodeURIComponent(value);
  } catch {
    throw new TypeError("Invalid CMIS text encoding.");
  }
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Numeric) {
    throw new TypeError("Invalid CMIS object response.");
  }
  return value as Record<string, unknown>;
}
/** Numeric tokens stay private and exact until their native property type determines interpretation. */
class Numeric {
  readonly raw: string;
  constructor(raw: string) {
    this.raw = raw;
  }
}
function count(value: unknown): number {
  if (!(value instanceof Numeric) || !/^(0|[1-9][0-9]*)$/u.test(value.raw)) throw new TypeError("Invalid CMIS count.");
  return toInteger(Number(value.raw), "CMIS integer");
}
function endpoint(value: string | URL, allowHttp: boolean): URL {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) || url.username || url.password ||
    url.hash || url.search
  ) {
    throw new TypeError("CMIS endpoint requires an explicit clean HTTP(S) URL.");
  }
  return url;
}
function property(id: string, input: unknown): CmisPropertyType {
  const data = record(input), type = data.type, cardinality = data.cardinality;
  if (
    data.id !== id ||
    !["id", "string", "uri", "html", "boolean", "integer", "decimal", "datetime"].includes(String(type)) ||
    (cardinality !== "single" && cardinality !== "multi")
  ) throw new TypeError("Invalid CMIS property declaration.");
  const raw = data.value;
  if (raw === undefined) throw new TypeError("CMIS property omits its value.");
  const values: CmisScalarType[] | null = raw === null ? null : [];
  if (values !== null) {
    if ((cardinality === "single" && Array.isArray(raw)) || (cardinality === "multi" && !Array.isArray(raw))) {
      throw new TypeError("CMIS property violates its cardinality.");
    }
    const entries = cardinality === "single" ? [raw] : raw as unknown[];
    if (entries.length > 4096) throw new RangeError("CMIS property exceeds its value budget.");
    for (const value of entries) {
      if (type === "boolean") {
        if (typeof value !== "boolean") throw new TypeError("Invalid CMIS boolean.");
        values.push(value);
      } else if (type === "integer" || type === "decimal" || type === "datetime") {
        if (!(value instanceof Numeric)) throw new TypeError("Invalid CMIS numeric property.");
        if (type === "integer" && !/^-?(0|[1-9][0-9]*)$/u.test(value.raw)) {
          throw new TypeError("Invalid CMIS integer property.");
        }
        if (type === "datetime") {
          if (!/^-?(0|[1-9][0-9]*)$/u.test(value.raw) || !Number.isSafeInteger(Number(value.raw))) {
            throw new RangeError("CMIS datetime exceeds exact epoch milliseconds.");
          }
          values.push(Number(value.raw));
        } else values.push(value.raw);
      } else {
        if (typeof value !== "string" || value.length > 524288) throw new TypeError("Invalid CMIS string property.");
        try {
          encodeURIComponent(value);
        } catch {
          throw new TypeError("Invalid CMIS property text encoding.");
        }
        values.push(value);
      }
    }
  }
  return Object.freeze({
    id,
    type: type as CmisPropertyType["type"],
    cardinality,
    values: values === null ? null : Object.freeze(values),
  });
}
function single(
  properties: Readonly<Record<string, CmisPropertyType>>,
  id: string,
  type: CmisPropertyType["type"],
): string {
  const entry = properties[id];
  if (
    entry?.type !== type || entry.cardinality !== "single" || entry.values?.length !== 1 ||
    typeof entry.values[0] !== "string"
  ) {
    throw new TypeError("CMIS object omits a required typed property.");
  }
  return text(entry.values[0]);
}
function object(value: unknown): CmisObjectType {
  const data = record(value), entries = Object.entries(record(data.properties));
  if (entries.length > 2048) throw new RangeError("CMIS object exceeds its property budget.");
  const properties: Record<string, CmisPropertyType> = Object.create(null);
  for (const [id, value] of entries) properties[text(id)] = property(id, value);
  return Object.freeze({
    id: single(properties, "cmis:objectId", "id"),
    name: single(properties, "cmis:name", "string"),
    baseType: single(properties, "cmis:baseTypeId", "id"),
    properties: Object.freeze(properties),
  });
}
/** Only an explicitly typed native version-series ID can bind a receipt that names another version object. */
function series(value: CmisObjectType): string | undefined {
  const entry = value.properties["cmis:versionSeriesId"];
  return entry === undefined || entry.values === null
    ? undefined
    : single(value.properties, "cmis:versionSeriesId", "id");
}

/** Limits for this service's JSON responses; see `parseJson`. */
const jsonLimits: JsonLimitsType = {
  label: "CMIS",
  maxLength: 8 * 1024 * 1024,
  maxTokens: 100_000,
  maxString: 524_288,
  maxScalar: 128,
  number: (raw) => new Numeric(raw),
};

/** A finite native client; borrowed Fetch and credentials are never disposed or discovered. */
export class CmisClient {
  readonly #repository: string;
  readonly #repositoryUrl: URL;
  readonly #rootUrl: URL;
  readonly #fetch: FetchType;
  readonly #credentials: CmisClientOptionsType["credentials"];
  readonly #policy: RequestPolicyType | undefined;
  readonly #max: number;
  constructor(options: CmisClientOptionsType) {
    this.#repository = text(options.repository);
    const allowHttp = options.allowHttp ?? false;
    this.#repositoryUrl = endpoint(options.repositoryUrl, allowHttp);
    this.#rootUrl = endpoint(options.rootUrl, allowHttp);
    this.#credentials = options.credentials;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    const policy = options.policy;
    this.#policy = policy === undefined ? undefined : { ...policy };
    this.#max = toInteger(options.maxBytes ?? 8 * 1024 * 1024, "CMIS integer", CMIS_BUFFER_BYTES);
  }
  #url(root: boolean, query: Readonly<Record<string, string>>): URL {
    const url = new URL(root ? this.#rootUrl : this.#repositoryUrl);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    url.searchParams.set("succinct", "false");
    return url;
  }
  async #send(
    url: URL,
    method: "GET" | "POST",
    signal?: AbortSignal,
    body?: FormData,
    dispatch?: () => void,
  ): Promise<Response> {
    signal?.throwIfAborted();
    return await sendRequest(async (attemptSignal) => {
      const supplied = await this.#credentials?.(new URL(url), attemptSignal);
      attemptSignal?.throwIfAborted();
      const headers = new Headers(supplied);
      for (const key of headers.keys()) {
        if (key !== "authorization") {
          throw new TypeError("CMIS credential capability may supply only authorization headers.");
        }
      }
      headers.set("accept-encoding", "identity");
      headers.set(
        "accept",
        method === "GET" && url.searchParams.get("cmisselector") === "content"
          ? "application/octet-stream"
          : "application/json",
      );
      return {
        input: url,
        init: {
          method,
          headers,
          redirect: "manual",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          ...(attemptSignal === undefined ? {} : { signal: attemptSignal }),
          ...(body === undefined ? {} : { body }),
        },
      };
    }, {
      fetch: async (input, init) => {
        dispatch?.();
        return await this.#fetch(input, init);
      },
      replayable: method === "GET",
      ...(signal === undefined ? {} : { signal }),
      ...(this.#policy === undefined ? {} : { policy: this.#policy }),
    });
  }
  async #value(response: Response, body: () => PromiseLike<string>, expected: number): Promise<unknown> {
    if (response.status !== expected) {
      // Native error messages may echo credentials or URLs. Keep only a recognized exception category.
      let exception: string | undefined;
      const raw = await body();
      try {
        const input = record(parseJson(raw, jsonLimits));
        if (
          typeof input.exception === "string" && [
            "constraint",
            "contentAlreadyExists",
            "filterNotValid",
            "invalidArgument",
            "nameConstraintViolation",
            "notSupported",
            "objectNotFound",
            "permissionDenied",
            "runtime",
            "storage",
            "streamNotSupported",
            "updateConflict",
            "versioning",
          ].includes(input.exception)
        ) {
          exception = input.exception;
        }
      } catch { /* HTTP status remains authoritative even when its diagnostic body is malformed. */ }
      throw new CmisError(response.status, exception);
    }
    return parseJson(await body(), jsonLimits);
  }
  async #control(response: Response, expected = 200): Promise<unknown> {
    return await readResponse(response, (body) => this.#value(response, body, expected));
  }
  /** Discovery describes the selected repository; returned endpoints never acquire automatic authority. */
  async repository(options: CmisOperationType = {}): Promise<CmisRepositoryType> {
    const signal = options.signal;
    const repositories = record(
      await this.#control(await this.#send(this.#url(false, { cmisselector: "repositoryInfo" }), "GET", signal)),
    );
    if (Object.keys(repositories).length !== 1 || !Object.hasOwn(repositories, this.#repository)) {
      throw new TypeError("CMIS repository response does not select exactly the configured repository.");
    }
    const data = record(repositories[this.#repository]);
    const capabilities = record(data.capabilities), updates = capabilities.capabilityContentStreamUpdatability;
    if (
      data.repositoryId !== this.#repository || data.cmisVersionSupported !== "1.1" ||
      !["anytime", "pwconly", "none"].includes(String(updates))
    ) {
      throw new TypeError("CMIS repository acknowledgement does not match this profile.");
    }
    return Object.freeze({
      id: this.#repository,
      root: text(data.rootFolderId),
      repositoryUrl: text(data.repositoryUrl),
      rootUrl: text(data.rootFolderUrl),
      version: "1.1",
      contentUpdates: updates as CmisRepositoryType["contentUpdates"],
    });
  }
  /** The object ID is opaque; a document version need not share an ID with its version series. */
  async get(id: string, options: CmisOperationType = {}): Promise<CmisObjectType> {
    id = text(id);
    const signal = options.signal;
    const result = object(
      await this.#control(await this.#send(this.#url(true, { objectId: id, cmisselector: "object" }), "GET", signal)),
    );
    if (result.id !== id) throw new TypeError("CMIS object acknowledgement identifies a different object.");
    return result;
  }
  /** List one folder page. Native hasMoreItems is not a snapshot or a stable continuation token. */
  async list(id: string, options: CmisListType = {}): Promise<CmisPageType> {
    id = text(id);
    const signal = options.signal,
      skip = toInteger(options.skip ?? 0, "CMIS integer"),
      limit = toInteger(options.limit ?? 100, "CMIS integer", 1000);
    if (limit === 0) throw new RangeError("CMIS page limit must be positive.");
    const data = record(
      await this.#control(
        await this.#send(
          this.#url(true, {
            objectId: id,
            cmisselector: "children",
            skipCount: String(skip),
            maxItems: String(limit),
            includePathSegment: "false",
          }),
          "GET",
          signal,
        ),
      ),
    );
    if (!Array.isArray(data.objects) || data.objects.length > limit || typeof data.hasMoreItems !== "boolean") {
      throw new TypeError("Invalid CMIS child page.");
    }
    const objects = data.objects.map((entry: unknown) => object(record(entry).object));
    if (data.hasMoreItems && objects.length === 0) throw new TypeError("CMIS child page does not advance.");
    if (new Set(objects.map((entry) => entry.id)).size !== objects.length) {
      throw new TypeError("CMIS child page repeats an object ID.");
    }
    return Object.freeze({
      objects: Object.freeze(objects),
      more: data.hasMoreItems,
      ...(data.hasMoreItems ? { next: toInteger(skip + objects.length, "CMIS integer") } : {}),
      ...(data.numItems === undefined || data.numItems === null ? {} : { total: count(data.numItems) }),
    });
  }
  /** Materialize one current original content stream. No version pinning, hash proof, range or rendition claim. */
  async read(id: string, options: CmisOperationType = {}): Promise<Uint8Array> {
    id = text(id);
    const signal = options.signal;
    const response = await this.#send(
      this.#url(true, { objectId: id, cmisselector: "content", download: "attachment" }),
      "GET",
      signal,
    );
    if (response.status !== 200) {
      await this.#control(response);
      throw new CmisError(response.status);
    }
    let size: number | undefined;
    try {
      const encoding = response.headers.get("content-encoding"), declared = response.headers.get("content-length");
      if (encoding !== null && encoding.toLowerCase() !== "identity") {
        throw new TypeError("CMIS content must use identity encoding.");
      }
      if (declared !== null) {
        if (!/^(0|[1-9][0-9]*)$/u.test(declared) || declared.length > 16) {
          throw new TypeError("Invalid CMIS content length.");
        }
        size = toInteger(Number(declared), "CMIS integer", this.#max);
      }
    } catch (reason) {
      return await readResponse(response, () => {
        throw reason;
      });
    }
    const bytes = response.body === null
      ? new Uint8Array()
      : await collectBytes(response.body, this.#max, signal, "read", id);
    if (size !== undefined && size !== bytes.byteLength) {
      throw new TypeError("CMIS content length differs from its complete body.");
    }
    signal?.throwIfAborted();
    return bytes;
  }
  #content(bytes: Uint8Array, mediaType: string): Blob {
    if (!isBytes(bytes)) throw new TypeError("CMIS content must be bytes.");
    const view = toView(bytes);
    toInteger(view.byteLength, "CMIS integer", this.#max);
    if (!/^[\x21-\x7e]+$/u.test(mediaType) || mediaType.length > 1024) throw new TypeError("Invalid CMIS media type.");
    return new Blob([toRequestBytes(view)], { type: mediaType });
  }
  /** Validate complete document receipts, rather than equating a successful status with the intended publication. */
  async #mutate(
    action: "createDocument" | "setContent",
    target: string,
    form: FormData,
    size: number,
    signal?: AbortSignal,
    name?: string,
    versionSeries?: string,
  ): Promise<CmisObjectType> {
    let dispatched = false, acknowledged = false;
    try {
      const response = await this.#send(this.#url(true, { objectId: target }), "POST", signal, form, () => {
        dispatched = true;
      });
      return await readResponse(response, async (body) => {
        const result = object(await this.#value(response, body, 201));
        if (
          result.baseType !== "cmis:document" ||
          single(result.properties, "cmis:contentStreamLength", "integer") !== String(size) ||
          (name !== undefined && result.name !== name) ||
          (action === "setContent" && result.id !== target &&
            (versionSeries === undefined || series(result) !== versionSeries))
        ) throw new TypeError("CMIS document receipt does not describe the intended content.");
        acknowledged = true;
        signal?.throwIfAborted();
        return result;
      });
    } catch (reason) {
      if (
        !dispatched || acknowledged ||
        (reason instanceof CmisError && reason.status >= 400 && reason.status < 500 && reason.status !== 408)
      ) throw reason;
      throw new CmisPublicationError(action, target, reason);
    }
  }
  /** Create an ordinary document. Caller chooses native versioning state; duplicate-name policy and permissions remain native. */
  async create(folder: string, name: string, bytes: Uint8Array, options: CmisCreateType): Promise<CmisObjectType> {
    folder = text(folder);
    name = text(name);
    const signal = options.signal, state = options.versioningState;
    signal?.throwIfAborted();
    if (!["none", "major", "minor", "checkedout"].includes(state)) {
      throw new TypeError("Invalid CMIS versioning state.");
    }
    const blob = this.#content(bytes, options.mediaType ?? "application/octet-stream");
    const form = new FormData();
    form.set("cmisaction", "createDocument");
    form.set("versioningState", state);
    form.set("succinct", "false");
    form.set("propertyId[0]", "cmis:objectTypeId");
    form.set("propertyValue[0]", "cmis:document");
    form.set("propertyId[1]", "cmis:name");
    form.set("propertyValue[1]", name);
    form.set("content", blob, name);
    return await this.#mutate("createDocument", folder, form, blob.size, signal, name);
  }
  /** Replace ordinary anytime-updatable content with a caller-owned change token. PWC-only repositories require a separate checkout profile. */
  async replace(id: string, bytes: Uint8Array, options: CmisReplaceType): Promise<CmisObjectType> {
    id = text(id);
    const signal = options.signal, token = text(options.changeToken);
    signal?.throwIfAborted();
    const blob = this.#content(bytes, options.mediaType ?? "application/octet-stream");
    const form = new FormData();
    form.set("cmisaction", "setContent");
    form.set("overwriteFlag", "true");
    form.set("changeToken", token);
    form.set("succinct", "false");
    form.set("content", blob, "content.bin");
    if ((await this.repository(signal === undefined ? {} : { signal })).contentUpdates !== "anytime") {
      throw new TypeError("CMIS repository does not advertise ordinary anytime content replacement.");
    }
    const current = await this.get(id, signal === undefined ? {} : { signal });
    if (current.baseType !== "cmis:document") throw new TypeError("CMIS content replacement requires a document.");
    const versionSeries = series(current);
    return await this.#mutate("setContent", id, form, blob.size, signal, undefined, versionSeries);
  }
}
/** Construct a client without acquiring credentials, opening a session or contacting the repository. */
export function createCmisClient(options: CmisClientOptionsType): CmisClient {
  return new CmisClient(options);
}
