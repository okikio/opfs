/** Bounded physical MIME indexing and explicit transfer-decoded previews. @module */
import type { ByteSourceType } from "../source.ts";
import { ArchiveBudget, ArchiveError, integer, invalid, unsupported } from "./record.ts";
import type { ArchiveLimitsType, ArchiveWorkType } from "./record.ts";
export { ArchiveError, createArchiveLedger } from "./record.ts";
export type { ArchiveErrorCodeType, ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";

/** Ordered raw header meaning: unfolding removes CRLF but preserves following space/tab. */
export interface MimeFieldType {
  readonly name: string;
  readonly value: string;
}
/** One physical MIME entity; ordinal identity never depends on a filename or Content-ID. */
export interface MimeEntryType {
  readonly id: number;
  readonly parent: number | null;
  readonly type: string;
  /** Declared charset; absent text charsets default to us-ascii. No text rendering occurs. */
  readonly charset: string | undefined;
  readonly encoding: string;
  readonly fields: readonly MimeFieldType[];
  /** Original header extent in source bytes, including the terminating blank line. */
  readonly headerOffset: number;
  readonly headerSize: number;
  /** Encoded stored block offset and byte length, excluding delimiter-owned CRLF. */
  readonly offset: number;
  readonly size: number;
  readonly filename: string | undefined;
  /** Unsupported display encodings remain available in fields and never receive a guessed name. */
  readonly filenameStatus: "missing" | "decoded" | "unsupported";
  /** Untrusted MIME declarations, never evidence that cryptography was checked. */
  readonly protection: "none" | "signed-unverified" | "encrypted-opaque" | "opaque-security";
}
/** Metadata limits are caller safety policy, not a claim of complete RFC semantic validation. */
export interface MimeOpenOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly allowUnverifiedSource?: boolean;
  /** Accept fatal UTF8 header values per RFC 6532, rather than ASCII only. Default false. */
  readonly utf8Headers?: boolean;
  /** Total physical entities including the root. Default 1000. */
  readonly maxParts?: number;
  /** Maximum child nesting; root depth is zero. Default 16. */
  readonly maxDepth?: number;
  /** Per-entity header bytes including CRLF and blank line. Default 64 KiB. */
  readonly maxHeaderBytes?: number;
  /** Physical header line bytes excluding CRLF. Default 998. */
  readonly maxLineBytes?: number;
  /** Fields per entity, excluding folded continuation lines. Default 128. */
  readonly maxFields?: number;
  /** Cumulative original header byte extents across all entities. Default 4 MiB. */
  readonly maxMetadataBytes?: number;
  /** Space/tab bytes following a boundary marker. Default 256. */
  readonly maxBoundaryPadding?: number;
  /** Source read chunk ceiling, 1..65536 bytes; default 4096. Also permits chunk-boundary regression checks. */
  readonly maxChunkBytes?: number;
}
/** Decoded offset/length. read() drains the entire encoding even for a selected range. */
export interface MimeReadOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly offset?: number;
  readonly length?: number;
}
/** Prefix offsets count decoded bytes and can require scanning all earlier encoded bytes. */
export interface MimePrefixOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly offset?: number;
}
/** complete describes encoding examination, not authentication or the bytes returned by a range. */
export interface MimeReadType {
  readonly bytes: Uint8Array;
  readonly integrity: "none";
  readonly complete: boolean;
  readonly work: ArchiveWorkType;
}
/** A borrowed stable source and a bounded physical MIME tree, with no renderer or resolver. */
export interface MimeArchiveType {
  readonly entries: readonly MimeEntryType[];
  readonly work: ArchiveWorkType;
  readonly source: {
    readonly identity?: string;
    readonly stability: "immutable" | "provider" | "caller" | "unverified";
  };
  read(id: number, options?: MimeReadOptionsType): Promise<MimeReadType>;
  prefix(id: number, maximum: number, options?: MimePrefixOptionsType): Promise<MimeReadType>;
  readRaw(id: number, options?: MimeReadOptionsType): Promise<MimeReadType>;
  readHeaders(id: number, options?: ArchiveLimitsType & { readonly signal?: AbortSignal }): Promise<MimeReadType>;
}

