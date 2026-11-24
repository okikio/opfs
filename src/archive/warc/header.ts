/**
 * WARC record header parsing, shared by the plain and gzip readers.
 *
 * Both readers find a record header the same way: read CRLF lines until an
 * empty line, check fields, then trust `Content-Length` to skip the block. The
 * only difference is where the header bytes come from: the source itself, or
 * the decoded start of one gzip member.
 *
 * @module
 */
import { ArchiveError, invalid, unsupported } from "../error.ts";

/** An ordered field with its original name and unfolded, whitespace-trimmed value. */
export interface WarcFieldType {
  /** Field name as written, with its original case. */
  readonly name: string;
  /** Field value after unfolding continuation lines and trimming outer space and tab. */
  readonly value: string;
}

/** Header limits for one record. */
export interface HeaderLimitsType {
  /** Bytes in one header, including the version line and CRLFs. */
  readonly maxHeaderBytes: number;
  /** Bytes in one line, excluding CRLF. */
  readonly maxLineBytes: number;
  /** Fields in one record, excluding continuation lines. */
  readonly maxFields: number;
}

/** One parsed record header. `end` is the offset of the first block byte. */
export interface HeaderType {
  readonly version: "1.0" | "1.1";
  readonly recordId: string;
  readonly type: string;
  readonly date: string;
  /** Block length from `Content-Length`, in bytes. */
  readonly size: number;
  readonly fields: readonly WarcFieldType[];
  /** Offset just past the empty line that ends the header. */
  readonly end: number;
}

/**
 * Reads `length` bytes at `offset`. The plain reader charges source reads;
 * the gzip reader serves bytes it already decoded.
 */
export type HeaderReadType = (offset: number, length: number) => Promise<Uint8Array>;

/** Core 1.0/1.1 singleton fields. Unknown extension fields have no invented repetition policy. */
const singletons = new Set([
  "warc-record-id",
  "content-length",
  "warc-date",
  "warc-type",
  "content-type",
  "warc-block-digest",
  "warc-payload-digest",
  "warc-ip-address",
  "warc-refers-to",
  "warc-refers-to-target-uri",
  "warc-refers-to-date",
  "warc-target-uri",
  "warc-truncated",
  "warc-warcinfo-id",
  "warc-filename",
  "warc-profile",
  "warc-identified-payload-type",
  "warc-segment-origin-id",
  "warc-segment-number",
  "warc-segment-total-length",
]);

/** HTTP token characters, used for field names and record types. */
export const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Throws `budget-exceeded` when `value` passes `maximum`. */
export function cap(value: number, maximum: number, label: string): void {
  if (value > maximum) throw new ArchiveError("budget-exceeded", `${label} limit exceeded.`);
}

/**
 * Bounded line reader over one header.
 *
 * It reads ahead at most 1 KiB at a time and never past `maxHeaderBytes`, so a
 * block that looks like more header lines cannot make it read the block.
 * `Content-Length` later skips the block without scanning it for delimiters.
 */
class Lines {
  offset: number;
  readonly #start: number;
  readonly #size: number;
  readonly #read: HeaderReadType;
  readonly #charge: ((count: number) => void) | undefined;
  readonly #headerMaximum: number;
  readonly #lineMaximum: number;
  #chunk: Uint8Array = new Uint8Array();
  #index = 0;

  constructor(
    size: number,
    offset: number,
    read: HeaderReadType,
    headerMaximum: number,
    lineMaximum: number,
    charge?: (count: number) => void,
  ) {
    this.offset = this.#start = offset;
    this.#size = size;
    this.#read = read;
    this.#charge = charge;
    this.#headerMaximum = headerMaximum;
    this.#lineMaximum = lineMaximum;
  }

