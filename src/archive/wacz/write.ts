/**
 * Write a WACZ 1.1.1 file as a stream.
 *
 * @module
 */
import { Sha256 } from "../../hash.ts";
import { createZipStream, type ZipWriteEntryType, type ZipWriteOptionsType } from "../zip/write.ts";
import { type CdxjInputType, createCdxj } from "./cdxj.ts";
import type { WaczPageType, WaczResourceType } from "./mod.ts";

/** One file to place in the WACZ. */
export interface WaczFileType {
  /** File name. For `warcs` this is the name under `archive/`; for `files` it is the full path. */
  readonly name: string;
  /** File bytes. A stream is read once, when the ZIP writer reaches it. */
  readonly source: Uint8Array | ReadableStream<Uint8Array>;
  /** Exact size, when known. A stream with a wrong size errors the output. */
  readonly size?: number;
}

/** What to put in the WACZ. */
export interface WaczWriteInputType {
  /** WARC files for `archive/`. Names must end in `.warc` or `.warc.gz`. At least one is required. */
  readonly warcs: readonly WaczFileType[];
  /** Pages for `pages/pages.jsonl`. At least one is required for replay tools to show a start page. */
  readonly pages: readonly WaczPageType[];
  /**
   * The CDXJ index for `indexes/index.cdxj`: ready CDXJ text, or records that
   * `createCdxj` sorts and formats.
   */
  readonly index: string | Iterable<CdxjInputType>;
  /** Extra files, listed in `datapackage.json`. They must not be under `archive/`, `indexes/` or `pages/`. */
  readonly files?: readonly WaczFileType[];
  readonly title?: string;
  readonly description?: string;
  readonly mainPageUrl?: string;
  readonly mainPageDate?: string;
  /** Defaults to `@okikio/opfs`. */
  readonly software?: string;
  /** Defaults to the time the manifest is written. */
  readonly created?: Date;
}

const encoder = new TextEncoder();

/** Returns lowercase hex. */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Wraps a file so its size and sha256 are recorded as the ZIP writer reads it.
 *
 * The manifest is written after every listed file, so by then each `onDone`
 * has run. Byte sources are hashed at once; stream sources are hashed chunk by
 * chunk, so a large WARC is never held in memory.
 */
function track(
  path: string,
  file: WaczFileType,
  onDone: (resource: WaczResourceType) => void,
): ZipWriteEntryType {
  const hash = new Sha256();
  if (file.source instanceof Uint8Array) {
    hash.update(file.source);
    onDone({
      name: path.slice(path.lastIndexOf("/") + 1),
      path,
      hash: `sha256:${toHex(hash.digest())}`,
      bytes: file.source.length,
    });
    return { name: path, source: file.source, size: file.source.length };
  }
  let bytes = 0;
  const source = file.source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        hash.update(chunk);
        bytes += chunk.length;
        controller.enqueue(chunk);
      },
      flush() {
        onDone({ name: path.slice(path.lastIndexOf("/") + 1), path, hash: `sha256:${toHex(hash.digest())}`, bytes });
      },
    }),
  );
  return { name: path, source, ...(file.size === undefined ? {} : { size: file.size }) };
}

/** Checks a file name segment: no slash, no dot segments, not empty. */
function assertName(name: string, label: string): void {
  if (name === "" || name.includes("/") || name === "." || name === "..") {
    throw new TypeError(`${label} name must be one path segment: ${name}.`);
  }
}

