/** Bounded Apple-profile XAR1 inspection. The heap is borrowed, never extracted to host paths. @module */
import type { XmlElement } from "@std/xml/types";
import type { ByteSourceType } from "../source.ts";
import { sourceRange } from "../source.ts";
import { parseXmlRoot } from "../xml.ts";
import { close } from "../close.ts";
import { decompressStream } from "./compress.ts";
import { ArchiveBudget, ArchiveError, createArchiveLedger, integer, invalid, unsupported } from "./record.ts";
import type { ArchiveLimitsType, ArchiveWorkType } from "./record.ts";
export { ArchiveError, createArchiveLedger } from "./record.ts";
export type { ArchiveErrorCodeType, ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";

/** Checksums are consistency evidence, never proof of a trusted signer. */
export type XarChecksumStatusType = "verified" | "pending" | "not-provided";
/** Heap-relative stored extent. Unknown codecs and EA bytes remain inert metadata. */
export interface XarExtentType {
  readonly offset: number;
  readonly length: number;
  readonly size: number;
  readonly encoding: string;
}
/** A physical ordinal is independent of the archive's declared ID. Links are never followed. */
export interface XarEntryType {
  readonly id: number;
  readonly fileId: string;
  readonly path: string;
  readonly type: string;
  readonly data?: XarExtentType;
  readonly checksums?: { readonly archived?: XarChecksumType; readonly extracted?: XarChecksumType };
  readonly attributes: readonly { readonly name: string; readonly extent: XarExtentType }[];
}
/** Finite TOC admission happens before native decode or XML tree construction. */
export interface XarOpenOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly allowUnverifiedSource?: boolean;
  /** Default true. Header/TOC checksum agreement is required even when false. */
  readonly verifyToc?: boolean;
  /** Caller-supplied whole-buffer digest capability. No global crypto capability is discovered. */
  readonly subtle?: SubtleCrypto;
  /** Default 1 MiB each, hard8 MiB each. */
  readonly maxTocBytes?: number;
  readonly maxXmlBytes?: number;
  /** Default 10000; includes directories and links. */
  readonly maxEntries?: number;
  /** Default 20000 '<' tokens, hard 30000, bounding elements and XML markup before parsing. */
  readonly maxXmlTokens?: number;
  /** Retained index estimate: UTF8 TOC/path bytes +256 per entry +128 per EA. Default 4 MiB. */
  readonly maxMetadataBytes?: number;
  /** Default 4096 UTF8 bytes per complete logical path; no path normalization. */
  readonly maxPathBytes?: number;
  /** Default 1 MiB, hard 16 MiB. Bounds each whole checksum input before allocation. */
  readonly maxVerifyBytes?: number;
  /** Default 16 MiB, hard 64 MiB; bounds complete decoded selected members. */
  readonly maxMemberBytes?: number;
}
/** Stored unverified ranges are selective; compressed reads decode the complete selected member. */
export interface XarReadOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly offset?: number;
  readonly length?: number;
  /** Default true: verify all provided supported member digests over complete byte sequences. */
  readonly verify?: boolean;
}
/** TOC, stored data and decoded data have distinct checksum scopes. */
export interface XarReadType {
  readonly bytes: Uint8Array;
  readonly archived: XarChecksumStatusType;
  readonly extracted: XarChecksumStatusType;
  readonly work: ArchiveWorkType;
}
/** Bounded read-only index; original source and any credential/resource owners remain borrowed. */
export interface XarArchiveType {
  readonly format: "xar";
  readonly profile: "apple-v1";
  readonly entries: readonly XarEntryType[];
  readonly toc: { readonly checksum: string; readonly status: XarChecksumStatusType };
  readonly provenance: {
    readonly identity?: string;
    readonly stability: "immutable" | "provider" | "caller" | "unverified";
  };
  readonly work: ArchiveWorkType;
  read(id: number, options?: XarReadOptionsType): Promise<XarReadType>;
  /** Stored regular files only. Returned source supplies no per-read member checksum guarantee. */
  source(id: number, options?: Omit<XarReadOptionsType, "verify">): ByteSourceType;
}
/** A declared digest retains its wire algorithm label; unknown labels cannot authorize verification. */
export interface XarChecksumType {
  readonly algorithm: string;
  readonly hex: string;
}
/** Parsed authority data is separate from public physical extents and opaque EA metadata. */
interface DataType {
  readonly extent: XarExtentType;
  readonly archived?: XarChecksumType;
  readonly extracted?: XarChecksumType;
}
function cap(value: number, maximum: number, name: string): void {
  if (value > maximum) throw new ArchiveError("budget-exceeded", `${name} limit exceeded.`);
}
function elements(node: XmlElement): XmlElement[] {
  return node.children.filter((child): child is XmlElement => child.type === "element");
}
/** Authority fields are direct children. Descendant lookups could read an EA's offset as file data. */
function child(node: XmlElement, name: string): XmlElement | undefined {
  const matches = elements(node).filter((item) => item.name.raw === name);
  if (matches.length > 1) invalid(`Duplicate XAR ${name} field.`);
  return matches[0];
}
function text(node: XmlElement): string {
  if (elements(node).length) invalid("XAR scalar contains nested elements.");
  return node.children.map((part) => part.type === "text" || part.type === "cdata" ? part.text : "").join("");
}
function scalar(node: XmlElement, name: string): string {
  const value = child(node, name);
  if (!value) invalid(`Missing XAR ${name} field.`);
  return text(value);
}
function decimal(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) invalid("XAR integer must be canonical unsigned decimal.");
  const number = Number(value);
  if (!Number.isSafeInteger(number)) unsupported("XAR integer exceeds exact JavaScript range.");
  return number;
}
function wide(view: DataView, offset: number): number {
  const number = view.getBigUint64(offset);
  if (number > BigInt(Number.MAX_SAFE_INTEGER)) unsupported("XAR extent exceeds exact JavaScript range.");
  return Number(number);
}
function algorithm(name: string): { name: string; size: number } {
  switch (name) {
    case "sha1":
      return { name: "SHA-1", size: 20 };
    case "sha256":
      return { name: "SHA-256", size: 32 };
    case "sha512":
      return { name: "SHA-512", size: 64 };
    default:
      unsupported("XAR checksum algorithm is not supported.");
  }
}
function digestOf(node: XmlElement, name: string): XarChecksumType | undefined {
  const value = child(node, name);
  if (!value) return undefined;
  const nameOf = value.attributes.style;
  if (!nameOf) invalid("XAR checksum requires a style.");
  const hex = text(value);
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2) invalid("XAR checksum must be hexadecimal.");
  if (["sha1", "sha256", "sha512"].includes(nameOf) && hex.length !== algorithm(nameOf).size * 2) {
    invalid("XAR checksum length disagrees with algorithm.");
  }
  return Object.freeze({ algorithm: nameOf, hex: hex.toLowerCase() });
}
/** Whole-buffer WebCrypto is explicit and bounded; it is not a streaming digest implementation. */
async function check(
  bytes: Uint8Array,
  digest: XarChecksumType,
  subtle: Pick<SubtleCrypto, "digest">,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const value = new Uint8Array(await subtle.digest(algorithm(digest.algorithm).name, new Uint8Array(bytes).buffer));
  signal?.throwIfAborted();
  const hex = Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hex !== digest.hex) throw new ArchiveError("checksum-mismatch", "XAR checksum mismatch.");
}
/** Reserve aggregate source work before a collection buffer is allocated, then consume that credit exactly once. */
class XarBudget {
  readonly work: ArchiveBudget;
  readonly #reserve: (kind: keyof ArchiveWorkType, count: number) => void;
  #sourceCredit = 0;
  #requestCredit = 0;
  constructor(
    source: ByteSourceType,
    options: ArchiveLimitsType,
    signal: AbortSignal | undefined,
    reserve: (kind: keyof ArchiveWorkType, count: number) => void,
  ) {
    this.#reserve = reserve;
    this.work = new ArchiveBudget(source, {
      ...options,
      ledger: {
        reserve: (kind, count) => {
          if (kind === "sourceBytes" && this.#sourceCredit >= count) this.#sourceCredit -= count;
          else if (kind === "requests" && this.#requestCredit >= count) this.#requestCredit -= count;
          else reserve(kind, count);
        },
        inspect: () => this.work.inspect(),
      },
    }, signal);
  }
  get limits() {
    return this.work.limits;
  }
  inspect(): ArchiveWorkType {
    return this.work.inspect();
  }
  read(offset: number, length: number): Promise<Uint8Array> {
    return this.work.read(offset, length);
  }
  decoded(count: number): void {
    this.work.decoded(count);
  }
  output(count: number): void {
    this.work.output(count);
  }
  admit(length: number, requests: number): void {
    this.#reserve("sourceBytes", length);
    this.#sourceCredit += length;
    this.#reserve("requests", requests);
    this.#requestCredit += requests;
  }
}
/** Read source chunks into one admitted destination; native source buffers remain borrowed. */
async function collect(work: XarBudget, offset: number, length: number): Promise<Uint8Array> {
  cap(length, work.limits.maxSourceBytes - work.inspect().sourceBytes, "XAR source bytes");
  cap(Math.ceil(length / 65536), work.limits.maxRequests - work.inspect().requests, "XAR requests");
  work.admit(length, Math.ceil(length / 65536));
  const output = new Uint8Array(length);
  for (let done = 0; done < length;) {
    const chunk = await work.read(offset + done, Math.min(65536, length - done));
    output.set(chunk, done);
    done += chunk.length;
  }
  return output;
}
/** The compression owner retires native readers/pipelines at EOF or cancellation before this returns. */
async function inflate(bytes: Uint8Array, size: number, signal?: AbortSignal): Promise<Uint8Array> {
  let offset = 0;
  const input = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) {
        controller.close();
        return;
      }
      const chunk = bytes.subarray(offset, offset + 65536);
      offset += chunk.length;
      controller.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
  const output = new Uint8Array(size);
  const reader = decompressStream(input, "deflate", {
    ...(signal ? { signal } : {}),
    maxSourceBytes: bytes.length,
    maxDecodedBytes: size,
    maxOutputBytes: size,
    maxRequests: Math.ceil(bytes.length / 65536) + 1,
  }).getReader();
  let done = false, readFailed = false;
  let used = 0;
  try {
    while (true) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (reason) {
        readFailed = true;
        throw reason;
      }
      if (next.done) {
        done = true;
        break;
      }
      cap(next.value.length, size - used, "XAR decoded size");
      output.set(next.value, used);
      used += next.value.length;
    }
    if (used !== size) invalid("XAR decoded length disagrees with TOC.");
  } catch (error) {
    await close([async () => {
      if (!done && !readFailed) await reader.cancel(error);
    }, () => reader.releaseLock()], [error]);
    throw error;
  }
  reader.releaseLock();
  return output;
}
/**
 * Index Apple-style XAR1 with a 28-byte header. Header codes 3/4 are SHA256/SHA512;
 * the different named-hash extension in historical XAR documentation is rejected.
 * The compressed TOC is materialized and decoded once. Heap member bytes are read only on selection.
 */
