/**
 * CDXJ index lines, as WACZ `indexes/` files and pywb use them.
 *
 * One line per record: `<key> <timestamp> <json>`. The key is the URL in
 * SURT form, so lines for one site sort together. The timestamp is 14 digits,
 * `YYYYMMDDhhmmss`, in UTC. The JSON names the WARC file and the record's
 * byte range in it.
 *
 * ```text
 * com,example)/ 20261124100000 {"url":"https://example.com/","mime":"text/html","status":200,"offset":0,"length":512,"filename":"data.warc.gz"}
 * ```
 *
 * @module
 */
import { invalid } from "../error.ts";

/** One CDXJ line, parsed. */
export interface CdxjRecordType {
  /** The sort key, normally the URL in SURT form. */
  readonly key: string;
  /** 14-digit UTC capture time, `YYYYMMDDhhmmss`. */
  readonly timestamp: string;
  /** Original URL. */
  readonly url: string;
  /** WARC file name under `archive/`. */
  readonly filename: string;
  /** Record offset in the WARC file. For `.warc.gz`, the gzip member offset. */
  readonly offset: number;
  /** Record length in the WARC file. For `.warc.gz`, the gzip member length. */
  readonly length: number;
  /** HTTP media type, when known. */
  readonly mime?: string;
  /** HTTP status, when known. */
  readonly status?: number;
  /** Payload digest, when known, such as `sha256:...`. */
  readonly digest?: string;
  /** Every JSON field on the line, including ones this type does not name. */
  readonly fields: Readonly<Record<string, unknown>>;
}

/** Input for one line. `key` and `timestamp` are derived when absent. */
export interface CdxjInputType {
  readonly url: string;
  /** Capture time. A `Date`, an ISO string, a 14-digit timestamp, or a WARC-Date value. */
  readonly date: Date | string;
  readonly filename: string;
  readonly offset: number;
  readonly length: number;
  readonly mime?: string;
  readonly status?: number;
  readonly digest?: string;
  /** More JSON fields to keep on the line. */
  readonly fields?: Readonly<Record<string, unknown>>;
}

/**
 * Returns the SURT sort key for a URL.
 *
 * Follows the common pywb form: drop the scheme, lowercase the host, drop a
 * leading `www.` and a default port, reverse the host labels with commas, add
 * `)`, then the path and query. Query parameters are sorted, and the whole key
 * is lowercased. The key only orders and groups lines; readers match on the
 * `url` field.
 *
 * @example
 * ```ts
 * getSurt("https://www.Example.com:443/A/b?z=1&a=2"); // "com,example)/a/b?a=2&z=1"
 * ```
 */
export function getSurt(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value.toLowerCase();
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return value.toLowerCase();
  const host = url.hostname.toLowerCase().replace(/^www\d*\./, "").replace(/\.$/, "");
  const port = url.port === "" ? "" : `:${url.port}`;
  const query = url.search === "" ? "" : `?${url.search.slice(1).split("&").sort().join("&")}`;
  return `${host.split(".").reverse().join(",")}${port})${url.pathname || "/"}${query}`.toLowerCase();
}

/** Converts a date to the 14-digit CDXJ timestamp. */
export function getTimestamp(date: Date | string): string {
  if (typeof date === "string" && /^\d{14}$/.test(date)) return date;
  const parsed = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(parsed.getTime())) throw new RangeError(`Invalid capture date: ${String(date)}.`);
  return parsed.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/**
 * Builds CDXJ text, sorted by key and timestamp, one line per record.
 *
 * Sorting matters: readers binary-search large indexes, so unsorted lines can
 * hide records.
 *
 * @example Index records written by `createWarcStream`.
 * ```ts
 * const lines: CdxjInputType[] = [];
 * const warc = createWarcStream(records, {
 *   compression: "gzip",
 *   onRecord: (r) => r.targetUri && lines.push({ ...r, url: r.targetUri, filename: "data.warc.gz" }),
 * });
 * // ...after the stream ends:
 * const index = createCdxj(lines);
 * ```
 */
export function createCdxj(records: Iterable<CdxjInputType>): string {
  const lines: string[] = [];
  for (const record of records) {
    const json: Record<string, unknown> = { url: record.url };
    if (record.mime !== undefined) json.mime = record.mime;
    if (record.status !== undefined) json.status = record.status;
    if (record.digest !== undefined) json.digest = record.digest;
    json.offset = record.offset;
    json.length = record.length;
    json.filename = record.filename;
    for (const [name, value] of Object.entries(record.fields ?? {})) if (!(name in json)) json[name] = value;
    lines.push(`${getSurt(record.url)} ${getTimestamp(record.date)} ${JSON.stringify(json)}`);
  }
  lines.sort();
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** Reads a non-negative safe integer from a JSON number or decimal string. */
function toCount(value: unknown, label: string): number {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    throw invalid(`CDXJ ${label} must be a non-negative integer.`);
  }
  return number;
}

/**
 * Parses CDXJ text into records. Blank lines are skipped.
 *
 * `offset`, `length` and `status` may be numbers or decimal strings; pywb
 * writes strings. A line without `url`, `filename`, `offset` or `length`
 * fails with `invalid-archive`, because it cannot locate a record.
 */
export function parseCdxj(text: string): CdxjRecordType[] {
  const records: CdxjRecordType[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    const first = line.indexOf(" ");
    const second = line.indexOf(" ", first + 1);
    if (first < 1 || second < 0) throw invalid(`CDXJ line ${index + 1} needs a key, a timestamp and JSON.`);
    const timestamp = line.slice(first + 1, second);
    if (!/^\d{4,14}$/.test(timestamp)) throw invalid(`CDXJ line ${index + 1} has an invalid timestamp.`);
    let fields: unknown;
    try {
      fields = JSON.parse(line.slice(second + 1));
    } catch {
      throw invalid(`CDXJ line ${index + 1} has invalid JSON.`);
    }
    if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
      throw invalid(`CDXJ line ${index + 1} JSON must be an object.`);
    }
    const json = fields as Record<string, unknown>;
    if (typeof json.url !== "string" || typeof json.filename !== "string") {
      throw invalid(`CDXJ line ${index + 1} needs url and filename.`);
    }
    records.push(Object.freeze({
      key: line.slice(0, first),
      timestamp,
      url: json.url,
      filename: json.filename,
      offset: toCount(json.offset, "offset"),
      length: toCount(json.length, "length"),
      ...(typeof json.mime === "string" ? { mime: json.mime } : {}),
      ...(json.status === undefined || json.status === "-" ? {} : { status: toCount(json.status, "status") }),
      ...(typeof json.digest === "string" ? { digest: json.digest } : {}),
      fields: Object.freeze(json),
    }));
  }
  return records;
}
