/**
 * Option, condition, response and receipt types for the Netlify Blobs client.
 *
 * @module
 */
import type { NETLIFY_PROFILE } from "./client.ts";
import type { FetchType } from "../../request.ts";

/** One explicit grant for a negotiated capability. The account bearer is never sent to this URL. */
export interface NetlifyDataType {
  /** The final data request method, never an account API negotiation. */
  readonly method: "GET" | "PUT";
  /** Qualified original provider key; no filesystem normalization is performed. */
  readonly key: string;
}

/** Constructor values and callbacks are captured without reading environment variables or making requests. */
export interface NetlifyOptionsType {
  /** Exact reviewed SDK-wire admission; broader SDK or stable REST compatibility is not implied. */
  readonly profile: typeof NETLIFY_PROFILE;
  /** Borrowed Fetch must honor AbortSignal and must not retry mutations internally. */
  readonly fetch: FetchType;
  /** Explicit authority only: no path other than /, query, userinfo or fragment. */
  readonly api: string;
  /** Explicit account site identifier in the admitted ASCII profile. */
  readonly site: string;
  /** Application store name. The client adds the SDK's literal site: prefix. */
  readonly store: string;
  /** Visible-ASCII account bearer, confined to this API authority. */
  readonly token: string;
  /** Return literal true to permit this exact canonical signed URL; asynchronous decisions are refused. */
  readonly authorizeDataURL: (url: string, request: Readonly<NetlifyDataType>) => boolean;
  /** Explicit fixture grant; applies to API and separately authorized data URLs. Default false. */
  readonly allowHttp?: boolean;
  /** Default 1 MiB for a copied PUT or complete GET. */
  readonly maxBytes?: number;
  /** Default 64 KiB per negotiation/list JSON response. */
  readonly maxJsonBytes?: number;
  /** Default 32 KiB of response header names and values. */
  readonly maxHeaderBytes?: number;
  /** Default 2 KiB of encoded metadata header name plus value. Writes are outside this profile. */
  readonly maxMetadataBytes?: number;
  /** Default 1,000 entries across blobs and directories in one page. */
  readonly maxEntries?: number;
  /** Default 2 MiB of aggregate response bytes across this operation's requests. */
  readonly maxResponseBytes?: number;
  /** Default two concrete Fetch calls; no retries or automatic capability refresh. */
  readonly maxRequests?: number;
  /** Default 65,536 body read attempts across the operation, including empty chunks and EOF. */
  readonly maxReadSteps?: number;
  /** Default 30 seconds; aborts and joins the borrowed transport rather than abandoning its promise. */
  readonly timeoutMs?: number;
}

/** Per-operation borrowed cancellation; it never transfers ownership of the caller's controller. */
export interface NetlifyOperationType {
  /** Aborts owned Fetch/body work, then awaits retirement before settlement. */
  readonly signal?: AbortSignal;
}

/** Cache validation and cancellation for one complete bounded GET. */
export interface NetlifyGetOptionsType extends NetlifyOperationType {
  /** Cache validation only, not a revision guard. Sent only to the final capability URL. */
  readonly etag?: string;
}

/** Native single-page query; cursors and prefixes are serialized once with URLSearchParams. */
export interface NetlifyListOptionsType extends NetlifyOperationType {
  /** Exact bounded Unicode prefix, not a normalized directory path. */
  readonly prefix?: string;
  /** Request the native directories=true projection; omission and false leave it absent. */
  readonly directories?: boolean;
  /** Native opaque continuation token. No local iterator state or invented page-size parameter. */
  readonly cursor?: string;
}

/** Mutually exclusive create-only or opaque ETag-match conditions on the final data PUT. */
export type NetlifyConditionType =
  | {
    /** Create only when absent by sending If-None-Match: *. */
    readonly kind: "new";
  }
  | {
    /** Replace only the object matching the supplied ETag observation. */
    readonly kind: "match";
    /** Nonempty opaque provider ETag, sent as If-Match. */
    readonly etag: string;
  };

/** No metadata-writing option is exposed until Unicode interoperability is qualified. */
export interface NetlifyPutOptionsType extends NetlifyOperationType {
  /** Omission performs an unconditional PUT; conditions do not imply automatic replay safety. */
  readonly condition?: NetlifyConditionType;
}

