/**
 * Replay checks for a WACZ: does the index point at the records it claims?
 *
 * Hashes prove the files did not change. They do not prove a replay tool will
 * find anything: a CDXJ line can name the wrong offset, a page can have no
 * capture, and a status can disagree with the record. {@link checkReplay}
 * follows every CDXJ line into its WARC and checks what it finds there.
 *
 * ```text
 * CDXJ line ──► archive/<filename>  STORED? range inside the file? coordinates unique?
 *           └─► WARC record at offset  starts there? same length? response, resource or revisit?
 *                                      WARC-Target-URI = url? status, mime and digest agree?
 * pages.jsonl ──► every page url has a replayable CDXJ line
 * ```
 *
 * @module
 */
import { readHttpHead } from "../warc/http.ts";
import type { WarcArchiveType, WarcEntryType } from "../warc/mod.ts";
import type { CdxjRecordType } from "./cdxj.ts";
import type { WaczPageType } from "./mod.ts";

/** What {@link checkReplay} needs from an opened WACZ. */
export interface ReplaySourceType {
  /** Every CDXJ record under `indexes/`. */
  readIndex(): Promise<CdxjRecordType[]>;
  /** The lines of `pages/pages.jsonl`. */
  readPages(): Promise<WaczPageType[]>;
  /** Opens `archive/<filename>` as a WARC. */
  openWarc(filename: string): Promise<WarcArchiveType>;
  /** The ZIP entry for `archive/<filename>`, or `undefined` when there is none. */
  getWarc(filename: string): { readonly method: number; readonly size: number } | undefined;
}

/** Record types a replay tool can serve for a URL. */
const replayable = new Set(["response", "resource", "revisit"]);

/** Bytes read from the start of an HTTP block to find its status line and `Content-Type`. */
const HEAD_BYTES = 64 * 1024;

/** Returns a WARC header field's value, matching the name without case. */
function getField(entry: WarcEntryType, name: string): string | undefined {
  const lower = name.toLowerCase();
  return entry.fields.find((field) => field.name.toLowerCase() === lower)?.value;
}

/** Drops parameters and case from a media type, so `text/html; charset=utf-8` matches `text/html`. */
function getMediaType(value: string): string {
  return value.split(";")[0]!.trim().toLowerCase();
}

/**
 * Normalizes a digest for comparison. CDXJ files write `sha256:`, `sha-256:`
 * or a bare value; WARC writes `sha256:` or `sha1:`, and base32 values may or
 * may not carry `=` padding (warcio pads, this library does not). The label,
 * case and padding are normalized; the encoding (base32 or hex) must match.
 */
function getDigest(value: string): string {
  const colon = value.indexOf(":");
  const body = value.slice(colon + 1).replace(/=+$/, "").toLowerCase();
  return colon < 0 ? body : `${value.slice(0, colon).replace("-", "").toLowerCase()}:${body}`;
}

/**
 * Follows every CDXJ line into its WARC and checks the replay relationships.
 *
 * Each failure is one sentence in `errors`. Returns the number of CDXJ lines
 * that passed every check. The checks are:
 *
 * - the WARC file the line names exists under `archive/` and is STORED;
 * - `offset + length` lies inside that file, and no two lines share coordinates;
 * - a WARC record starts at `offset` and uses exactly `length` bytes;
 * - that record is a `response`, `resource` or `revisit` whose `WARC-Target-URI` is the line's `url`;
 * - the line's `status` and `mime`, when present, match the record's HTTP head
 *   (or, for a `resource`, its `Content-Type`);
 * - the line's `digest`, when present, matches the record's `WARC-Payload-Digest`;
 * - every page in `pages/pages.jsonl` has a line for its `url`.
 *
 * Each WARC file is indexed once, however many lines point into it. Reading an
 * HTTP head reads at most 64 KiB of the record's block.
 */