interface ParameterType {
  name: string;
  value: string;
}
interface MediaType {
  value: string;
  parameters: ParameterType[];
}
/** Child extent ends only at its parent delimiter; no mutable record escapes opening. */
interface PendingType {
  entry: MimeEntryType;
  boundary: string | undefined;
  end: number;
}
/** Each active ancestor owns one current child and requires its own closing delimiter. */
interface MultipartType {
  part: PendingType;
  child: PendingType | undefined;
  children: number;
}
/** RFC 2045 tokens exclude whitespace, controls and MIME separators. */
const mimeToken = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Only fields that control this parser need singleton admission; identity/display fields stay ordered. */
const interpreted = new Set(["content-type", "content-transfer-encoding", "content-disposition", "mime-version"]);

/**
 * Inspect strict CRLF EML and MIME without rendering HTML, authenticating signatures or decrypting opaque bodies.
 * Multipart indexing scans stored wire bytes once; leaf transfer decoding occurs only on explicit read/prefix.
 */
export async function openMime(input: ByteSourceType, options: MimeOpenOptionsType = {}): Promise<MimeArchiveType> {
  // Preserve the admitted source capabilities even if its descriptor is later mutated.
  const source: ByteSourceType = {
    size: input.size,
    ...(input.identity === undefined ? {} : { identity: input.identity }),
    ...(input.stability === undefined ? {} : { stability: input.stability }),
    read: input.read.bind(input),
  };
  if (!source.stability && !options.allowUnverifiedSource) {
    unsupported("MIME indexing requires source stability or explicit acceptance.");
  }
  const policy = {
    parts: options.maxParts ?? 1000,
    depth: options.maxDepth ?? 16,
    header: options.maxHeaderBytes ?? 65536,
    line: options.maxLineBytes ?? 998,
    fields: options.maxFields ?? 128,
    metadata: options.maxMetadataBytes ?? 4 * 1024 * 1024,
    padding: options.maxBoundaryPadding ?? 256,
    chunk: options.maxChunkBytes ?? 4096,
  };
  for (const [name, value] of Object.entries(policy)) integer(value, name);
  integer(policy.padding + 74, "Boundary candidate extent");
  if (policy.chunk < 1 || policy.chunk > 65536) throw new RangeError("MIME chunk ceiling must be 1..65536 bytes.");
  const budget = new ArchiveBudget(source, options, options.signal);
  const wire = new MimeCursor(source.size, 0, budget, policy.chunk, true);
  const pending: PendingType[] = [];
  let metadata = 0;
  async function part(parent: MultipartType | undefined, depth: number): Promise<PendingType> {
    cap(pending.length + 1, policy.parts, "MIME part count");
    cap(depth, policy.depth, "MIME nesting depth");
    const start = wire.offset;
    const fields: { name: string; value: string }[] = [];
    const seen = new Set<string>();
    while (true) {
      const allowance = Math.min(policy.header - (wire.offset - start), policy.metadata - metadata);
      const line = await wire.line(policy.line, allowance, true);
      metadata += line.length + 2;
      if (!line.crlf) invalid("MIME headers require a blank CRLF line before the body.");
      let value: string;
      if (!options.utf8Headers && line.bytes.some((byte) => byte > 127)) {
        unsupported("Non-ASCII mail headers require utf8Headers.");
      }
      try {
        value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(line.bytes);
      } catch {
        invalid("Invalid UTF8 MIME header.");
      }
      if (line.bytes.some((byte) => (byte < 32 && byte !== 9) || byte === 127)) invalid("Control byte in MIME header.");
      if (!value) break;
      if (/^[ \t]/.test(value)) {
        const previous = fields.at(-1);
        if (!previous) invalid("MIME folded header has no preceding field.");
        previous.value += value;
        continue;
      }
      cap(fields.length + 1, policy.fields, "MIME field count");
      const colon = value.indexOf(":");
      const name = value.slice(0, colon);
      if (colon < 1 || !/^[\x21-\x39\x3b-\x7e]+$/.test(name)) invalid("Invalid MIME field name.");
      const lower = name.toLowerCase();
      if (interpreted.has(lower) && seen.has(lower)) invalid("Ambiguous duplicate MIME interpretation field.");
      seen.add(lower);
      fields.push({ name, value: value.slice(colon + 1) });
    }
    const get = (name: string): string | undefined =>
      fields.find((field) => field.name.toLowerCase() === name)?.value.replace(/^[ \t]+|[ \t]+$/g, "");
    const version = get("mime-version");
    if (version && version !== "1.0") {
      unsupported("Only literal MIME-Version 1.0 is supported; comments/obsolete syntax are not interpreted.");
    }
    const fallback = parent?.part.entry.type === "multipart/digest" ? "message/rfc822" : "text/plain";
    const media = parseMedia(get("content-type") ?? fallback, true);
    const disposition = get("content-disposition");
    const naming = disposition ? parseMedia(disposition, false) : undefined;
    const filename = filenameOf(
      naming?.parameters ?? media.parameters.filter((parameter) => parameter.name.startsWith("name")),
      naming ? "filename" : "name",
    );
    const encoding = (get("content-transfer-encoding") ?? "7bit").toLowerCase();
    if (!mimeToken.test(encoding)) unsupported("Unsupported MIME transfer encoding syntax.");
    const boundary = media.value.startsWith("multipart/")
      ? media.parameters.find((parameter) => parameter.name === "boundary")?.value
      : undefined;
    if (media.value.startsWith("multipart/")) {
      if (!boundary || !/^[0-9A-Za-z'()+_,\-./:=? ]{1,70}$/.test(boundary) || boundary.endsWith(" ")) {
        invalid("Invalid MIME multipart boundary.");
      }
      if (!["7bit", "8bit", "binary"].includes(encoding)) {
        unsupported("Multipart transfer encoding cannot be base64 or quoted-printable.");
      }
    }
    let protection = parent?.part.entry.protection ?? "none";
    if (media.value === "multipart/signed") protection = "signed-unverified";
    if (media.value === "multipart/encrypted" || media.value === "application/pgp-encrypted") {
      protection = "encrypted-opaque";
    }
    if (["application/pkcs7-signature", "application/pgp-signature"].includes(media.value)) {
      protection = "signed-unverified";
    }
    if (["application/pkcs7-mime", "application/x-pkcs7-mime"].includes(media.value)) {
      const smime = media.parameters.find((parameter) => parameter.name === "smime-type")?.value.toLowerCase();
      protection = smime === "signed-data"
        ? "signed-unverified"
        : smime === "enveloped-data" || smime === "authenveloped-data"
        ? "encrypted-opaque"
        : "opaque-security";
    }
    const entry: MimeEntryType = {
      id: pending.length,
      parent: parent?.part.entry.id ?? null,
      type: media.value,
      charset: media.parameters.find((parameter) => parameter.name === "charset")?.value ??
        (media.value.startsWith("text/") ? "us-ascii" : undefined),
      encoding,
      fields: Object.freeze(fields.map((field) => Object.freeze(field))),
      headerOffset: start,
      headerSize: wire.offset - start,
      offset: wire.offset,
      size: 0,
      filename: filename.value,
      filenameStatus: filename.status,
      protection,
    };
    const result = { entry, boundary, end: source.size };
    pending.push(result);
    return result;
  }
  const root = await part(undefined, 0);
  const stack: MultipartType[] = root.boundary ? [{ part: root, child: undefined, children: 0 }] : [];
  if (stack.length) {
    while (wire.offset < source.size) {
      const line = await wire.line(74 + policy.padding, Infinity, false);
      let matched = -1;
      let closing = false;
      const prefix = new TextDecoder().decode(line.bytes);
      if (!line.tailWhitespace) continue;
      for (let index = stack.length - 1; index >= 0; index--) {
        const state = stack[index]!;
        const marker = `--${state.part.boundary!}`;
        if (!prefix.startsWith(marker)) continue;
        let suffix = prefix.slice(marker.length);
        const close = suffix.startsWith("--");
        if (close) suffix = suffix.slice(2);
        if (!/^[ \t]*$/.test(suffix)) continue;
        const padding = line.length - marker.length - (close ? 2 : 0);
        cap(padding, policy.padding, "MIME boundary padding");
        matched = index;
        closing = close;
        break;
      }
      if (matched < 0) continue;
      if (matched !== stack.length - 1) invalid("Outer MIME boundary encountered before nested multipart closed.");
      const state = stack[matched]!;
      if (state.child) state.child.end = Math.max(state.child.entry.offset, line.start - 2);
      if (closing) {
        if (!state.children) invalid("MIME multipart contains no parts.");
        stack.pop();
        if (!stack.length) {
          // Epilogue remains inert but is scanned/charged under the same finite work budget.
          while (await wire.next() !== undefined) { /* bounded cursor owns reads */ }
          break;
        }
      } else {
        if (!line.crlf) invalid("MIME opening boundary requires CRLF before part headers.");
        const child = await part(state, stack.length);
        state.child = child;
        state.children++;
        if (child.boundary) {
          if (
            stack.some((ancestor) =>
              ancestor.part.boundary!.startsWith(child.boundary!) || child.boundary!.startsWith(ancestor.part.boundary!)
            )
          ) {
            unsupported("Prefix-colliding ancestor MIME boundaries are unsupported.");
          }
          stack.push({ part: child, child: undefined, children: 0 });
        }
      }
    }
    if (stack.length) invalid("MIME multipart is missing its closing boundary.");
  }
  const entries = Object.freeze(
    pending.map((record) => Object.freeze({ ...record.entry, size: record.end - record.entry.offset })),
  );
  function at(id: number, decode = false): MimeEntryType {
    integer(id, "MIME ordinal");
    const entry = entries[id];
    if (!entry) throw new RangeError("MIME ordinal does not exist.");
    if (decode && entry.type.startsWith("multipart/")) unsupported("Select a leaf MIME part for decoded reads.");
    return entry;
  }
  async function raw(id: number, readOptions: MimeReadOptionsType, headers: boolean): Promise<MimeReadType> {
    const entry = at(id);
    const size = headers ? entry.headerSize : entry.size;
    const start = readOptions.offset ?? 0;
    const length = readOptions.length ?? size - start;
    integer(start, "Raw offset");
    integer(length, "Raw length");
    if (start > size || length > size - start) throw new RangeError("MIME raw range exceeds its extent.");
    const work = new ArchiveBudget(source, readOptions, readOptions.signal);
    work.output(length);
    work.decoded(length);
    const bytes = await work.read((headers ? entry.headerOffset : entry.offset) + start, length);
    return { bytes, integrity: "none", complete: false, work: work.inspect() };
  }
  async function read(id: number, readOptions: MimeReadOptionsType, maximum?: number): Promise<MimeReadType> {
    const entry = at(id, true);
    if (!["7bit", "8bit", "binary", "base64", "quoted-printable"].includes(entry.encoding)) {
      unsupported("Unknown MIME transfer encoding; use readRaw for opaque bytes.");
    }
    const start = readOptions.offset ?? 0;
    integer(start, "Decoded offset");
    if (readOptions.length !== undefined) integer(readOptions.length, "Decoded length");
    const work = new ArchiveBudget(source, readOptions, readOptions.signal);
    readOptions.signal?.throwIfAborted();
    // Zero prefix means no examination, even for empty wire parts or high offsets.
    if (maximum === 0) return { bytes: new Uint8Array(), integrity: "none", complete: false, work: work.inspect() };
    const chunks: Uint8Array[] = [];
    let total = 0;
    let output = 0;
    let complete = true;
    for await (
      const chunk of decodePart(
        entry,
        work,
        policy.chunk,
        maximum === undefined ? 4096 : Math.max(1, Math.min(4096, maximum)),
      )
    ) {
      const from = Math.min(chunk.length, Math.max(0, start - total));
      const remaining = maximum === undefined
        ? (readOptions.length === undefined ? Infinity : readOptions.length - output)
        : maximum - output;
      const length = Math.min(chunk.length - from, remaining);
      if (length > 0) {
        work.output(length);
        chunks.push(chunk.slice(from, from + length));
        output += length;
      }
      total += chunk.length;
      if (!Number.isSafeInteger(total)) invalid("Decoded MIME extent exceeds safe arithmetic.");
      if (maximum !== undefined && output >= maximum) {
        complete = false;
        break;
      }
    }
    if (
      start > total || (maximum === undefined && readOptions.length !== undefined && readOptions.length > total - start)
    ) throw new RangeError("Decoded MIME range exceeds part.");
    const bytes = new Uint8Array(output);
    let cursor = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, cursor);
      cursor += chunk.length;
    }
    readOptions.signal?.throwIfAborted();
    return { bytes, integrity: "none", complete, work: work.inspect() };
  }
  return Object.freeze({
    entries,
    work: budget.inspect(),
    source: Object.freeze({
      ...(source.identity === undefined ? {} : { identity: source.identity }),
      stability: source.stability ?? "unverified",
    }),
    read: (id: number, readOptions: MimeReadOptionsType = {}) => read(id, readOptions),
    prefix(id: number, maximum: number, readOptions: MimePrefixOptionsType = {}): Promise<MimeReadType> {
      integer(maximum, "Prefix byte limit");
      return read(id, readOptions, maximum);
    },
    readRaw: (id: number, readOptions: MimeReadOptionsType = {}) => raw(id, readOptions, false),
    readHeaders: (id: number, readOptions: ArchiveLimitsType & { readonly signal?: AbortSignal } = {}) =>
      raw(id, readOptions, true),
  });
}

