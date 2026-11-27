/**
 * Item, file, upload and part types for the Box client.
 *
 * @module
 */
import type { FetchType, RequestPolicyType } from "../../request.ts";

/** Native items retain IDs and kinds instead of being projected into portable paths. */
export interface BoxItemType {
  readonly id: string;
  readonly kind: "file" | "folder" | "web_link";
  readonly name: string;
  readonly size?: number;
  /** Legacy provider checksum; not collision-resistant content authentication. */
  readonly sha1?: string;
  /** Native opaque metadata condition. Do not strengthen it into an HTTP representation validator. */
  readonly etag?: string;
  readonly versionId?: string;
  readonly parentId?: string;
}

/** Stored-file metadata is different from a folder or web link. */
export interface BoxFileType extends BoxItemType {
  readonly kind: "file";
  readonly size: number;
  readonly versionId: string;
}

/** A specific retained version belongs to the requested file route. Retention remains provider-owned. */
export interface BoxVersionType {
  readonly id: string;
  readonly size: number;
  readonly sha1?: string;
}

/** OAuth, account selection and refresh belong to the caller, never a capability redirect. */
export interface BoxOptionsType {
  readonly token: (url: URL, signal?: AbortSignal) => string | Promise<string>;
  readonly fetch?: FetchType;
  readonly endpoint?: string | URL;
  readonly uploadEndpoint?: string | URL;
  readonly asUser?: string;
  /** Exact origins to which server-supplied session endpoints may grant OAuth. Default: configured upload origin only. */
  readonly uploadOrigins?: readonly string[];
  /** Exact origins for signed file capabilities. Default empty; no implicit Box suffix trust. */
  readonly downloadOrigins?: readonly string[];
  readonly allowHttp?: boolean;
  readonly request?: RequestPolicyType;
  readonly maxBytes?: number;
  readonly maxPages?: number;
  readonly maxEntries?: number;
  readonly maxParts?: number;
}

/** Creation names are literal provider names. Replacement uses a stable native ID. */
export type BoxTargetType =
  | Readonly<{ kind: "create"; folderId: string; name: string }>
  | Readonly<{ kind: "replace"; fileId: string; ifMatch?: string }>;

/** Native marker pages do not establish a directory snapshot. */
export interface BoxPageType {
  readonly entries: readonly BoxItemType[];
  readonly nextMarker?: string;
}

/** Download is pinned to a selected native version and transfers stream ownership. */
export interface BoxDownloadType {
  readonly fileId: string;
  readonly version: BoxVersionType;
  readonly bytes: ReadableStream<Uint8Array>;
}

/** Byte ranges retain ordinary EOF clamping; no range digest proof is implied. */
export interface BoxReadOptionsType {
  readonly versionId?: string;
  readonly at?: number;
  readonly length?: number;
  readonly signal?: AbortSignal;
}

/** Caller-retained session context contains its fixed source size and exact admitted endpoints. */
export interface BoxUploadType {
  readonly id: string;
  readonly size: number;
  readonly partSize: number;
  readonly totalParts: number;
  readonly expires: string;
  readonly target: BoxTargetType;
  readonly endpoint: string;
}

/** A part receipt acknowledges one extent, not a contiguous prefix or published file. */
export interface BoxPartType {
  readonly id: string;
  readonly offset: number;
  readonly size: number;
  readonly sha1: string;
}

/** Processing counts do not identify which extents are present. */
export interface BoxUploadStatusType {
  readonly upload: BoxUploadType;
  readonly processedParts: number;
}

/** Offset pagination can contain sparse positions; offset/total are provider item positions. */
export interface BoxPartsPageType {
  readonly parts: readonly BoxPartType[];
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
}

/** HTTP 202 is an explicit pending commit, never a fabricated file receipt. */
export type BoxCommitType =
  | Readonly<{ complete: false; retryAfterSeconds: number }>
  | Readonly<{ complete: true; file: BoxFileType }>;
