/**
 * Checks for Box IDs, names, hashes, items, endpoints and Retry-After values.
 *
 * Each helper takes one value from a caller or a response and returns it checked,
 * or throws. None of them does I/O.
 *
 * @module
 */
import type { BoxFileType, BoxItemType, BoxTargetType } from "./types.ts";
import { toInteger } from "../../check.ts";
import { encodeBase64 } from "@std/encoding/base64";
import { z } from "zod";

export const fields = "id,type,name,size,sha1,etag,file_version,parent";

export const ItemSchema = z.object({
  id: z.string().regex(/^\d{1,128}$/),
  type: z.enum(["file", "folder", "web_link"]),
  name: z.string().max(8192),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  sha1: z.string().regex(/^[a-fA-F0-9]{40}$/).optional(),
  etag: z.string().max(1024).optional(),
  file_version: z.object({ id: z.string().regex(/^\d{1,128}$/) }).optional(),
  parent: z.object({ id: z.string().regex(/^\d{1,128}$/) }).nullable().optional(),
});

export const PartSchema = z.object({
  part_id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha1: z.string().regex(/^[a-fA-F0-9]{40}$/),
});

/** IDs remain strings even if they exceed JavaScript's integer precision. */
export function id(value: string): string {
  if (typeof value !== "string" || !/^\d{1,128}$/.test(value)) throw new TypeError("Invalid Box ID.");
  return value;
}

/** Control characters and malformed Unicode cannot enter HTTP headers or provider names. */
export function text(value: string, label: string, max: number): string {
  if (typeof value !== "string" || !value || value.length > max) throw new TypeError(`Invalid Box ${label}.`);
  for (let at = 0; at < value.length; at++) {
    const code = value.charCodeAt(at);
    if (code <= 31 || code === 127) throw new TypeError(`Invalid Box ${label}.`);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++at);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(`Invalid Box ${label}.`);
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError(`Invalid Box ${label}.`);
  }
  return value;
}

/** A checksum is native compatibility evidence, not an authenticity primitive. */
export function sha1(value: string): string {
  if (typeof value !== "string" || !/^[a-fA-F0-9]{40}$/.test(value)) throw new TypeError("Invalid Box SHA-1 checksum.");
  return value.toLowerCase();
}

/** Digest wire encoding is base64 of the binary hash, never base64 of its hex spelling. */
export function digest(value: string): string {
  const hex = sha1(value);
  return `sha=${encodeBase64(Uint8Array.from({ length: 20 }, (_, at) => parseInt(hex.slice(at * 2, at * 2 + 2), 16)))}`;
}

/** Metadata wire optionals are mapped to absent public properties. */
export function item(value: unknown): BoxItemType {
  const data = ItemSchema.parse(value);
  return {
    id: data.id,
    kind: data.type,
    name: data.name,
    ...(data.size === undefined ? {} : { size: data.size }),
    ...(data.sha1 === undefined ? {} : { sha1: sha1(data.sha1) }),
    ...(data.etag === undefined ? {} : { etag: data.etag }),
    ...(data.file_version === undefined ? {} : { versionId: data.file_version.id }),
    ...(data.parent == null ? {} : { parentId: data.parent.id }),
  };
}

/** Only stored files with an explicit current version support selected-version reads. */
export function file(value: unknown, selected?: string): BoxFileType {
  const data = item(value);
  if (
    data.kind !== "file" || data.size === undefined || data.versionId === undefined ||
    selected !== undefined && selected !== data.id
  ) throw new TypeError("Box receipt requires the selected stored file and version.");
  return { ...data, kind: "file", size: data.size, versionId: data.versionId };
}

/** Snapshot nested targets before any token/hash await; names never become route segments. */
export function target(value: BoxTargetType): BoxTargetType {
  if (value.kind === "create") {
    const name = text(value.name, "file name", 255);
    if (name === "." || name === ".." || /[\\/]/u.test(name)) throw new TypeError("Invalid Box file name.");
    return { kind: "create", folderId: id(value.folderId), name };
  }
  if (value.kind !== "replace") throw new TypeError("Invalid Box upload target.");
  const ifMatch = value.ifMatch;
  return {
    kind: "replace",
    fileId: id(value.fileId),
    ...(ifMatch === undefined ? {} : { ifMatch: text(ifMatch, "native ETag", 1024) }),
  };
}

/** Explicit authorities admit credentials; URLs returned by a server do not enlarge this set. */
export function endpoint(value: string | URL, allowHttp: boolean): URL {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) || url.username || url.password ||
    url.search || url.hash || !url.pathname.endsWith("/")
  ) throw new TypeError("Invalid Box endpoint.");
  return url;
}

/** No wildcard, credentials, query, path suffix or fragment can masquerade as an origin. */
export function origins(values: readonly string[], allowHttp: boolean): ReadonlySet<string> {
  return new Set(values.map((value) => {
    const url = endpoint(`${value.replace(/\/$/u, "")}/`, allowHttp);
    if (url.pathname !== "/") throw new TypeError("Box origin must not contain a path.");
    return url.origin;
  }));
}

/** Retry-After is explicit finite native advice. The library never sleeps or retries automatically. */
export function retry(response: Response): number {
  const value = response.headers.get("retry-after");
  if (value === null || !/^\d{1,8}$/.test(value)) {
    throw new TypeError("Box pending receipt requires bounded Retry-After seconds.");
  }
  return toInteger(Number(value), "Box Retry-After", 86400);
}