/** Token/quoted-string parser deliberately refuses comments and obsolete MIME syntax instead of guessing. */
function parseMedia(value: string, media: boolean): MediaType {
  let index = 0;
  const skip = () => {
    while (value[index] === " " || value[index] === "\t") index++;
  };
  function token(): string {
    const start = index;
    while (index < value.length && mimeToken.test(value[index]!)) index++;
    if (index === start) unsupported("Unsupported MIME parameter syntax, including comments/obsolete forms.");
    return value.slice(start, index);
  }
  skip();
  let kind = token().toLowerCase();
  if (media) {
    if (value[index++] !== "/") invalid("Invalid MIME media type.");
    kind += `/${token().toLowerCase()}`;
  }
  const parameters: ParameterType[] = [];
  const seen = new Set<string>();
  skip();
  while (index < value.length) {
    if (value[index++] !== ";") unsupported("Unsupported MIME parameter separator/comment.");
    skip();
    const name = token().toLowerCase();
    skip();
    if (value[index++] !== "=") invalid("MIME parameter requires equals.");
    skip();
    let parameter = "";
    if (value[index] === '"') {
      index++;
      let closed = false;
      while (index < value.length) {
        const character = value[index++]!;
        if (character === '"') {
          closed = true;
          break;
        }
        if (character === "\\") {
          if (index === value.length) invalid("Unclosed MIME quoted pair.");
          parameter += value[index++]!;
        } else parameter += character;
      }
      if (!closed) invalid("Unclosed MIME quoted string.");
    } else parameter = token();
    if (seen.has(name)) invalid("Duplicate MIME parameter.");
    seen.add(name);
    parameters.push({ name, value: parameter });
    skip();
  }
  return { value: kind, parameters };
}

