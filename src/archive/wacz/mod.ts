/**
 * Open WACZ files: a ZIP of WARC files, CDXJ indexes, a page list and a
 * `datapackage.json` manifest (WACZ 1.1.1).
 *
 * | Module     | Owns                                                       |
 * | ---------- | ---------------------------------------------------------- |
 * | `mod.ts`   | `openWacz`: manifest, pages, indexes, WARC access, verify  |
 * | `cdxj.ts`  | CDXJ lines and SURT keys                                   |
 * | `write.ts` | `createWaczStream`, the writer (`archive/wacz/write`)      |
 *
 * ```text
 * example.wacz (ZIP)
 * ├── archive/data.warc.gz         STORED, so records can be read by offset
 * ├── indexes/index.cdxj           url, timestamp → filename, offset, length
 * ├── pages/pages.jsonl            pages to show first
 * ├── datapackage.json             every file's size and sha256
 * └── datapackage-digest.json      sha256 of datapackage.json
 * ```
 *
 * @module
 */
import { z } from "zod";
import { type ByteSourceType, createByteSource } from "../../source.ts";
import { Sha256 } from "../../hash.ts";
import { ArchiveBudget } from "../budget.ts";
import { invalid, unsupported } from "../error.ts";
import { openZip } from "../zip/mod.ts";
import type { ZipArchiveType, ZipEntryType, ZipOpenOptionsType } from "../zip/types.ts";
import { openWarc as openWarcFile, type WarcArchiveType, type WarcOpenOptionsType } from "../warc/mod.ts";
import { scanMember } from "../warc/gzip.ts";
import { type CdxjRecordType, parseCdxj } from "./cdxj.ts";
import { checkReplay } from "./verify.ts";
export { createCdxj, getSurt, getTimestamp, parseCdxj } from "./cdxj.ts";
export type { CdxjInputType, CdxjRecordType } from "./cdxj.ts";

/** One file listed in `datapackage.json`. */
export interface WaczResourceType {
  /** Path inside the ZIP, such as `archive/data.warc.gz`. */
  readonly path: string;
  /** `sha256:<hex>` digest of the file. */
  readonly hash: string;
  /** File size in bytes. */
  readonly bytes: number;
  /** Optional display name. */
  readonly name?: string;
}

/** `datapackage.json`. Unknown fields are kept. */
export interface WaczPackageType {
  readonly profile: "data-package";
  readonly wacz_version: string;
  readonly resources: readonly WaczResourceType[];
  readonly title?: string;
  readonly description?: string;
  readonly created?: string;
  readonly modified?: string;
  readonly software?: string;
  readonly mainPageUrl?: string;
  readonly mainPageDate?: string;
  readonly [field: string]: unknown;
}

/** One line of `pages/pages.jsonl` after the header line. */
export interface WaczPageType {
  /** Page URL. */
  readonly url: string;
  /** RFC 3339 capture time. */
  readonly ts: string;
  readonly title?: string;
  readonly id?: string;
  /** Text extracted from the page, for search. */
  readonly text?: string;
  /** Bytes of the page and its resources. */
  readonly size?: number;
  readonly [field: string]: unknown;
}

/** Result of {@link WaczArchiveType.verify}. */
export interface WaczVerificationType {
  /** True when nothing is missing and no check failed. */
  readonly valid: boolean;
  /** Failed checks, one sentence each. */
  readonly errors: readonly string[];
  /** Required WACZ parts that are absent: `archive/`, `indexes/`, `pages/pages.jsonl`. */
  readonly missing: readonly string[];
  /** Resources whose size and sha256 matched. */
  readonly checked: number;
  /** CDXJ lines whose WARC record matched them; see `checkReplay` in `./verify.ts`. */
  readonly records: number;
}

/** Options for {@link openWacz}. ZIP limits apply to every later read through this WACZ. */
export interface WaczOpenOptionsType extends ZipOpenOptionsType {
  /** Largest `datapackage.json`, pages or index file read as text. Default 16 MiB. */
  readonly maxTextBytes?: number;
}

