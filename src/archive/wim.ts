/** Ordinary stored/XPRESS WIM resource and selected-image inspection; no Windows restoration. @module */
import type { XmlElement } from "@std/xml/types";
import type { ByteSourceType } from "../source.ts";
import { sourceRange } from "../source.ts";
import { parseXmlRoot } from "../xml.ts";
import { decodeXpress } from "./xpress.ts";
import { ArchiveBudget, ArchiveError, createArchiveLedger, integer, invalid, unsupported } from "./record.ts";
import type { ArchiveLimitsType, ArchiveWorkType } from "./record.ts";
export { ArchiveError, createArchiveLedger } from "./record.ts";
export type { ArchiveErrorCodeType, ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";

/** Physical resource identity is independent of filenames and image indices. */
export interface WimResourceType {
  readonly id: number;
  readonly kind: "metadata" | "data";
  readonly offset: number;
  /** Logical decoded resource bytes. */ readonly size: number;
  /** Physical bytes including a compressed resource's chunk table. */ readonly storedSize: number;
  readonly compression: "stored" | "xpress-huffman";
  readonly sha1: string;
  readonly references: number;
}
/** Metadata resources are assigned by their order in the blob table, not XML or physical order. */
export interface WimImageType {
  readonly index: number;
  readonly name?: string;
  readonly metadata: number;
}
/** Extra stream declarations remain visible, but this first profile does not interpret their data semantics. */
export interface WimStreamType {
  readonly name: string;
  readonly sha1: string;
}
/** Reparse points, encrypted entries and alternate streams never become an ordinary-file read accidentally. */
export interface WimEntryType {
  readonly id: number;
  readonly path: string;
  readonly type: "file" | "directory" | "reparse" | "encrypted";
  readonly attributes: number;
  readonly security: number | null;
  readonly sha1: string;
  readonly resource?: number;
  readonly size: number;
  readonly hardlink: string;
  readonly streams: readonly WimStreamType[];
}
/** Source/crypto capabilities are borrowed and captured before the first asynchronous read. */
export interface WimOpenOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly allowUnverifiedSource?: boolean;
  readonly subtle?: SubtleCrypto;
  /** Default 128 images. */ readonly maxImages?: number;
  /** Default 50000 resources. Table entries are 50 bytes each. */ readonly maxResources?: number;
  /** Default 16 MiB estimate, 256 bytes per retained resource. */ readonly maxResourceIndexBytes?: number;
  /** Default 4 MiB, hard 8 MiB. */ readonly maxTableBytes?: number;
  /** Default 1 MiB, hard 8 MiB. */ readonly maxXmlBytes?: number;
  /** Per-resource chunk table: default 256 KiB, hard 2 MiB. */ readonly maxChunkTableBytes?: number;
  /** Per-resource chunks: default 65536, hard 262144. */ readonly maxXpressChunks?: number;
  /** Per-read data-dependent codec work: default 16 Mi, hard 64 Mi steps. */ readonly maxXpressSteps?: number;
  /** Whole-buffer SHA1 input: default 1 MiB, hard 16 MiB. */ readonly maxVerifyBytes?: number;
}
/** Full verification can read/hash the complete resource even when only a prefix is returned. */
export interface WimReadOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly offset?: number;
  readonly length?: number;
  /** Default true. Requires injected SubtleCrypto; false returns pending evidence. */ readonly verify?: boolean;
}
/** Resource SHA1 checks are consistency evidence, not authenticity or whole-image verification. */
export interface WimReadType {
  readonly bytes: Uint8Array;
  readonly integrity: "resource-sha1-verified" | "pending" | "not-provided";
  readonly work: ArchiveWorkType;
  /** Cumulative codec work in this operation; zero for stored resources. */ readonly xpressSteps: number;
}
/** The entire selected metadata resource is buffered; other image metadata is not parsed. */
export interface WimImageOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  /** Default true. Verify the selected metadata resource SHA1 before parsing. */ readonly verify?: boolean;
  /** Default 8 MiB, hard 16 MiB. */ readonly maxMetadataBytes?: number;
  /** Default 10000, including the unnamed root. */ readonly maxEntries?: number;
  /** Default 32, hard 64. */ readonly maxDepth?: number;
  /** Default 32 extra streams per entry. */ readonly maxStreams?: number;
  /** Default 4096 security descriptors. They remain opaque and are never applied. */ readonly maxSecurity?: number;
  /** Default 4096 bytes for one UTF16LE component. */ readonly maxNameBytes?: number;
  /** Default 4096 UTF16 code units for one full path. */ readonly maxPathLength?: number;
  /** Default 4 MiB estimate: occupancy bitmap +256/entry + path UTF16 bytes +128/stream. */ readonly maxIndexBytes?:
    number;
}
/** Read-only namespace; file IDs are physical dentry ordinals and paths are never host destinations. */
export interface WimImageViewType {
  readonly image: WimImageType;
  readonly entries: readonly WimEntryType[];
  readonly metadataIntegrity: "resource-sha1-verified" | "pending";
  /** Codec work for this image's metadata read; later file reads report their own work. */
  readonly xpressSteps: number;
  readonly work: ArchiveWorkType;
  read(id: number, options?: WimReadOptionsType): Promise<WimReadType>;
  source(id: number, options?: Omit<WimReadOptionsType, "verify">): ByteSourceType;
}
/** The original source remains borrowed. Integrity-table presence is not verification. */
export interface WimArchiveType {
  readonly format: "wim";
  readonly profile: "uncompressed-1.13" | "xpress-huffman-32k-1.13";
  readonly images: readonly WimImageType[];
  readonly resources: readonly WimResourceType[];
  readonly integrityTable: "absent" | "present-unverified";
  readonly provenance: {
    readonly identity?: string;
    readonly stability: "immutable" | "provider" | "caller" | "unverified";
  };
  readonly work: ArchiveWorkType;
  image(index: number, options?: WimImageOptionsType): Promise<WimImageViewType>;
  read(id: number, options?: WimReadOptionsType): Promise<WimReadType>;
  /** Exact logical resource bytes; compressed reads decode intersecting chunks without SHA1 verification. */
  source(id: number, options?: Omit<WimReadOptionsType, "verify">): ByteSourceType;
}
interface ExtentType {
  readonly offset: number;
  readonly size: number;
  readonly flags: number;
  readonly decoded: number;
}
/** Parent cancellation authority cannot be replaced by a fresh narrower-operation signal. */
function signals(...values: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = values.filter((value): value is AbortSignal => value !== undefined);
  return present.length > 1 ? AbortSignal.any(present) : present[0];
}
function cap(value: number, maximum: number, label: string): void {
  if (value > maximum) throw new ArchiveError("budget-exceeded", `${label} limit exceeded.`);
}
function wide(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) unsupported("WIM extent exceeds exact JavaScript integers.");
  return Number(value);
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** The first seven bytes are a 56-bit stored size, followed by flags, not a single 64-bit size. */
function extent(view: DataView, offset: number, sourceSize: number, xpress = false): ExtentType {
  const word = view.getBigUint64(offset, true), stored = word & 0xffffffffffffffn;
  if (stored > BigInt(Number.MAX_SAFE_INTEGER)) unsupported("WIM resource size exceeds exact JavaScript integers.");
  const size = Number(stored),
    flags = Number(word >> 56n),
    at = wide(view, offset + 8),
    decoded = wide(view, offset + 16);
  if (flags & ~(xpress ? 6 : 2)) unsupported("This WIM resource encoding is outside the selected profile.");
  if (!(flags & 4) && size !== decoded) invalid("Uncompressed WIM resource lengths disagree.");
  sourceRange(sourceSize, at, size);
  if (size && at < 208) invalid("WIM resource overlaps the fixed header.");
  return { offset: at, size, flags, decoded };
}
function children(node: XmlElement, name: string): XmlElement[] {
  return node.children.filter((part): part is XmlElement => part.type === "element" && part.name.raw === name);
}
function scalar(node: XmlElement, name: string): string | undefined {
  const found = children(node, name);
  if (found.length > 1) invalid(`Duplicate WIM XML ${name}.`);
  const child = found[0];
  if (!child) return undefined;
  if (child.children.some((part) => part.type === "element")) invalid("Nested WIM XML scalar.");
  return child.children.map((part) => part.type === "text" || part.type === "cdata" ? part.text : "").join("");
}
/** Aggregate reservations precede collection buffers; local accounting consumes each credit exactly once. */
class WimBudget {
  readonly work: ArchiveBudget;
  readonly #reserve: (kind: keyof ArchiveWorkType, count: number) => void;
  #bytes = 0;
  #requests = 0;
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
          if (kind === "sourceBytes" && this.#bytes >= count) this.#bytes -= count;
          else if (kind === "requests" && this.#requests >= count) this.#requests -= count;
          else reserve(kind, count);
        },
        inspect: () => this.work.inspect(),
      },
    }, signal);
  }
  /** Reserve a complete payload plan before allocating its result, then consume credits during collection. */
  prepare(length: number, requests = Math.ceil(length / 65536)): void {
    const bytes = Math.max(0, length - this.#bytes), count = Math.max(0, requests - this.#requests);
    cap(bytes, this.work.limits.maxSourceBytes - this.work.inspect().sourceBytes - this.#bytes, "WIM source bytes");
    cap(count, this.work.limits.maxRequests - this.work.inspect().requests - this.#requests, "WIM requests");
    this.#reserve("sourceBytes", bytes);
    this.#bytes += bytes;
    this.#reserve("requests", count);
    this.#requests += count;
  }
  async collect(offset: number, length: number): Promise<Uint8Array> {
    this.prepare(length);
    const out = new Uint8Array(length);
    for (let done = 0; done < length;) {
      const part = await this.work.read(offset + done, Math.min(65536, length - done));
      out.set(part, done);
      done += part.length;
    }
    return out;
  }
}
/** Parse an ordinary stored/XPRESS WIM, then open only the image metadata selected by the caller. */
export async function openWim(input: ByteSourceType, options: WimOpenOptionsType = {}): Promise<WimArchiveType> {
  options = { ...options };
  const { size, identity, stability } = input;
  integer(size, "WIM source size");
  if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown WIM stability evidence.");
  }
  if (!stability && !options.allowUnverifiedSource) {
    unsupported("WIM requires stable source evidence or explicit unverified-source acceptance.");
  }
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("WIM identity exceeds 8192 UTF16 code units.");
  }
  const source: ByteSourceType = {
    size,
    read: input.read.bind(input),
    ...(identity === undefined ? {} : { identity }),
    ...(stability === undefined ? {} : { stability }),
  };
  const digest = options.subtle?.digest.bind(options.subtle);
  const policy = {
    images: options.maxImages ?? 128,
    resources: options.maxResources ?? 50000,
    index: options.maxResourceIndexBytes ?? 16777216,
    table: options.maxTableBytes ?? 4194304,
    xml: options.maxXmlBytes ?? 1048576,
    verify: options.maxVerifyBytes ?? 1048576,
    chunkTable: options.maxChunkTableBytes ?? 262144,
    chunks: options.maxXpressChunks ?? 65536,
    steps: options.maxXpressSteps ?? 16777216,
  };
  for (const [name, value] of Object.entries(policy)) integer(value, name);
  if (
    policy.table > 8388608 || policy.xml > 8388608 || policy.verify > 16777216 ||
    policy.chunkTable > 2097152 || policy.chunks > 262144 || policy.steps > 67108864
  ) {
    throw new RangeError("WIM implementation ceiling exceeded.");
  }
  const openingLedger = createArchiveLedger(options);
  const reserve = (kind: keyof ArchiveWorkType, count: number): void => {
    openingLedger.reserve(kind, count);
    options.ledger?.reserve(kind, count);
  };
  function operation(call: ArchiveLimitsType & { readonly signal?: AbortSignal }): WimBudget {
    const local = createArchiveLedger(call);
    return new WimBudget(source, call, signals(options.signal, call.signal), (kind, count) => {
      local.reserve(kind, count);
      reserve(kind, count);
      if (call.ledger && call.ledger !== options.ledger) call.ledger.reserve(kind, count);
    });
  }
  const opening = new WimBudget(source, options, options.signal, reserve);
  const header = await opening.work.read(0, 208),
    view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (hex(header.subarray(0, 8)) !== "4d5357494d000000") invalid("Missing ordinary MSWIM signature.");
  if (view.getUint32(8, true) !== 208 || view.getUint32(12, true) !== 0x10d00) {
    unsupported("Only 208-byte ordinary WIM version 1.13 is supported.");
  }
  const flags = view.getUint32(16, true), mode = flags & 0x20002;
  const xpress = mode === 0x20002;
  if (flags & ~0x20086 || (mode !== 0 && !xpress) || view.getUint32(20, true) !== (xpress ? 32768 : 0)) {
    unsupported("Only stored or ordinary 32 KiB XPRESS-Huffman WIM resources are supported.");
  }
  if (view.getUint16(40, true) !== 1 || view.getUint16(42, true) !== 1) {
    unsupported("Split WIM parts require a separate profile.");
  }
  const count = view.getUint32(44, true);
  cap(count, policy.images, "WIM images");
  if (!count) unsupported("This WIM profile requires at least one image.");
  const table = extent(view, 48, size),
    xml = extent(view, 72, size),
    boot = extent(view, 96, size, xpress),
    integrity = extent(view, 124, size);
  const bootIndex = view.getUint32(120, true);
  if (bootIndex > count || (!bootIndex && boot.size)) invalid("WIM boot metadata index is inconsistent.");
  cap(table.size, policy.table, "WIM table bytes");
  cap(xml.size, policy.xml, "WIM XML bytes");
  if (table.size % 50) invalid("WIM blob table is not a multiple of 50 bytes.");
  cap(table.size / 50, policy.resources, "WIM resources");
  cap(table.size / 50 * 256, policy.index, "WIM resource index bytes");
  opening.work.decoded(table.size + xml.size);
  const tableBytes = await opening.collect(table.offset, table.size), tableView = new DataView(tableBytes.buffer);
  const resources: WimResourceType[] = [], metadata: number[] = [], hashes = new Map<string, number>();
  for (let offset = 0; offset < table.size; offset += 50) {
    const item = extent(tableView, offset, size, xpress), sha1 = hex(tableBytes.subarray(offset + 30, offset + 50));
    if (tableView.getUint16(offset + 24, true) !== 1) unsupported("WIM resource references another part.");
    if (sha1 === "0".repeat(40) || !item.size || !item.decoded) {
      invalid("WIM blob table contains an empty hash/resource.");
    }
    const resource: WimResourceType = Object.freeze({
      id: resources.length,
      kind: item.flags & 2 ? "metadata" : "data",
      offset: item.offset,
      size: item.decoded,
      storedSize: item.size,
      compression: item.flags & 4 ? "xpress-huffman" : "stored",
      sha1,
      references: tableView.getUint32(offset + 26, true),
    });
    if (resource.kind === "metadata") metadata.push(resource.id);
    else {
      if (hashes.has(sha1)) invalid("Ambiguous duplicate WIM data hash.");
      hashes.set(sha1, resource.id);
    }
    resources.push(resource);
  }
  if (metadata.length !== count) invalid("WIM image count disagrees with metadata resources.");
  if (bootIndex) {
    const resource = resources[metadata[bootIndex - 1]!]!;
    if (
      resource.offset !== boot.offset || resource.storedSize !== boot.size || resource.size !== boot.decoded ||
      resource.compression !== (boot.flags & 4 ? "xpress-huffman" : "stored") || !(boot.flags & 2)
    ) {
      invalid("WIM boot metadata differs from indexed image.");
    }
  }
  const xmlBytes = await opening.collect(xml.offset, xml.size);
  if (xmlBytes.length % 2) invalid("WIM XML must contain complete UTF16LE units.");
  const text = new TextDecoder("utf-16le", { fatal: true }).decode(xmlBytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) unsupported("WIM XML DTD/entity declarations are forbidden.");
  let tokens = 0;
  for (const char of text) if (char === "<") cap(++tokens, 20000, "WIM XML tokens");
  const root = parseXmlRoot(text);
  if (root.name.raw !== "WIM") invalid("WIM XML root is missing.");
  const nodes = [root];
  while (nodes.length) {
    const node = nodes.pop()!;
    if (
      node.name.raw.includes(":") || Object.keys(node.attributes).some((key) => key.includes(":") || key === "xmlns")
    ) unsupported("WIM XML namespaces are unsupported.");
    for (const child of node.children) if (child.type === "element") nodes.push(child);
  }
  const imageNodes = children(root, "IMAGE");
  if (imageNodes.length !== count) invalid("WIM XML image count disagrees with header.");
  const names = new Map<number, string>();
  for (const node of imageNodes) {
    const indexText = node.attributes.INDEX;
    if (!indexText || !/^[1-9][0-9]*$/.test(indexText)) invalid("WIM XML image index is invalid.");
    const index = Number(indexText);
    if (!Number.isSafeInteger(index) || index > count || names.has(index)) {
      invalid("WIM XML image indices are ambiguous.");
    }
    names.set(index, scalar(node, "NAME") ?? "");
  }
  const images: WimImageType[] = metadata.map((id, ordinal) =>
    Object.freeze({
      index: ordinal + 1,
      metadata: id,
      ...(names.get(ordinal + 1) ? { name: names.get(ordinal + 1)! } : {}),
    })
  );
  function resourceOf(id: number): WimResourceType {
    integer(id, "WIM resource ID");
    const value = resources[id];
    if (!value) throw new RangeError("Unknown WIM resource ID.");
    return value;
  }
  /** Validate the complete ordinary chunk table, then reserve all selected work before the result buffer. */
  async function compressed(
    item: WimResourceType,
    offset: number,
    length: number,
    work: WimBudget,
    signal: AbortSignal | undefined,
  ): Promise<{ bytes: Uint8Array; steps: number }> {
    if (!length) return { bytes: new Uint8Array(0), steps: 0 };
    const chunks = Math.ceil(item.size / 32768), width = item.size < 4294967296 ? 4 : 8;
    cap(chunks, policy.chunks, "WIM resource chunks");
    const tableLength = (chunks - 1) * width;
    cap(tableLength, policy.chunkTable, "WIM chunk table bytes");
    if (tableLength >= item.storedSize) invalid("WIM chunk table exceeds its resource.");
    work.work.decoded(tableLength);
    const table = await work.collect(item.offset, tableLength), view = new DataView(table.buffer);
    const packedSize = item.storedSize - tableLength;
    const boundary = (index: number): number =>
      index === 0
        ? 0
        : index === chunks
        ? packedSize
        : width === 4
        ? view.getUint32((index - 1) * width, true)
        : wide(view, (index - 1) * width);
    const plan: { offset: number; packed: number; decoded: number; logical: number }[] = [];
    let start = 0, sourceBytes = 0, decodedBytes = 0;
    for (let index = 0; index < chunks; index++) {
      signal?.throwIfAborted();
      const end = boundary(index + 1), logical = index * 32768, decoded = Math.min(32768, item.size - logical);
      if (end <= start || end > packedSize || end - start > decoded) {
        invalid("WIM chunk offsets or lengths are invalid.");
      }
      if (logical < offset + length && logical + decoded > offset) {
        plan.push({ offset: item.offset + tableLength + start, packed: end - start, decoded, logical });
        sourceBytes += end - start;
        decodedBytes += decoded;
      }
      start = end;
    }
    work.work.decoded(decodedBytes);
    work.prepare(sourceBytes, plan.length);
    const bytes = new Uint8Array(length);
    let steps = 0;
    for (const part of plan) {
      signal?.throwIfAborted();
      const packed = await work.collect(part.offset, part.packed);
      let decoded = packed;
      if (part.packed !== part.decoded) {
        decoded = new Uint8Array(part.decoded);
        decodeXpress(packed, decoded, (count) => {
          signal?.throwIfAborted();
          cap(count, policy.steps - steps, "WIM XPRESS steps");
          steps += count;
        });
      }
      signal?.throwIfAborted();
      const start = Math.max(offset, part.logical), end = Math.min(offset + length, part.logical + part.decoded);
      bytes.set(decoded.subarray(start - part.logical, end - part.logical), start - offset);
    }
    return { bytes, steps };
  }
  async function read(id: number, call: WimReadOptionsType = {}, internal = false): Promise<WimReadType> {
    call = { ...call };
    const item = resourceOf(id), offset = call.offset ?? 0, length = call.length ?? item.size - offset;
    sourceRange(item.size, offset, length);
    const signal = signals(options.signal, call.signal);
    signal?.throwIfAborted();
    const verify = call.verify !== false;
    if (verify) {
      if (!digest) unsupported("WIM SHA1 verification requires caller-supplied SubtleCrypto.");
      cap(item.size, policy.verify, "WIM verification bytes");
    }
    // A buffered preview remains finite even when a caller raises generic work limits.
    cap(verify ? item.size : length, 16777216, "WIM buffered read bytes");
    const work = operation(call);
    work.work.output(internal ? 0 : length);
    let bytes: Uint8Array, xpressSteps = 0;
    if (item.compression === "stored") {
      work.work.decoded((verify ? item.size : length) + (verify ? item.size : 0));
      bytes = await work.collect(item.offset + (verify ? 0 : offset), verify ? item.size : length);
    } else {
      if (verify) work.work.decoded(item.size);
      const result = await compressed(item, verify ? 0 : offset, verify ? item.size : length, work, signal);
      bytes = result.bytes;
      xpressSteps = result.steps;
    }
    if (verify) {
      const actual = new Uint8Array(await digest!("SHA-1", new Uint8Array(bytes).buffer));
      signal?.throwIfAborted();
      if (hex(actual) !== item.sha1) throw new ArchiveError("checksum-mismatch", "WIM resource SHA1 mismatch.");
    }
    signal?.throwIfAborted();
    return {
      bytes: internal ? bytes : verify ? bytes.slice(offset, offset + length) : bytes,
      integrity: verify ? "resource-sha1-verified" : "pending",
      work: work.work.inspect(),
      xpressSteps,
    };
  }
  function rawSource(id: number, call: Omit<WimReadOptionsType, "verify"> = {}): ByteSourceType {
    call = { ...call };
    const item = resourceOf(id), offset = call.offset ?? 0, length = call.length ?? item.size - offset;
    sourceRange(item.size, offset, length);
    const captured = call, signal = signals(options.signal, call.signal), local = createArchiveLedger(call);
    signal?.throwIfAborted();
    return Object.freeze({
      size: length,
      ...(identity === undefined ? {} : {
        identity: JSON.stringify([identity, "wim-resource-1.13", item.compression, id, item.offset, offset, length]),
      }),
      ...(stability === undefined ? {} : { stability }),
      async read(at: number, count: number, option: { signal?: AbortSignal } = {}) {
        sourceRange(length, at, count);
        const combined = signal && option.signal ? AbortSignal.any([signal, option.signal]) : option.signal ?? signal;
        return (await read(id, {
          ...captured,
          offset: offset + at,
          length: count,
          verify: false,
          ledger: {
            reserve(kind, value) {
              local.reserve(kind, value);
              if (captured.ledger && captured.ledger !== options.ledger) captured.ledger.reserve(kind, value);
            },
            inspect: () => local.inspect(),
          },
          ...(combined ? { signal: combined } : {}),
        })).bytes;
      },
    });
  }
  return Object.freeze({
    format: "wim",
    profile: xpress ? "xpress-huffman-32k-1.13" : "uncompressed-1.13",
    resources: Object.freeze(resources),
    images: Object.freeze(images),
    integrityTable: integrity.size ? "present-unverified" : "absent",
    provenance: Object.freeze({
      ...(identity === undefined ? {} : { identity }),
      stability: stability ?? "unverified",
    }),
    work: opening.work.inspect(),
    read: (id: number, call: WimReadOptionsType = {}) => read(id, call),
    source: rawSource,
    async image(index: number, call: WimImageOptionsType = {}): Promise<WimImageViewType> {
      call = { ...call };
      integer(index, "WIM image index");
      const image = images[index - 1];
      if (!image) throw new RangeError("Unknown WIM image index.");
      const limits = {
        metadata: call.maxMetadataBytes ?? 8388608,
        entries: call.maxEntries ?? 10000,
        depth: call.maxDepth ?? 32,
        streams: call.maxStreams ?? 32,
        security: call.maxSecurity ?? 4096,
        name: call.maxNameBytes ?? 4096,
        path: call.maxPathLength ?? 4096,
        index: call.maxIndexBytes ?? 4194304,
      };
      for (const [name, value] of Object.entries(limits)) integer(value, name);
      if (limits.metadata > 16777216 || limits.depth > 64) {
        throw new RangeError("WIM image implementation ceiling exceeded.");
      }
      const metadata = resourceOf(image.metadata);
      cap(metadata.size, limits.metadata, "WIM image metadata bytes");
      const viewPolicy = call, viewSignal = signals(options.signal, call.signal);
      const viewLedger = createArchiveLedger(call);
      function viewCall(next: WimReadOptionsType): WimReadOptionsType {
        const signal = signals(viewSignal, next.signal);
        return {
          ...next,
          ledger: {
            reserve(kind, count) {
              viewLedger.reserve(kind, count);
              if (viewPolicy.ledger && viewPolicy.ledger !== options.ledger) viewPolicy.ledger.reserve(kind, count);
              if (next.ledger && next.ledger !== viewPolicy.ledger && next.ledger !== options.ledger) {
                next.ledger.reserve(kind, count);
              }
            },
            inspect: () => viewLedger.inspect(),
          },
          ...(signal ? { signal } : {}),
        };
      }
      const result = await read(image.metadata, viewCall({ ...call, verify: call.verify !== false }), true);
      const bytes = result.bytes, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (bytes.length < 8) invalid("WIM security block is truncated.");
      const declared = view.getUint32(0, true),
        securityCount = view.getUint32(4, true),
        end = declared === 0 ? 8 : Math.ceil(declared / 8) * 8;
      cap(securityCount, limits.security, "WIM security descriptors");
      sourceRange(bytes.length, 0, end);
      if (8 + securityCount * 8 > end) invalid("WIM security descriptor table exceeds its block.");
      let used = 8 + securityCount * 8;
      for (let at = 0; at < securityCount; at++) {
        const length = wide(view, 8 + at * 8);
        if (length > end - used) invalid("WIM security descriptor exceeds block.");
        used += length;
      }
      if (end - used > 7) invalid("WIM security block has unexplained bytes.");
      let indexBytes = Math.ceil(bytes.length / 8);
      cap(indexBytes, limits.index, "WIM retained index");
      const occupied = new Uint8Array(indexBytes);
      /** Every dentry, extra stream and list sentinel owns disjoint aligned metadata units. */
      function claim(offset: number, length: number): void {
        if (offset % 8 || length % 8) invalid("WIM metadata record is not 8-byte aligned.");
        sourceRange(bytes.length, offset, length);
        for (let at = offset / 8; at < (offset + length) / 8; at++) {
          if (occupied[at]) invalid("WIM metadata entries overlap or form a cycle.");
          occupied[at] = 1;
        }
      }
      claim(0, end);
      const entries: WimEntryType[] = [], paths = new Set<string>();
      const lists: { offset: number; parent: string; depth: number; root: boolean }[] = [{
        offset: end,
        parent: "",
        depth: 0,
        root: true,
      }];
      function nameOf(offset: number, length: number, ceiling: number): string {
        if (length % 2 || offset + length + (length ? 2 : 0) > ceiling) {
          invalid("WIM UTF16 name extent is invalid.");
        }
        if (length && view.getUint16(offset + length, true) !== 0) invalid("WIM name terminator is missing.");
        return new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true }).decode(
          bytes.subarray(offset, offset + length),
        );
      }
      while (lists.length) {
        const list = lists.pop()!;
        cap(list.depth, limits.depth, "WIM directory depth");
        let at = list.offset;
        while (true) {
          sourceRange(bytes.length, at, 8);
          const length = wide(view, at);
          if (length === 0) {
            if (list.root) invalid("WIM root dentry is missing.");
            claim(at, 8);
            break;
          }
          if (length < 102 || length % 8) invalid("WIM dentry length is invalid.");
          claim(at, length);
          cap(entries.length + 1, limits.entries, "WIM entries");
          const attributes = view.getUint32(at + 8, true),
            security = view.getUint32(at + 12, true),
            subdir = wide(view, at + 16),
            sha1 = hex(bytes.subarray(at + 64, at + 84)),
            hardlink = view.getBigUint64(at + 88, true).toString();
          if (security !== 0xffffffff && security >= securityCount) {
            invalid("WIM security descriptor index is invalid.");
          }
          const streamCount = view.getUint16(at + 96, true),
            shortLength = view.getUint16(at + 98, true),
            nameLength = view.getUint16(at + 100, true);
          cap(streamCount, limits.streams, "WIM extra streams");
          cap(nameLength, limits.name, "WIM name bytes");
          cap(shortLength, limits.name, "WIM short-name bytes");
          const name = nameOf(at + 102, nameLength, at + length);
          nameOf(at + 102 + nameLength + (nameLength ? 2 : 0), shortLength, at + length);
          if (
            list.root ? name !== "" : !name || name === "." || name === ".." || Array.from(name).some((part) => {
              const code = part.codePointAt(0)!;
              return code < 32 || code === 127 || code === 47 || code === 92;
            })
          ) unsupported("Unsafe or noncanonical WIM path component.");
          cap(list.parent.length + (list.parent ? 1 : 0) + name.length, limits.path, "WIM full path length");
          const path = list.parent ? `${list.parent}/${name}` : name;
          cap(path.length, limits.path, "WIM full path length");
          if (paths.has(path)) invalid("Duplicate WIM exact logical path.");
          paths.add(path);
          indexBytes += 256 + path.length * 2 + streamCount * 128;
          cap(indexBytes, limits.index, "WIM retained index");
          const type = attributes & 0x400
            ? "reparse"
            : attributes & 0x4000
            ? "encrypted"
            : attributes & 0x10
            ? "directory"
            : "file";
          if (list.root && type !== "directory") invalid("WIM root is not a directory.");
          if (subdir && type !== "directory") unsupported("WIM non-directory/reparse entry declares child traversal.");
          const resource = sha1 === "0".repeat(40) ? undefined : hashes.get(sha1);
          if (sha1 !== "0".repeat(40) && resource === undefined) invalid("WIM dentry references a missing resource.");
          at += length;
          const streams: WimStreamType[] = [];
          const streamNames = new Set<string>();
          for (let ordinal = 0; ordinal < streamCount; ordinal++) {
            sourceRange(bytes.length, at, 38);
            const length = wide(view, at), namedLength = view.getUint16(at + 36, true);
            if (length < 38 || length % 8) invalid("WIM extra stream length is invalid.");
            claim(at, length);
            cap(namedLength, limits.name, "WIM stream-name bytes");
            indexBytes += namedLength;
            cap(indexBytes, limits.index, "WIM retained index");
            const streamName = nameOf(at + 38, namedLength, at + length),
              streamHash = hex(bytes.subarray(at + 16, at + 36));
            if (streamNames.has(streamName)) invalid("Duplicate WIM extra stream name.");
            streamNames.add(streamName);
            if (streamHash !== "0".repeat(40) && !hashes.has(streamHash)) {
              invalid("WIM extra stream references a missing resource.");
            }
            streams.push(Object.freeze({ name: streamName, sha1: streamHash }));
            at += length;
          }
          entries.push(
            Object.freeze({
              id: entries.length,
              path,
              type,
              attributes,
              security: security === 0xffffffff ? null : security,
              sha1,
              ...(resource === undefined ? {} : { resource }),
              size: resource === undefined ? 0 : resources[resource]!.size,
              hardlink,
              streams: Object.freeze(streams),
            }),
          );
          if (subdir) lists.push({ offset: subdir, parent: path, depth: list.depth + 1, root: false });
          if (list.root) break;
        }
      }
      function selected(id: number): WimEntryType {
        integer(id, "WIM dentry ID");
        const entry = entries[id];
        if (!entry) throw new RangeError("Unknown WIM dentry ID.");
        if (entry.type !== "file" || entry.streams.length) {
          unsupported(
            "Only ordinary WIM files without extra streams support file reads; reparse points are never followed.",
          );
        }
        return entry;
      }
      /** Empty hashes denote absent streams, not a verified SHA1(empty) resource. */
      const empty = (call: WimReadOptionsType): WimReadType => {
        createArchiveLedger(call);
        sourceRange(0, call.offset ?? 0, call.length ?? 0);
        signals(viewSignal, call.signal)?.throwIfAborted();
        return {
          bytes: new Uint8Array(),
          integrity: "not-provided",
          xpressSteps: 0,
          work: { sourceBytes: 0, requests: 0, decodedBytes: 0, outputBytes: 0 },
        };
      };
      return Object.freeze({
        image,
        entries: Object.freeze(entries),
        metadataIntegrity: result.integrity === "resource-sha1-verified" ? "resource-sha1-verified" : "pending",
        xpressSteps: result.xpressSteps,
        work: result.work,
        async read(id: number, call: WimReadOptionsType = {}): Promise<WimReadType> {
          const entry = selected(id);
          return entry.resource === undefined ? empty(viewCall(call)) : await read(entry.resource, viewCall(call));
        },
        source(id: number, call: Omit<WimReadOptionsType, "verify"> = {}): ByteSourceType {
          const entry = selected(id);
          if (entry.resource !== undefined) return rawSource(entry.resource, viewCall(call));
          call = { ...call };
          empty(viewCall(call));
          return Object.freeze({
            size: 0,
            ...(identity === undefined ? {} : { identity: JSON.stringify([identity, "wim-empty-stream", index, id]) }),
            ...(stability === undefined ? {} : { stability }),
            async read(offset: number, length: number, next: { signal?: AbortSignal } = {}) {
              const captured = signals(viewSignal, call.signal);
              const signal = captured && next.signal
                ? AbortSignal.any([captured, next.signal])
                : next.signal ?? captured;
              return empty({ offset, length, ...(signal ? { signal } : {}) }).bytes;
            },
          });
        },
      });
    },
  });
}
