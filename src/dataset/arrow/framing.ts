/** Pure modern Arrow IPC framing and file-index arithmetic, with no source acquisition. @module */
import { ArchiveError } from "../../archive/record.ts";
import type { ArrowBlockType } from "./schema.ts";

/** Per-region admission; the outer source owner separately accounts for cumulative reads. */
export interface ArrowFramingLimitsType {
  /** Padded FlatBuffer region only, excluding its eight-byte continuation prefix. @default 8388608 */
  readonly maxMetadataBytes?: number;
  /** Includes body padding. No body allocation or decoding occurs here. @default 67108864 */
  readonly maxBodyBytes?: number;
}
/** EOS consumes exactly eight bytes; a positive length describes only the following metadata region. */
export type ArrowPrefixType = { readonly kind: "eos" } | { readonly kind: "message"; readonly metadataLength: number };
/** Safe source-relative extent of the footer, excluding the final ten-byte trailer. */
export interface ArrowTailType {
  readonly footerOffset: number;
  readonly footerLength: number;
}
/** Source geometry established by the outer owner before admitting the batch index. */
export interface ArrowFileBoundsType {
  readonly sourceSize: number;
  readonly footerOffset: number;
  /** First byte after the embedded schema message, including its prefix and metadata padding. */
  readonly schemaEnd: number;
}
/**
 * Exact source ranges for one admitted block. Unlike Footer.Block.metadataLength,
 * metadataLength here excludes the continuation prefix, so it can be read directly.
 * Matching these descriptors to actual prefix and Message.bodyLength values remains
 * the outer reader's responsibility.
 */
export interface ArrowFrameType {
  readonly offset: number;
  readonly metadataOffset: number;
  readonly metadataLength: number;
  readonly bodyOffset: number;
  readonly bodyLength: number;
  readonly end: number;
}
function invalid(message: string): never {
  throw new ArchiveError("invalid-archive", `Arrow IPC ${message}`);
}
function integer(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a nonnegative safe integer.`);
}
function limits(options: ArrowFramingLimitsType): { metadata: number; body: number } {
  const metadata = options.maxMetadataBytes ?? 8 * 1024 * 1024;
  const body = options.maxBodyBytes ?? 64 * 1024 * 1024;
  integer(metadata, "Arrow metadata limit");
  integer(body, "Arrow body limit");
  return { metadata, body };
}
function admit(value: bigint, maximum: number, label: string): void {
  if (value > BigInt(maximum)) throw new ArchiveError("budget-exceeded", `Arrow IPC ${label} exceeds its allowance.`);
}
/** Compare only the six magic bytes: alignment padding has no prescribed byte value. */
function magic(bytes: Uint8Array, at: number): void {
  if (
    bytes[at] !== 65 || bytes[at + 1] !== 82 || bytes[at + 2] !== 82 ||
    bytes[at + 3] !== 79 || bytes[at + 4] !== 87 || bytes[at + 5] !== 49
  ) invalid("file magic is absent.");
}

/**
 * Inspect exactly one borrowed eight-byte modern prefix. Zero metadata length is
 * explicit EOS; a negative length, incomplete prefix or legacy framing is refused.
 * This function neither requires nor establishes that the declared metadata exists.
 */
export function inspectPrefix(bytes: Uint8Array, options: ArrowFramingLimitsType = {}): ArrowPrefixType {
  const maximum = limits(options);
  if (bytes.byteLength !== 8) invalid("continuation prefix must contain exactly eight bytes.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0xffffffff) {
    throw new ArchiveError("unsupported-profile", "Arrow IPC legacy or missing continuation framing is not admitted.");
  }
  const length = view.getInt32(4, true);
  if (length === 0) return { kind: "eos" };
  if (length < 0 || length % 8 !== 0) invalid("metadata length is negative or not eight-byte aligned.");
  admit(BigInt(length), maximum.metadata, "metadata bytes");
  return { kind: "message", metadataLength: length };
}

/** Inspect the initial six-byte magic plus two alignment bytes, without decoding any message. */
export function inspectFileMagic(bytes: Uint8Array): void {
  if (bytes.byteLength !== 8) invalid("file header must contain exactly eight bytes.");
  magic(bytes, 0);
}

/**
 * Inspect exactly the final ten bytes of a known-size source. The signed footer
 * length excludes this trailer. Admission occurs before the caller acquires the
 * footer; parsing its FlatBuffer and checking the initial magic are separate steps.
 */
export function inspectFileTail(
  bytes: Uint8Array,
  sourceSize: number,
  options: ArrowFramingLimitsType = {},
): ArrowTailType {
  integer(sourceSize, "Arrow source size");
  const maximum = limits(options);
  if (bytes.byteLength !== 10 || sourceSize < 18) invalid("file trailer is truncated.");
  magic(bytes, 4);
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(0, true);
  if (length <= 0 || length > sourceSize - 18) invalid("footer length is invalid or overlaps the file header.");
  const footerOffset = sourceSize - 10 - length;
  if (footerOffset % 8 !== 0) invalid("footer start is not eight-byte aligned.");
  admit(BigInt(length), maximum.metadata, "footer bytes");
  return { footerOffset, footerLength: length };
}

/**
 * Admit the entire ordered batch index before returning safe-number source ranges.
 * All descriptor arithmetic stays bigint until bounded by the source, the footer,
 * the embedded schema and per-region policy. No message metadata or body is read.
 * Gaps can contain EOS or padding; this function does not authenticate their bytes.
 */
export function inspectBlocks(
  blocks: readonly ArrowBlockType[],
  bounds: ArrowFileBoundsType,
  options: ArrowFramingLimitsType = {},
): ArrowFrameType[] {
  integer(bounds.sourceSize, "Arrow source size");
  integer(bounds.footerOffset, "Arrow footer offset");
  integer(bounds.schemaEnd, "Arrow embedded schema end");
  const maximum = limits(options);
  if (
    bounds.sourceSize < 18 || bounds.footerOffset < 8 || bounds.footerOffset > bounds.sourceSize - 10 ||
    bounds.footerOffset % 8 !== 0 || bounds.schemaEnd < 8 || bounds.schemaEnd % 8 !== 0 ||
    bounds.schemaEnd > bounds.footerOffset
  ) {
    invalid("file bounds do not contain an aligned schema and footer.");
  }
  const footer = BigInt(bounds.footerOffset);
  let previousEnd = BigInt(bounds.schemaEnd);
  // Validate the whole index first, so no partial index escapes after a later refusal.
  for (const block of blocks) {
    if (
      !Number.isSafeInteger(block.metadataLength) || block.metadataLength < 16 ||
      block.metadataLength > 0x7fffffff || block.metadataLength % 8 !== 0 ||
      block.offset < previousEnd || block.offset % 8n !== 0n || block.bodyLength < 0n || block.bodyLength % 8n !== 0n
    ) {
      invalid("block is overlapping, unordered, negative or unaligned.");
    }
    const metadata = BigInt(block.metadataLength), end = block.offset + metadata + block.bodyLength;
    if (end > footer) invalid("block extends into the footer or beyond the source.");
    admit(metadata - 8n, maximum.metadata, "metadata bytes");
    admit(block.bodyLength, maximum.body, "body bytes");
    previousEnd = end;
  }
  return blocks.map((block) => {
    const offset = Number(block.offset), metadataLength = block.metadataLength - 8;
    const bodyOffset = offset + block.metadataLength, bodyLength = Number(block.bodyLength);
    return { offset, metadataOffset: offset + 8, metadataLength, bodyOffset, bodyLength, end: bodyOffset + bodyLength };
  });
}