export async function openXar(input: ByteSourceType, options: XarOpenOptionsType = {}): Promise<XarArchiveType> {
  options = { ...options };
  const { size, identity, stability } = input;
  integer(size, "XAR source size");
  if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown XAR source stability.");
  }
  if (!stability && !options.allowUnverifiedSource) {
    unsupported("XAR requires stable source evidence or explicit unverified-source acceptance.");
  }
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("XAR identity exceeds 8192 UTF16 code units.");
  }
  const source: ByteSourceType = {
    size,
    read: input.read.bind(input),
    ...(identity === undefined ? {} : { identity }),
    ...(stability === undefined ? {} : { stability }),
  };
  const policy = {
    toc: options.maxTocBytes ?? 1048576,
    xml: options.maxXmlBytes ?? 1048576,
    entries: options.maxEntries ?? 10000,
    tokens: options.maxXmlTokens ?? 20000,
    metadata: options.maxMetadataBytes ?? 4194304,
    path: options.maxPathBytes ?? 4096,
    verify: options.maxVerifyBytes ?? 1048576,
    member: options.maxMemberBytes ?? 16777216,
  };
  for (const [name, count] of Object.entries(policy)) integer(count, name);
  if (
    policy.toc > 8388608 || policy.xml > 8388608 || policy.tokens > 30000 || policy.verify > 16777216 ||
    policy.member > 67108864
  ) {
    throw new RangeError("XAR implementation ceiling exceeded.");
  }
  // Capture the injected operation before source awaits can run foreign application callbacks.
  const subtle = options.subtle === undefined ? undefined : { digest: options.subtle.digest.bind(options.subtle) };
  const aggregate = createArchiveLedger(options);
  const reserve = (kind: keyof ArchiveWorkType, count: number): void => {
    aggregate.reserve(kind, count);
    options.ledger?.reserve(kind, count);
  };
  const opening = new XarBudget(source, options, options.signal, reserve);
  const header = await opening.read(0, 28);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getUint32(0) !== 0x78617221) invalid("Missing XAR magic.");
  if (view.getUint16(4) !== 28 || view.getUint16(6) !== 1) {
    unsupported("Only 28-byte Apple-profile XAR1 headers are supported.");
  }
  const compressed = wide(view, 8), decoded = wide(view, 16), code = view.getUint32(24);
  const name = code === 0
    ? "none"
    : code === 1
    ? "sha1"
    : code === 3
    ? "sha256"
    : code === 4
    ? "sha512"
    : unsupported("Unsupported Apple XAR TOC checksum code.");
  cap(compressed, policy.toc, "XAR compressed TOC");
  cap(decoded, policy.xml, "XAR XML bytes");
  cap(decoded, policy.metadata, "XAR retained metadata");
  sourceRange(size, 28, compressed);
  if (options.verifyToc !== false && name !== "none") {
    if (!subtle) unsupported("XAR TOC verification requires caller-supplied SubtleCrypto.");
    cap(compressed, policy.verify, "XAR verification bytes");
  }
  opening.decoded(decoded + (options.verifyToc !== false && name !== "none" ? compressed : 0));
  const packed = await collect(opening, 28, compressed);
  const xml = await inflate(packed, decoded, options.signal);
  const value = new TextDecoder("utf-8", { fatal: true }).decode(xml);
  if (/<!DOCTYPE|<!ENTITY/i.test(value)) unsupported("XAR DTD/entity declarations are forbidden.");
  let tokens = 0;
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) === 60) cap(++tokens, policy.tokens, "XAR XML tokens");
  }
  const root = parseXmlRoot(value);
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (
      node.name.raw.includes(":") || Object.keys(node.attributes).some((key) => key.includes(":") || key === "xmlns")
    ) unsupported("XAR XML namespaces are not supported.");
    const seen = new Set<string>();
    for (const item of elements(node)) {
      const key = item.name.raw;
      if (key !== "file" && key !== "ea" && seen.has(key)) invalid(`Duplicate XAR ${key} field.`);
      seen.add(key);
      pending.push(item);
    }
  }
  if (root.name.raw !== "xar") invalid("XAR root element is missing.");
  const toc = child(root, "toc");
  if (!toc) invalid("XAR TOC is missing.");
  if (["heap", "encoding", "encryption"].some((name) => child(toc, name))) {
    unsupported("Whole-heap XAR transforms are not supported.");
  }
  const heap = 28 + compressed;
  const heapSize = size - heap;
  const checksum = child(toc, "checksum");
  let tocStatus: XarChecksumStatusType = "not-provided";
  let checksumRange: { offset: number; length: number } | undefined;
  if (name === "none") {
    if (checksum && checksum.attributes.style !== "none") invalid("XAR header/TOC checksum disagreement.");
  } else {
    if (!checksum || checksum.attributes.style !== name) invalid("XAR header/TOC checksum disagreement.");
    const offset = decimal(scalar(checksum, "offset")), length = decimal(scalar(checksum, "size"));
    if (length !== algorithm(name).size) invalid("XAR TOC digest length disagrees with algorithm.");
    sourceRange(heapSize, offset, length);
    checksumRange = { offset, length };
    tocStatus = "pending";
    if (options.verifyToc !== false) {
      const expected = await opening.read(heap + offset, length);
      await check(
        packed,
        { algorithm: name, hex: Array.from(expected, (byte) => byte.toString(16).padStart(2, "0")).join("") },
        subtle!,
        options.signal,
      );
      tocStatus = "verified";
    }
  }
  function dataOf(node: XmlElement, attribute = false): DataType {
    for (const item of elements(node)) {
      if (
        !(attribute && item.name.raw === "name") &&
        !["offset", "length", "size", "encoding", "archived-checksum", "extracted-checksum"].includes(item.name.raw)
      ) unsupported("Unsupported XAR data transform or inline content.");
    }
    const offset = decimal(scalar(node, "offset")),
      length = decimal(scalar(node, "length")),
      size = decimal(scalar(node, "size"));
    sourceRange(heapSize, offset, length);
    if (
      checksumRange && length && offset < checksumRange.offset + checksumRange.length &&
      checksumRange.offset < offset + length
    ) invalid("XAR data overlaps the TOC digest.");
    const encoding = child(node, "encoding")?.attributes.style ?? "application/octet-stream";
    if (encoding === "application/octet-stream" && length !== size) invalid("XAR stored sizes disagree.");
    const archived = digestOf(node, "archived-checksum"), extracted = digestOf(node, "extracted-checksum");
    return {
      extent: Object.freeze({ offset, length, size, encoding }),
      ...(archived ? { archived } : {}),
      ...(extracted ? { extracted } : {}),
    };
  }
  const entries: XarEntryType[] = [], data: (DataType | undefined)[] = [];
  const ids = new Set<string>(), paths = new Set<string>();
  let retained = decoded;
  const stack = elements(toc).filter((node) => node.name.raw === "file").reverse().map((node) => ({
    node,
    parent: "",
    depth: 1,
  }));
  while (stack.length) {
    const { node, parent, depth } = stack.pop()!;
    cap(entries.length + 1, policy.entries, "XAR entries");
    cap(depth, 32, "XAR file depth");
    cap(retained + 256, policy.metadata, "XAR retained metadata");
    retained += 256;
    const fileId = node.attributes.id;
    if (!fileId || !/^(0|[1-9][0-9]*)$/.test(fileId) || ids.has(fileId)) {
      invalid("XAR file IDs must be unique unsigned decimals.");
    }
    ids.add(fileId);
    const nameOf = scalar(node, "name");
    if (
      !nameOf || nameOf === "." || nameOf === ".." || Array.from(nameOf).some((part) => {
        const code = part.codePointAt(0)!;
        return code < 32 || code === 127 || code === 47 || code === 92 || (code >= 0xd800 && code <= 0xdfff);
      })
    ) {
      unsupported("XAR unsafe filename component.");
    }
    const nameNode = child(node, "name")!;
    if (Object.keys(nameNode.attributes).length) unsupported("Encoded XAR names are outside this UTF8 profile.");
    const path = parent ? `${parent}/${nameOf}` : nameOf;
    cap(path.length, policy.path, "XAR path bytes");
    const pathBytes = new TextEncoder().encode(path).length;
    cap(pathBytes, policy.path, "XAR path bytes");
    cap(retained + pathBytes, policy.metadata, "XAR retained metadata");
    retained += pathBytes;
    if (paths.has(path)) invalid("Duplicate XAR logical path.");
    paths.add(path);
    const type = scalar(node, "type"), dataNode = child(node, "data");
    if (child(node, "encryption")) unsupported("Encrypted XAR members are not supported.");
    if (child(node, "content") || child(node, "encoding")) {
      unsupported("XAR inline content or file transforms are not supported.");
    }
    const content = dataNode ? dataOf(dataNode) : undefined;
    if (!content && type === "file" && child(node, "size") && decimal(scalar(node, "size")) !== 0) {
      invalid("XAR regular file declares bytes without a data extent.");
    }
    const attributes: { name: string; extent: XarExtentType }[] = [];
    for (const ea of elements(node).filter((item) => item.name.raw === "ea")) {
      cap(retained + 128, policy.metadata, "XAR retained metadata");
      retained += 128;
      attributes.push(Object.freeze({ name: scalar(ea, "name"), extent: dataOf(ea, true).extent }));
    }
    entries.push(
      Object.freeze({
        id: entries.length,
        fileId,
        path,
        type,
        ...(content
          ? {
            data: content.extent,
            checksums: Object.freeze({
              ...(content.archived ? { archived: content.archived } : {}),
              ...(content.extracted ? { extracted: content.extracted } : {}),
            }),
          }
          : {}),
        attributes: Object.freeze(attributes),
      }),
    );
    data.push(content);
    const nested = elements(node).filter((item) => item.name.raw === "file");
    if (nested.length && type !== "directory") invalid("Only XAR directories can contain child files.");
    for (let index = nested.length - 1; index >= 0; index--) {
      stack.push({ node: nested[index]!, parent: path, depth: depth + 1 });
    }
  }
  function selected(id: number): { entry: XarEntryType; data?: DataType } {
    integer(id, "XAR entry ID");
    const entry = entries[id];
    if (!entry) throw new RangeError("Unknown XAR entry ID.");
    if (entry.type !== "file") unsupported("XAR reads support regular files only; links are never followed.");
    const content = data[id];
    return { entry, ...(content ? { data: content } : {}) };
  }
  function operation(call: XarReadOptionsType): XarBudget {
    const local = createArchiveLedger(call);
    return new XarBudget(source, call, call.signal ?? options.signal, (kind, count) => {
      local.reserve(kind, count);
      reserve(kind, count);
      if (call.ledger && call.ledger !== options.ledger) call.ledger.reserve(kind, count);
    });
  }
  const archive: XarArchiveType = {
    format: "xar",
    profile: "apple-v1",
    entries: Object.freeze(entries),
    toc: Object.freeze({ checksum: name, status: tocStatus }),
    provenance: Object.freeze({
      ...(identity === undefined ? {} : { identity }),
      stability: stability ?? "unverified",
    }),
    work: opening.inspect(),
    async read(id, call = {}): Promise<XarReadType> {
      call = { ...call };
      const item = selected(id), extent = item.data?.extent;
      const size = extent?.size ?? 0, offset = call.offset ?? 0, length = call.length ?? size - offset;
      sourceRange(size, offset, length);
      const work = operation(call), signal = call.signal ?? options.signal;
      signal?.throwIfAborted();
      const archived = item.data?.archived, extracted = item.data?.extracted;
      let a: XarChecksumStatusType = archived ? "pending" : "not-provided",
        e: XarChecksumStatusType = extracted ? "pending" : "not-provided";
      if (!extent) {
        work.output(length);
        return { bytes: new Uint8Array(), archived: a, extracted: e, work: work.inspect() };
      }
      const stored = extent.encoding === "application/octet-stream";
      if (!stored && extent.encoding !== "application/x-gzip") {
        unsupported(`XAR member encoding ${extent.encoding} is unsupported.`);
      }
      const verify = call.verify !== false && (!!archived || !!extracted);
      if (verify) {
        if (!subtle) unsupported("XAR member verification requires caller-supplied SubtleCrypto.");
        for (const digest of [archived, extracted]) if (digest) algorithm(digest.algorithm);
        if (archived) cap(extent.length, policy.verify, "XAR verification bytes");
        if (extracted) cap(size, policy.verify, "XAR verification bytes");
      }
      const complete = verify || !stored;
      if (complete) cap(extent.length, 67108864, "XAR stored member implementation bytes");
      const decodeBytes = complete ? size : length;
      if (complete) cap(size, policy.member, "XAR decoded member");
      // Admit output and decoded/hash work before acquiring member buffers or source ranges.
      work.output(length);
      work.decoded(decodeBytes + (verify && archived ? extent.length : 0) + (verify && extracted ? size : 0));
      const packed = await collect(
        work,
        heap + extent.offset + (complete ? 0 : offset),
        complete ? extent.length : length,
      );
      const bytes = stored ? packed : await inflate(packed, size, signal);
      if (verify && archived) {
        await check(packed, archived, subtle!, signal);
        a = "verified";
      }
      if (verify && extracted) {
        await check(bytes, extracted, subtle!, signal);
        e = "verified";
      }
      signal?.throwIfAborted();
      return {
        bytes: complete ? bytes.slice(offset, offset + length) : bytes,
        archived: a,
        extracted: e,
        work: work.inspect(),
      };
    },
    source(id, call = {}): ByteSourceType {
      call = { ...call };
      const item = selected(id), extent = item.data?.extent;
      if (extent && extent.encoding !== "application/octet-stream") {
        unsupported("Only stored XAR members expose random-access sources.");
      }
      const size = extent?.size ?? 0, offset = call.offset ?? 0, length = call.length ?? size - offset;
      sourceRange(size, offset, length);
      const total = createArchiveLedger(call), captured = call;
      const capturedSignal = captured.signal ?? options.signal;
      return Object.freeze({
        size: length,
        ...(identity === undefined
          ? {}
          : { identity: JSON.stringify([identity, "xar-apple-v1", id, extent?.offset ?? null, offset, length]) }),
        ...(stability === undefined ? {} : { stability }),
        async read(at: number, count: number, readOptions: { signal?: AbortSignal } = {}) {
          sourceRange(length, at, count);
          const signal = capturedSignal && readOptions.signal
            ? AbortSignal.any([capturedSignal, readOptions.signal])
            : readOptions.signal ?? capturedSignal;
          return (await archive.read(id, {
            ...captured,
            offset: offset + at,
            length: count,
            verify: false,
            ledger: {
              reserve(kind, value) {
                total.reserve(kind, value);
                if (captured.ledger && captured.ledger !== options.ledger) captured.ledger.reserve(kind, value);
              },
              inspect: () => total.inspect(),
            },
            ...(signal ? { signal } : {}),
          })).bytes;
        },
      });
    },
  };
  return Object.freeze(archive);
}