/** An opened WACZ. It borrows the source and the ZIP reader. */
export interface WaczArchiveType {
  /** The ZIP reader, for files this API does not model. */
  readonly zip: ZipArchiveType;
  /** Parsed `datapackage.json`. */
  readonly package: WaczPackageType;
  /** WARC file names under `archive/`, without the folder. */
  readonly warcs: readonly string[];
  /** Reads `pages/<name>`, default `pages.jsonl`. The header line is skipped. */
  readPages(name?: string): Promise<WaczPageType[]>;
  /** Reads and parses every CDXJ file under `indexes/`, plain or gzip. ZipNum `.idx` files are skipped. */
  readIndex(): Promise<CdxjRecordType[]>;
  /** Opens `archive/<filename>` as a WARC. The file must be STORED in the ZIP. */
  openWarc(filename: string, options?: WarcOpenOptionsType): Promise<WarcArchiveType>;
  /**
   * Checks `datapackage-digest.json`, then every resource's size and sha256,
   * that every ZIP file is listed, and that the required parts exist. Reads
   * every file once.
   */
  verify(): Promise<WaczVerificationType>;
}

/** Zod schema for one `datapackage.json` resource. */
export const WaczResourceSchema: z.ZodType<WaczResourceType> = z.object({
  path: z.string().min(1),
  hash: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  name: z.string().optional(),
}).passthrough() as z.ZodType<WaczResourceType>;

/** Zod schema for `datapackage.json`. */
export const WaczPackageSchema: z.ZodType<WaczPackageType> = z.object({
  profile: z.literal("data-package"),
  wacz_version: z.string(),
  resources: z.array(WaczResourceSchema),
}).passthrough() as z.ZodType<WaczPackageType>;

/** Zod schema for `datapackage-digest.json`. */
export const WaczDigestSchema: z.ZodType<{ readonly path: string; readonly hash: string }> = z.object({
  path: z.string(),
  hash: z.string(),
}).passthrough();

/** Zod schema for one page line. */
export const WaczPageSchema: z.ZodType<WaczPageType> = z.object({
  url: z.string(),
  ts: z.string(),
}).passthrough() as z.ZodType<WaczPageType>;

/** Returns lowercase hex. */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A byte source over one STORED ZIP member.
 *
 * Every read goes through `zip.read`, so the WACZ's opening limits and signal
 * cover it. Only STORED members are addressable by offset without decoding.
 */
function toSource(zip: ZipArchiveType, entry: ZipEntryType): ByteSourceType {
  return {
    size: entry.size,
    ...(zip.source.stability === "unverified" ? {} : { stability: zip.source.stability }),
    ...(zip.source.identity === undefined ? {} : { identity: `${zip.source.identity}#${entry.name}` }),
    read: async (offset, length) => (await zip.read(entry.id, { offset, length })).bytes,
  };
}

