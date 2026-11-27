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
  /**
   * How the ZIP stores an extra file. Defaults to `"deflate"`.
   *
   * WARC files are always STORED, so this must be absent or `"store"` for
   * them: a CDXJ offset is a byte offset into the WARC, and a reader turns it
   * into a range of the WACZ only when the WARC bytes sit in the ZIP as they are.
   * Use `"store"` for an extra file that is already compressed.
   */
  readonly compression?: "store" | "deflate";
}

/** What to put in the WACZ. */
export interface WaczWriteInputType {
  /**
   * WARC files for `archive/`. Names must end in `.warc` or `.warc.gz`. At least one is required.
   *
   * An async iterable is read one file at a time, so the segments from
   * `createWarcSegments` can stream straight in while a crawl runs.
   */
  readonly warcs: readonly WaczFileType[] | AsyncIterable<WaczFileType>;
  /** Pages for `pages/pages.jsonl`. At least one is required for replay tools to show a start page. */
  readonly pages: readonly WaczPageType[];
  /**
   * The CDXJ index for `indexes/index.cdxj`: ready CDXJ text, or records that
   * `createCdxj` sorts and formats.
   *
   * The index is read after every WARC is written, so an array that an
   * `onRecord` callback fills while the WARCs stream is complete by then.
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
  compression: "store" | "deflate",
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
    return { name: path, source: file.source, size: file.source.length, compression };
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
  return { name: path, source, compression, ...(file.size === undefined ? {} : { size: file.size }) };
}

/** Checks a WARC file's name and that it is not asked to be compressed again. */
function assertWarc(warc: WaczFileType): void {
  assertName(warc.name, "WARC");
  if (!/\.warc(\.gz)?$/.test(warc.name)) throw new TypeError(`WARC name must end in .warc or .warc.gz: ${warc.name}.`);
  if (warc.compression !== undefined && warc.compression !== "store") {
    throw new TypeError(`WARC files are STORED in a WACZ so CDXJ offsets stay byte ranges: ${warc.name}.`);
  }
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
 * range. The index, the page list, the two manifests and extra files are
 * DEFLATED unless a file asks for `"store"`; JSON and CDXJ text usually shrink
 * to a small fraction. Every file's size and sha256 go into `datapackage.json`,
 * and `datapackage-digest.json` holds the manifest's own sha256.
 *
 * Files are pulled in order: WARCs, extra files, index, pages, then the two
 * manifests. Stream sources are read once and never held whole.
 *
 * @example Stream a crawl into a WACZ, one WARC segment at a time.
 * ```ts
 * import { createResponseRecord, createWarcSegments } from "@okikio/opfs/archive/warc/write";
 * import { createWaczStream } from "@okikio/opfs/archive/wacz/write";
 * import type { CdxjInputType } from "@okikio/opfs/archive/wacz";
 *
 * const index: CdxjInputType[] = [];
 * const warcs = createWarcSegments(captures.map((c) => createResponseRecord(c)), {
 *   maxSegmentBytes: 1024 ** 3,
 *   onRecord: (r) =>
 *     r.targetUri && index.push({
 *       url: r.targetUri, date: r.date, filename: r.filename, offset: r.offset, length: r.length,
 *       ...(r.status === undefined ? {} : { status: r.status }),
 *       ...(r.mime === undefined ? {} : { mime: r.mime }),
 *       ...(r.payloadDigest === undefined ? {} : { digest: r.payloadDigest }),
 *     }),
 * });
 * const wacz = createWaczStream(
 *   { warcs, index, pages: [{ url: "https://example.com/", ts: "2026-11-24T10:00:00Z" }], title: "Example" },
 *   { maxEntryBytes: 2 * 1024 ** 3, maxArchiveBytes: 64 * 1024 ** 3 },
 * );
 * await fs.writeFile("/example.wacz", wacz);
 * ```
 *
 * The defaults cap the file at 1 GiB in total and 64 MiB per file. Raise
 * `maxEntryBytes` and `maxArchiveBytes` for larger WARCs. ZIP64 is on, so the
 * caps may pass 4 GiB; ZIP64 fields appear only where a size or offset needs
 * them, and a small WACZ is plain ZIP32. Pass `zip64: false` to refuse ZIP64.
 */
export function createWaczStream(
  input: WaczWriteInputType,
  options: ZipWriteOptionsType = {},
): ReadableStream<Uint8Array> {
  const list = Array.isArray(input.warcs) ? input.warcs as readonly WaczFileType[] : undefined;
  if (list !== undefined) {
    if (list.length === 0) throw new TypeError("A WACZ needs at least one WARC file.");
    for (const warc of list) assertWarc(warc);
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
    let warcs = 0;
    const names = new Set<string>();
    for await (const warc of input.warcs) {
      assertWarc(warc);
      if (names.has(warc.name)) throw new TypeError(`Two WARC files are named ${warc.name}.`);
      names.add(warc.name);
      warcs++;
      yield track(`archive/${warc.name}`, warc, done, "store");
    }
    if (warcs === 0) throw new TypeError("A WACZ needs at least one WARC file.");
    for (const file of input.files ?? []) yield track(file.name, file, done, file.compression ?? "deflate");
    const index = typeof input.index === "string" ? input.index : createCdxj(input.index);
    yield track("indexes/index.cdxj", { name: "index.cdxj", source: encoder.encode(index) }, done, "deflate");
    const pages = [
      JSON.stringify({ format: "json-pages-1.0", id: "pages", title: "All Pages" }),
      ...input.pages.map((page) => JSON.stringify(page)),
    ];
    yield track(
      "pages/pages.jsonl",
      { name: "pages.jsonl", source: encoder.encode(`${pages.join("\n")}\n`) },
      done,
      "deflate",
    );
    const expected = warcs + (input.files?.length ?? 0) + 2;
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
    yield { name: "datapackage.json", source: manifestBytes, size: manifestBytes.length, compression: "deflate" };
    const hash = new Sha256();
    hash.update(manifestBytes);
    const digest = encoder.encode(
      `${JSON.stringify({ path: "datapackage.json", hash: `sha256:${toHex(hash.digest())}` }, null, 2)}\n`,
    );
    yield { name: "datapackage-digest.json", source: digest, size: digest.length, compression: "deflate" };
  }
  return createZipStream(entries(), { zip64: true, ...options });
}