/** Filenames are display metadata; unsupported encodings stay in raw fields and never become paths. */
function filenameOf(
  parameters: ParameterType[],
  key: string,
): { value: string | undefined; status: "missing" | "decoded" | "unsupported" } {
  const names = parameters.filter((parameter) => parameter.name === key || parameter.name.startsWith(`${key}*`));
  if (!names.length) return { value: undefined, status: "missing" };
  if (names.length !== 1) return { value: undefined, status: "unsupported" };
  const name = names[0]!;
  if (name.name === key) {
    if (/[^\x20-\x7e]|=\?/.test(name.value)) return { value: undefined, status: "unsupported" };
    return { value: name.value, status: "decoded" };
  }
  if (name.name !== `${key}*`) return { value: undefined, status: "unsupported" };
  const match = /^([^']*)'[^']*'(.*)$/.exec(name.value);
  if (!match || !/^(utf-8|us-ascii)$/i.test(match[1]!)) return { value: undefined, status: "unsupported" };
  const bytes: number[] = [];
  for (let index = 0; index < match[2]!.length; index++) {
    const character = match[2]![index]!;
    if (character === "%") {
      const hex = match[2]!.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return { value: undefined, status: "unsupported" };
      bytes.push(parseInt(hex, 16));
      index += 2;
    } else {
      if (!/^[!#$&+.^_`|~0-9A-Za-z-]$/.test(character)) return { value: undefined, status: "unsupported" };
      bytes.push(character.charCodeAt(0));
    }
  }
  if (match[1]!.toLowerCase() === "us-ascii" && bytes.some((byte) => byte > 127)) {
    return { value: undefined, status: "unsupported" };
  }
  try {
    const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes));
    return { value, status: "decoded" };
  } catch {
    return { value: undefined, status: "unsupported" };
  }
}

/** Fixed lookahead bounds memory even for binary bodies with arbitrarily long physical lines. */
class MimeCursor {
  offset: number;
  readonly #end: number;
  readonly #budget: ArchiveBudget;
  readonly #chunkSize: number;
  readonly #scan: boolean;
  #bytes: Uint8Array = new Uint8Array();
  #index = 0;
  constructor(end: number, offset: number, budget: ArchiveBudget, chunkSize: number, scan: boolean) {
    this.#end = end;
    this.offset = offset;
    this.#budget = budget;
    this.#chunkSize = chunkSize;
    this.#scan = scan;
  }
  async next(): Promise<number | undefined> {
    if (this.offset === this.#end) return undefined;
    if (this.#index === this.#bytes.length) {
      const length = Math.min(this.#chunkSize, this.#end - this.offset);
      if (this.#scan) this.#budget.decoded(length);
      this.#bytes = await this.#budget.read(this.offset, length);
      this.#index = 0;
    }
    this.offset++;
    return this.#bytes[this.#index++]!;
  }
  async line(
    maximum: number,
    wireMaximum: number,
    strict: boolean,
  ): Promise<{ start: number; length: number; bytes: Uint8Array; crlf: boolean; tailWhitespace: boolean }> {
    const start = this.offset;
    const bytes: number[] = [];
    let previous = -1;
    // Beyond retained boundary lookahead, only a scalar is needed to distinguish
    // real transport padding from an arbitrary long binary payload line.
    let discardedNonWhitespace = 0;
    while (true) {
      cap(this.offset - start + 1, wireMaximum, "MIME header/metadata bytes");
      const byte = await this.next();
      if (byte === undefined) {
        return {
          start,
          length: this.offset - start,
          bytes: new Uint8Array(bytes),
          crlf: false,
          tailWhitespace: discardedNonWhitespace === 0,
        };
      }
      if (previous === 13 && byte === 10) {
        const length = this.offset - start - 2;
        if (bytes.length > length) bytes.length = length;
        if (length + 1 > maximum) discardedNonWhitespace--; // Delimiter CR is not body padding.
        return {
          start,
          length,
          bytes: new Uint8Array(bytes),
          crlf: true,
          tailWhitespace: discardedNonWhitespace === 0,
        };
      }
      const length = this.offset - start;
      if (strict && byte !== 13) cap(length, maximum, "MIME physical header line");
      if (bytes.length < maximum) bytes.push(byte);
      else if (byte !== 32 && byte !== 9) discardedNonWhitespace++;
      previous = byte;
    }
  }
}

/** Incremental strict transfer decoding; yielded chunks and decoder carry remain bounded. */
async function* decodePart(
  entry: MimeEntryType,
  budget: ArchiveBudget,
  chunkSize: number,
  outputMaximum: number,
): AsyncGenerator<Uint8Array> {
  const cursor = new MimeCursor(entry.offset + entry.size, entry.offset, budget, chunkSize, false);
  let output: number[] = [];
  const push = (byte: number) => {
    budget.decoded(1);
    output.push(byte);
  };
  if (["7bit", "8bit", "binary"].includes(entry.encoding)) {
    let byte: number | undefined;
    while ((byte = await cursor.next()) !== undefined) {
      if (entry.encoding === "7bit" && byte > 127) invalid("Non-ASCII byte in 7bit MIME transfer encoding.");
      push(byte);
      if (output.length >= outputMaximum) {
        yield new Uint8Array(output);
        output = [];
      }
    }
  } else if (entry.encoding === "base64") {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let quartet: number[] = [];
    let ended = false;
    let byte: number | undefined;
    while ((byte = await cursor.next()) !== undefined) {
      if (byte === 32 || byte === 9 || byte === 13 || byte === 10) continue;
      const digit = byte === 61 ? 64 : alphabet.indexOf(String.fromCharCode(byte));
      if (digit < 0 || ended) invalid("Invalid strict MIME Base64 alphabet or suffix.");
      quartet.push(digit);
      if (quartet.length === 4) {
        const [a, b, c, d] = quartet as [number, number, number, number];
        if (
          a === 64 || b === 64 || (c === 64 && d !== 64) || (c === 64 && (b & 15) !== 0) ||
          (d === 64 && c !== 64 && (c & 3) !== 0)
        ) invalid("Invalid MIME Base64 padding or unused bits.");
        push((a << 2) | (b >> 4));
        if (c !== 64) push(((b & 15) << 4) | (c >> 2));
        if (d !== 64) push(((c & 3) << 6) | d);
        ended = c === 64 || d === 64;
        quartet = [];
        if (output.length >= outputMaximum) {
          yield new Uint8Array(output);
          output = [];
        }
      }
    }
    if (quartet.length) invalid("Incomplete MIME Base64 quantum.");
  } else {
    let byte: number | undefined;
    let whitespace: number[] = [];
    let line = 0;
    while ((byte = await cursor.next()) !== undefined) {
      if (byte !== 13) cap(++line, 76, "Quoted-printable encoded line");
      if (byte === 32 || byte === 9) {
        whitespace.push(byte);
        continue;
      }
      if (byte === 13) {
        if (await cursor.next() !== 10) invalid("Quoted-printable requires CRLF line breaks.");
        whitespace = [];
        line = 0;
        push(13);
        push(10);
      } else {
        for (const space of whitespace) push(space);
        whitespace = [];
        if (byte === 61) {
          const a = await cursor.next();
          const b = await cursor.next();
          if (a === 13 && b === 10) line = 0;
          else {
            cap(line += 2, 76, "Quoted-printable encoded line");
            const pair = String.fromCharCode(a ?? 0, b ?? 0);
            if (!/^[0-9A-F]{2}$/.test(pair)) invalid("Invalid strict quoted-printable escape.");
            push(parseInt(pair, 16));
          }
        } else {
          if (byte < 33 || byte > 126) invalid("Invalid quoted-printable literal byte.");
          push(byte);
        }
      }
      if (output.length >= outputMaximum) {
        yield new Uint8Array(output);
        output = [];
      }
    }
    // Literal trailing whitespace is transport padding and is not decoded data.
  }
  if (output.length) yield new Uint8Array(output);
}

function cap(value: number, maximum: number, label: string): void {
  if (value > maximum) throw new ArchiveError("budget-exceeded", `${label} limit exceeded.`);
}