export async function checkReplay(source: ReplaySourceType, errors: string[]): Promise<number> {
  let records: CdxjRecordType[];
  try {
    records = await source.readIndex();
  } catch (cause) {
    errors.push(`The CDXJ index could not be read: ${(cause as Error).message}`);
    return 0;
  }
  const warcs = new Map<string, Promise<{ warc: WarcArchiveType; byOffset: Map<number, WarcEntryType> } | undefined>>();
  const openFile = (filename: string) => {
    let pending = warcs.get(filename);
    if (pending === undefined) {
      pending = source.openWarc(filename).then(
        (warc) => ({ warc, byOffset: new Map(warc.entries.map((entry) => [entry.offset, entry])) }),
        (cause: unknown) => {
          errors.push(`archive/${filename} could not be read as a WARC: ${(cause as Error).message}`);
          return undefined;
        },
      );
      warcs.set(filename, pending);
    }
    return pending;
  };
  const coordinates = new Set<string>();
  const urls = new Set<string>();
  let passed = 0;
  for (const record of records) {
    const at = `${record.filename}:${record.offset}+${record.length}`;
    const before = errors.length;
    const file = source.getWarc(record.filename);
    if (file === undefined) {
      errors.push(`CDXJ line for ${record.url} names archive/${record.filename}, which is not in the WACZ.`);
      continue;
    }
    if (file.method !== 0) {
      errors.push(`archive/${record.filename} is compressed in the ZIP, so CDXJ offsets into it are not byte ranges.`);
      continue;
    }
    if (record.length === 0 || record.offset + record.length > file.size) {
      errors.push(`CDXJ range ${at} lies outside archive/${record.filename}.`);
      continue;
    }
    const key = `${record.filename}\0${record.offset}\0${record.length}`;
    if (coordinates.has(key)) errors.push(`Two CDXJ lines point at ${at}.`);
    coordinates.add(key);
    const opened = await openFile(record.filename);
    if (opened === undefined) continue;
    const entry = opened.byOffset.get(record.offset);
    if (entry === undefined) {
      errors.push(`No WARC record starts at ${at}.`);
      continue;
    }
    if (entry.length !== record.length) {
      errors.push(`The WARC record at ${at} uses ${entry.length} bytes, not ${record.length}.`);
    }
    if (!replayable.has(entry.type)) {
      errors.push(`CDXJ line for ${record.url} points at a ${entry.type} record at ${at}, which cannot be replayed.`);
    }
    const target = getField(entry, "WARC-Target-URI");
    if (target !== record.url) {
      errors.push(`WARC-Target-URI at ${at} is ${target ?? "absent"}, not ${record.url}.`);
    }
    if (record.digest !== undefined) {
      const payload = getField(entry, "WARC-Payload-Digest");
      if (payload !== undefined && getDigest(payload) !== getDigest(record.digest)) {
        errors.push(`CDXJ digest for ${record.url} does not match WARC-Payload-Digest at ${at}.`);
      }
    }
    if ((record.status !== undefined || record.mime !== undefined) && entry.readable) {
      let status: number | undefined;
      let mime: string | undefined;
      if (entry.type === "response") {
        try {
          const head = await opened.warc.read(entry.id, { length: Math.min(entry.size, HEAD_BYTES) });
          const parsed = readHttpHead(head.bytes, HEAD_BYTES);
          status = parsed?.status;
          mime = parsed?.mime;
        } catch (cause) {
          errors.push(`The HTTP head at ${at} could not be read: ${(cause as Error).message}`);
        }
      } else if (entry.type === "resource") {
        const type = getField(entry, "Content-Type");
        mime = type === undefined ? undefined : getMediaType(type);
      }
      if (record.status !== undefined && status !== undefined && status !== record.status) {
        errors.push(`CDXJ status ${record.status} for ${record.url} does not match HTTP ${status} at ${at}.`);
      }
      if (record.mime !== undefined && mime !== undefined && getMediaType(record.mime) !== mime) {
        errors.push(`CDXJ mime ${record.mime} for ${record.url} does not match ${mime} at ${at}.`);
      }
    }
    if (replayable.has(entry.type)) urls.add(record.url);
    if (errors.length === before) passed++;
  }
  let pages: WaczPageType[] = [];
  try {
    pages = await source.readPages();
  } catch {
    // A missing page list is reported as `missing` by the caller.
  }
  for (const page of pages) {
    if (!urls.has(page.url)) errors.push(`Page ${page.url} has no replayable CDXJ line.`);
  }
  return passed;
}