/** Detached actual transport work; this is not provider-internal work or heap accounting. */
export interface NetlifyWorkType {
  /** Concrete Fetch invocations, never retry-policy estimates. */
  readonly requests: number;
  /** Observed response bytes, including a refused oversized chunk. */
  readonly responseBytes: number;
  /** Body read attempts, including empty chunks, EOF and failed reads. */
  readonly readSteps: number;
}

/** Bounded provider metadata; ETags are opaque observations, not authentication evidence. */
export interface NetlifyObservationType {
  /** Optional opaque response ETag; missing is not replaced by an invented identity. */
  readonly etag?: string;
  /** Strict bounded JSON data, without executable extension or string-map interpretation. */
  readonly metadata: unknown;
}

/** Only HEAD 200/404 are admitted. Size and ETag can both remain absent. */
export type NetlifyHeadType =
  | {
    /** The account API returned 404 for this metadata request. */
    readonly state: "absent";
    /** Requests and response reads completed by this operation. */
    readonly work: NetlifyWorkType;
  }
  | (NetlifyObservationType & {
    /** The account API returned metadata with status 200. */
    readonly state: "present";
    /** Optional declared object size; HEAD does not download bytes to measure it. */
    readonly size?: number;
    /** Requests and response reads completed by this operation. */
    readonly work: NetlifyWorkType;
  });

/** Absence, cache validation and owned full bytes are separate outcomes. */
export type NetlifyGetType =
  | {
    /** The final data request returned 404; negotiation failures reject instead. */
    readonly state: "absent";
    /** Requests and response reads completed by this operation. */
    readonly work: NetlifyWorkType;
  }
  | (NetlifyObservationType & {
    /** A GET with a supplied cache ETag returned 304; no object bytes are returned. */
    readonly state: "not-modified";
    /** Requests and response reads completed by this operation. */
    readonly work: NetlifyWorkType;
  })
  | (NetlifyObservationType & {
    /** The final data request returned 200 and the complete body passed admission. */
    readonly state: "present";
    /** Owned exact-length snapshot; a later operation cannot overwrite these bytes. */
    readonly bytes: Uint8Array;
    /** Measured downloaded byte count, independent of optional HEAD observations. */
    readonly size: number;
    /** Requests and response reads completed by this operation. */
    readonly work: NetlifyWorkType;
  });

/** One native page; later pages remain caller-owned explicit operations. */
export interface NetlifyPageType {
  /** JSON 200 page or native 404 store absence. */
  readonly state: "page" | "absent";
  /** Listed native identities can exceed this initial client's actionable ASCII key subset. */
  readonly blobs: readonly {
    /** Original provider key, preserved without filesystem normalization. */
    readonly key: string;
    /** Optional opaque ETag observed in this listing. */
    readonly etag?: string;
  }[];
  /** Native directory projection strings, not filesystem directory handles. */
  readonly directories: readonly string[];
  /** Opaque next_cursor; no stable source or resumable-upload claim follows from it. */
  readonly cursor?: string;
  /** Completed operation work. */
  readonly work: NetlifyWorkType;
}

/** A final conditional response observation; modified:false never proves the entire history was unchanged. */
export interface NetlifyPutType {
  /** The acknowledged native operation. */
  readonly operation: "put";
  /** Exact qualified original key. */
  readonly key: string;
  /** Final successful or condition-refused response, not proof about previous attempts. */
  readonly modified: boolean;
  /** Native final response status. */
  readonly status: number;
  /** Known copied input length, also retained on a conditional refusal. */
  readonly size: number;
  /** Optional success response ETag; condition refusals do not become write receipts. */
  readonly etag?: string;
  /** Work through acknowledgement and response retirement. */
  readonly work: NetlifyWorkType;
}

/** An unconditional removal acknowledgement, not a deleted-revision receipt. */
export interface NetlifyDeleteType {
  /** The acknowledged native operation. */
  readonly operation: "delete";
  /** Exact qualified original key. */
  readonly key: string;
  /** Accepted unconditional removal/already-absent acknowledgement. */
  readonly status: 200 | 204 | 404;
  /** Work through acknowledgement and response retirement. */
  readonly work: NetlifyWorkType;
}

/** An admitted mutation observation that remains available if later cleanup fails. */
export type NetlifyReceiptType = NetlifyPutType | NetlifyDeleteType;

/** Independent operation allowances; no byte limit substitutes for the request or read-step limit. */
export interface PolicyType {
  bytes: number;
  json: number;
  headers: number;
  metadata: number;
  entries: number;
  response: number;
  requests: number;
  reads: number;
  timeout: number;
}