/**
 * Writes a WACZ file as a ZIP stream.
 *
 * WARC files are STORED, as WACZ requires, so readers can fetch one record by
 * range. Every file's size and sha256 go into `datapackage.json`, and
 * `datapackage-digest.json` holds the manifest's own sha256.
 *
 * Files are pulled in order: WARCs, extra files, index, pages, then the two
 * manifests. Stream sources are read once and never held whole.
 *
 * @example Package one `.warc.gz` with its index.
 * ```ts
 * import { createWarcStream } from "@okikio/opfs/archive/warc/write";
 * import { createWaczStream } from "@okikio/opfs/archive/wacz/write";
 * import type { CdxjInputType } from "@okikio/opfs/archive/wacz";
 *
 * const index: CdxjInputType[] = [];
 * const warc = new Uint8Array(await new Response(createWarcStream(records, {
 *   compression: "gzip",
 *   onRecord: (r) => r.targetUri && index.push({ url: r.targetUri, date: r.date, offset: r.offset, length: r.length, filename: "data.warc.gz" }),
 * })).arrayBuffer());
 *
 * const wacz = createWaczStream({
 *   warcs: [{ name: "data.warc.gz", source: warc }],
 *   index,
 *   pages: [{ url: "https://example.com/", ts: "2026-11-24T10:00:00Z" }],
 *   title: "Example",
 * });
 * await fs.writeFile("/example.wacz", wacz);
 * ```
 *
 * The ZIP writer is ZIP32 with STORED entries, so the file must stay under
 * 4 GiB and within the `options` limits (default 1 GiB in total, 64 MiB per
 * file). Raise `maxEntryBytes` and `maxArchiveBytes` for larger WARCs.
 */
export function createWaczStream(
  input: WaczWriteInputType,
  options: ZipWriteOptionsType = {},
): ReadableStream<Uint8Array> {
  if (input.warcs.length === 0) throw new TypeError("A WACZ needs at least one WARC file.");
  for (const warc of input.warcs) {
    assertName(warc.name, "WARC");
    if (!/\.warc(\.gz)?$/.test(warc.name)) {
      throw new TypeError(`WARC name must end in .warc or .warc.gz: ${warc.name}.`);
    }
  }
  for (const file of input.files ?? []) {
    if (/^(archive|indexes|pages)\//.test(file.name) || /^datapackage(-digest)?\.json$/.test(file.name)) {
      throw new TypeError(`${file.name} is reserved by the WACZ layout.`);
    }
    for (const part of file.name.split("/")) assertName(part, "File");
  }
  for (const page of input.pages) {
    if (typeof page.url !== "string" || typeof page.ts !== "string") throw new TypeError("Each page needs url and ts.");
  }
  const resources: WaczResourceType[] = [];
  const done = (resource: WaczResourceType) => void resources.push(resource);
  async function* entries(): AsyncGenerator<ZipWriteEntryType> {
    for (const warc of input.warcs) yield track(`archive/${warc.name}`, warc, done);
    for (const file of input.files ?? []) yield track(file.name, file, done);
    const index = typeof input.index === "string" ? input.index : createCdxj(input.index);
    yield track("indexes/index.cdxj", { name: "index.cdxj", source: encoder.encode(index) }, done);
    const pages = [
      JSON.stringify({ format: "json-pages-1.0", id: "pages", title: "All Pages" }),
      ...input.pages.map((page) => JSON.stringify(page)),
    ];
    yield track("pages/pages.jsonl", { name: "pages.jsonl", source: encoder.encode(`${pages.join("\n")}\n`) }, done);
    const expected = input.warcs.length + (input.files?.length ?? 0) + 2;
    // The ZIP writer reads each entry to its end before asking for the next.
    if (resources.length !== expected) throw new Error("A WACZ file was not fully written before its manifest.");
    const manifest = {
      profile: "data-package",
      wacz_version: "1.1.1",
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.description === undefined ? {} : { description: input.description }),
      created: (input.created ?? new Date()).toISOString(),
      software: input.software ?? "@okikio/opfs",
      ...(input.mainPageUrl === undefined ? {} : { mainPageUrl: input.mainPageUrl }),
      ...(input.mainPageDate === undefined ? {} : { mainPageDate: input.mainPageDate }),
      resources,
    };
    const manifestBytes = encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`);
    yield { name: "datapackage.json", source: manifestBytes, size: manifestBytes.length };
    const hash = new Sha256();
    hash.update(manifestBytes);
    const digest = encoder.encode(
      `${JSON.stringify({ path: "datapackage.json", hash: `sha256:${toHex(hash.digest())}` }, null, 2)}\n`,
    );
    yield { name: "datapackage-digest.json", source: digest, size: digest.length };
  }
  return createZipStream(entries(), options);
}