  async #byte(): Promise<number> {
    cap(this.offset - this.#start + 1, this.#headerMaximum, "WARC header bytes");
    if (this.offset >= this.#size) throw invalid("Truncated WARC header.");
    if (this.#index === this.#chunk.length) {
      this.#chunk = await this.#read(
        this.offset,
        Math.min(1024, this.#size - this.offset, this.#headerMaximum - (this.offset - this.#start)),
      );
      this.#index = 0;
    }
    this.offset++;
    this.#charge?.(1);
    return this.#chunk[this.#index++]!;
  }

  /** Returns the next line without its CRLF. */
  async next(): Promise<string> {
    const bytes: number[] = [];
    while (true) {
      const byte = await this.#byte();
      if (byte === 13) {
        if (await this.#byte() !== 10) throw invalid("WARC header requires CRLF lines.");
        try {
          return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes));
        } catch {
          throw invalid("WARC header contains invalid UTF8.");
        }
      }
      if ((byte < 32 && byte !== 9) || byte === 127) throw invalid("WARC header contains a control byte.");
      cap(bytes.length + 1, this.#lineMaximum, "WARC line bytes");
      bytes.push(byte);
    }
  }
}

/**
 * Parses one record header that starts at `offset`.
 *
 * Checks the version line, field syntax, singleton fields, the record ID
 * shape, and that `WARC-Type`, `WARC-Date` and a decimal `Content-Length`
 * exist. It does not check that the block fits the source; callers know the
 * extent and check it.
 *
 * @param size Total bytes available to `read`.
 * @param charge Optional decoded-work charge per header byte.
 */
export async function parseHeader(
  size: number,
  offset: number,
  read: HeaderReadType,
  limits: HeaderLimitsType,
  charge?: (count: number) => void,
): Promise<HeaderType> {
  const lines = new Lines(size, offset, read, limits.maxHeaderBytes, limits.maxLineBytes, charge);
  const versionLine = await lines.next();
  if (versionLine !== "WARC/1.0" && versionLine !== "WARC/1.1") {
    throw unsupported("Expected a WARC/1.0 or WARC/1.1 version line.");
  }
  const fields: { name: string; value: string }[] = [];
  const seen = new Set<string>();
  while (true) {
    const line = await lines.next();
    if (!line) break;
    if (/^[ \t]/.test(line)) {
      const previous = fields[fields.length - 1];
      if (!previous) throw invalid("WARC continuation has no preceding field.");
      previous.value += ` ${line.replace(/^[ \t]+|[ \t]+$/g, "")}`;
      continue;
    }
    cap(fields.length + 1, limits.maxFields, "WARC field count");
    const colon = line.indexOf(":");
    const name = line.slice(0, colon);
    if (colon < 1 || !token.test(name)) throw invalid("Invalid WARC field name.");
    const key = name.toLowerCase();
    if (singletons.has(key) && seen.has(key)) throw invalid("Duplicate singleton WARC field.");
    seen.add(key);
    fields.push({ name, value: line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, "") });
  }
  // Folding can introduce outer LWS when the first value line was empty.
  for (const field of fields) field.value = field.value.replace(/^[ \t]+|[ \t]+$/g, "");
  const value = (name: string): string | undefined => fields.find((field) => field.name.toLowerCase() === name)?.value;
  const recordId = value("warc-record-id");
  const type = value("warc-type");
  const date = value("warc-date");
  const length = value("content-length");
  if (!recordId || !/^<[A-Za-z][A-Za-z0-9+.-]*:[^<>\s]+>$/.test(recordId)) {
    throw invalid("Invalid or missing WARC record ID.");
  }
  if (!type || !token.test(type) || !date) throw invalid("Missing WARC type or date.");
  if (length === undefined || !/^\d+$/.test(length)) throw invalid("Invalid or missing WARC Content-Length.");
  const blockSize = Number(length);
  if (!Number.isSafeInteger(blockSize)) throw invalid("WARC Content-Length is not a safe integer.");
  return {
    version: versionLine === "WARC/1.0" ? "1.0" : "1.1",
    recordId,
    type,
    date,
    size: blockSize,
    fields: Object.freeze(fields.map((field) => Object.freeze(field))),
    end: lines.offset,
  };
}

/** Returns whether 4 bytes are the CRLFCRLF record separator. */
export function isSeparator(bytes: Uint8Array): boolean {
  return bytes[0] === 13 && bytes[1] === 10 && bytes[2] === 13 && bytes[3] === 10;
}

/** RFC 4648 Base32 with no padding, the form WARC digests use. */
export function base32(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let accumulator = 0;
  let bits = 0;
  let result = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(accumulator >>> bits) & 31];
    }
  }
  if (bits) result += alphabet[(accumulator << (5 - bits)) & 31];
  return result;
}