/** Decodes a gzip file that may hold several members, as ZipNum `.cdx.gz` files do. */
async function gunzip(source: ByteSourceType, maximum: number): Promise<Uint8Array> {
  const budget = new ArchiveBudget(source, { maxDecodedBytes: maximum * 2, maxSourceBytes: source.size * 4 + 1024 });
  const parts: Uint8Array[] = [];
  let total = 0;
  let start = 0;
  while (start < source.size) {
    const found = await scanMember(budget, source.size, start, maximum - total + 1);
    if (found === undefined) throw invalid("Gzip index member is truncated or corrupt.");
    total += found.member.size;
    if (total > maximum) throw unsupported(`Index text exceeds ${maximum} bytes.`);
    parts.push(found.member.bytes);
    start = found.end;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * Opens a WACZ file.
 *
 * Reads the ZIP directory and `datapackage.json`. Pages, indexes and WARC
 * records are read only when you ask. Because WARC files inside a WACZ are
 * STORED, `openWarc(name).read(id)` reads one record without reading the rest
 * of the file, so this works over HTTP range reads too.
 *
 * The opening limits bound all later reads through this WACZ. Raise
 * `maxSourceBytes`, `maxDecodedBytes` and `maxRequests` for large collections.
 *
 * @example Find a capture and read its HTTP response.
 * ```ts
 * import { createBlobSource } from "@okikio/opfs/source";
 * import { openWacz } from "@okikio/opfs/archive/wacz";
 *
 * const wacz = await openWacz(createBlobSource(file));
 * const hit = (await wacz.readIndex()).find((record) => record.url === "https://example.com/");
 * if (hit) {
 *   const warc = await wacz.openWarc(hit.filename);
 *   const entry = warc.entries.find((entry) => entry.offset === hit.offset)!;
 *   const response = await warc.read(entry.id);
 * }
 * ```
 */
export async function openWacz(source: ByteSourceType, options: WaczOpenOptionsType = {}): Promise<WaczArchiveType> {
  const maxText = options.maxTextBytes ?? 16 * 1024 * 1024;
  const zip = await openZip(source, options);
  const files = zip.entries.filter((entry) => !entry.directory);
  const find = (name: string): ZipEntryType | undefined => files.find((entry) => entry.name === name);
  async function readText(entry: ZipEntryType): Promise<string> {
    if (entry.size > maxText) throw unsupported(`${entry.name} exceeds ${maxText} bytes.`);
    const bytes = (await zip.read(entry.id)).bytes;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw invalid(`${entry.name} is not valid UTF-8.`);
    }
  }
  const manifest = find("datapackage.json");
  if (manifest === undefined) throw invalid("WACZ has no datapackage.json.");
  const manifestText = await readText(manifest);
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    throw invalid("datapackage.json is not valid JSON.");
  }
  const checked = WaczPackageSchema.safeParse(parsed);
  if (!checked.success) throw invalid(`datapackage.json is not a WACZ data package: ${checked.error.message}`);
  const pkg = Object.freeze(checked.data);
  if (!/^1\./.test(pkg.wacz_version)) throw unsupported(`WACZ version ${pkg.wacz_version} is not supported.`);
  const warcs = Object.freeze(
    files.filter((entry) => entry.name.startsWith("archive/") && !entry.name.slice(8).includes("/"))
      .map((entry) => entry.name.slice(8)),
  );

  const archive: WaczArchiveType = Object.freeze({
    zip,
    package: pkg,
    warcs,
    async readPages(name = "pages.jsonl"): Promise<WaczPageType[]> {
      if (name.includes("/")) throw new RangeError("Page file name must not contain a slash.");
      const entry = find(`pages/${name}`);
      if (entry === undefined) throw invalid(`WACZ has no pages/${name}.`);
      const pages: WaczPageType[] = [];
      for (const [index, line] of (await readText(entry)).split("\n").entries()) {
        if (line.trim() === "") continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          throw invalid(`pages/${name} line ${index + 1} is not valid JSON.`);
        }
        // The first line is a header such as {"format":"json-pages-1.0",...}.
        if (index === 0 && typeof value === "object" && value !== null && "format" in value) continue;
        const page = WaczPageSchema.safeParse(value);
        if (!page.success) throw invalid(`pages/${name} line ${index + 1} needs url and ts.`);
        pages.push(Object.freeze(page.data));
      }
      return pages;
    },
    async readIndex(): Promise<CdxjRecordType[]> {
      const records: CdxjRecordType[] = [];
      for (const entry of files) {
        if (!entry.name.startsWith("indexes/")) continue;
        if (/\.(cdxj?|cdxj?\.gz)$/.test(entry.name) === false) continue;
        let text: string;
        if (entry.name.endsWith(".gz")) {
          // A STORED file is decoded by range. A deflated one is read whole first.
          const input = entry.method === 0 ? toSource(zip, entry) : createByteSource((await zip.read(entry.id)).bytes);
          const bytes = await gunzip(input, maxText);
          text = new TextDecoder().decode(bytes);
        } else {
          text = await readText(entry);
        }
        records.push(...parseCdxj(text));
      }
      return records;
    },
    async openWarc(filename: string, warcOptions: WarcOpenOptionsType = {}): Promise<WarcArchiveType> {
      const entry = find(`archive/${filename}`);
      if (entry === undefined) throw invalid(`WACZ has no archive/${filename}.`);
      if (entry.method !== 0 || entry.encrypted) {
        throw unsupported(
          `archive/${filename} is compressed or encrypted in the ZIP; WACZ requires STORED WARC files.`,
        );
      }
      return await openWarcFile(toSource(zip, entry), warcOptions);
    },
    async verify(): Promise<WaczVerificationType> {
      const errors: string[] = [];
      const missing: string[] = [];
      let count = 0;
      const digestEntry = find("datapackage-digest.json");
      if (digestEntry !== undefined) {
        let value: unknown;
        try {
          value = JSON.parse(await readText(digestEntry));
        } catch {
          value = undefined;
        }
        const digest = WaczDigestSchema.safeParse(value);
        const hash = new Sha256();
        hash.update(new TextEncoder().encode(manifestText));
        if (!digest.success || digest.data.path !== "datapackage.json") {
          errors.push("datapackage-digest.json does not name datapackage.json.");
        } else if (digest.data.hash !== `sha256:${toHex(hash.digest())}`) {
          errors.push("datapackage-digest.json does not match datapackage.json.");
        }
      }
      const listed = new Set<string>();
      for (const resource of pkg.resources) {
        if (listed.has(resource.path)) errors.push(`datapackage.json lists ${resource.path} twice.`);
        listed.add(resource.path);
        const entry = find(resource.path);
        if (entry === undefined) {
          errors.push(`datapackage.json lists ${resource.path}, which is not in the ZIP.`);
          continue;
        }
        if (entry.size !== resource.bytes) errors.push(`${resource.path} size does not match datapackage.json.`);
        if (!/^sha256:[0-9a-f]{64}$/i.test(resource.hash)) {
          errors.push(`${resource.path} hash is not sha256:<hex>.`);
          continue;
        }
        const hash = new Sha256();
        if (entry.method === 0) {
          const chunk = 1024 * 1024;
          for (let offset = 0; offset < entry.size; offset += chunk) {
            const length = Math.min(chunk, entry.size - offset);
            hash.update((await zip.read(entry.id, { offset, length, verify: offset + length === entry.size })).bytes);
          }
        } else {
          // A DEFLATED entry decodes from its start for any range, so read it once
          // instead of once per chunk. The ZIP reader's limits still bound the bytes.
          hash.update((await zip.read(entry.id, { verify: true })).bytes);
        }
        if (`sha256:${toHex(hash.digest())}` !== resource.hash.toLowerCase()) {
          errors.push(`${resource.path} sha256 does not match datapackage.json.`);
        } else if (entry.size === resource.bytes) count++;
      }
      for (const entry of files) {
        if (entry.name === "datapackage.json" || entry.name === "datapackage-digest.json") continue;
        if (!listed.has(entry.name)) errors.push(`${entry.name} is in the ZIP but not in datapackage.json.`);
        if (entry.name.startsWith("archive/") && entry.method !== 0) errors.push(`${entry.name} is not STORED.`);
      }
      if (warcs.length === 0) missing.push("archive/");
      if (!files.some((entry) => entry.name.startsWith("indexes/"))) missing.push("indexes/");
      if (find("pages/pages.jsonl") === undefined) missing.push("pages/pages.jsonl");
      const records = await checkReplay({
        readIndex: () => archive.readIndex(),
        readPages: () => archive.readPages(),
        openWarc: (filename) => archive.openWarc(filename),
        getWarc: (filename) => find(`archive/${filename}`),
      }, errors);
      return Object.freeze({
        valid: errors.length === 0 && missing.length === 0,
        errors: Object.freeze(errors),
        missing: Object.freeze(missing),
        checked: count,
        records,
      });
    },
  });
  return archive;
}
