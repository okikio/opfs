/** Private BAM record grammar. Byte extents are admitted before variable-field allocation. @module */
import { ArchiveError, invalid, unsupported, view } from "../../archive/record.ts";

/** One reference in BAM's ordinal dictionary; coordinates in records are zero-based. */
export interface BamReferenceType {
  /** Ordinal used by referenceId and mateReferenceId. */
  readonly id: number;
  /** Literal reference name, never a filesystem path. */
  readonly name: string;
  /** Declared reference sequence length. */
  readonly length: number;
}
/** Ordered auxiliary values preserve integer width and signedness from the BAM wire. */
export type BamAuxiliaryType = {
  /** Two-character tag; order and repeated tags are retained. */
  readonly tag: string;
  /** Wire encoding, rather than SAM's normalized integer display type. */
  readonly type: "A" | "c" | "C" | "s" | "S" | "i" | "I" | "f" | "Z";
  /** Numeric values remain exact for the admitted integer encodings. */
  readonly value: string | number;
};
/** A decoded alignment owns its arrays; it does not establish biological correctness. */
export interface BamRecordType {
  /** Zero-based ordinal among records visited by this iterator. */
  readonly ordinal: number;
  /** Compound BGZF block/in-block location; not an ordinary byte distance. */
  readonly virtualOffset: bigint;
  /** Literal query name, including '*' when absent. */
  readonly name: string;
  /** Original BAM flag bits. */
  readonly flags: number;
  /** Reference ordinal, or -1 when absent. */
  readonly referenceId: number;
  /** Zero-based coordinate, or -1 when absent. */
  readonly position: number;
  /** Original mapping quality, including sentinel 255. */
  readonly mappingQuality: number;
  /** Original bin; no regional-index completeness is inferred. */
  readonly bin: number;
  /** Mate reference ordinal, or -1 when absent. */
  readonly mateReferenceId: number;
  /** Zero-based mate coordinate, or -1 when absent. */
  readonly matePosition: number;
  /** Signed template length. */
  readonly templateLength: number;
  /** Original ordered operations, without converting the long-CIGAR convention. */
  readonly cigar: readonly { readonly operation: string; readonly length: number }[];
  /** Decoded packed bases, or null when the BAM sequence length is zero. */
  readonly sequence: string | null;
  /** Owned numeric Phred values, or null when absent. */
  readonly qualities: Uint8Array | null;
  /** Ordered scalar auxiliary data. H/B arrays and CG are refused. */
  readonly auxiliary: readonly BamAuxiliaryType[];
}

/** ASCII fields forbid NUL except for their explicit final terminator. */
export function ascii(bytes: Uint8Array, label: string): string {
  for (const byte of bytes) {
    if (byte < 32 || byte > 126) invalid(`BAM ${label} contains a non-printable ASCII byte.`);
  }
  return new TextDecoder().decode(bytes);
}
/** Enforce the reference-name grammar without interpreting names as paths. */
export function referenceName(bytes: Uint8Array): string {
  const name = ascii(bytes, "reference name");
  if (!/^[0-9A-Za-z!#$%&+./:;?@^_|~-][0-9A-Za-z!#$%&*+./:;=?@^_|~-]*$/.test(name)) {
    invalid("BAM reference name has invalid syntax.");
  }
  return name;
}

/** Decode one complete admitted record body. Node counts and text storage have already been reserved by the caller. */
export function record(
  bytes: Uint8Array,
  references: readonly BamReferenceType[],
  ordinal: number,
  virtualOffset: bigint,
  maxCigar: number,
  maxAuxiliary: number,
): BamRecordType {
  if (bytes.length < 32) invalid("BAM record is shorter than its fixed core.");
  const data = view(bytes), referenceId = data.getInt32(0, true), position = data.getInt32(4, true);
  const nameLength = bytes[8]!, mappingQuality = bytes[9]!, bin = data.getUint16(10, true);
  const cigarCount = data.getUint16(12, true),
    flags = data.getUint16(14, true),
    sequenceLength = data.getInt32(16, true);
  const mateReferenceId = data.getInt32(20, true), matePosition = data.getInt32(24, true);
  const templateLength = data.getInt32(28, true);
  const location = (id: number, at: number): void => {
    if (id < -1 || id >= references.length || at < -1 || (id === -1 && at !== -1)) {
      invalid("BAM reference/coordinate is outside its dictionary.");
    }
    if (id >= 0 && at >= references[id]!.length) invalid("BAM coordinate exceeds the reference length.");
  };
  location(referenceId, position);
  location(mateReferenceId, matePosition);
  if (!(flags & 4) && (referenceId < 0 || position < 0)) invalid("BAM mapped record lacks a reference coordinate.");
  if (sequenceLength < 0 || nameLength === 0) invalid("BAM sequence/name length is invalid.");
  if (cigarCount > maxCigar) throw new ArchiveError("budget-exceeded", "BAM CIGAR operation policy exhausted.");
  const sequenceBytes = Math.ceil(sequenceLength / 2);
  const fixedEnd = 32 + nameLength + cigarCount * 4 + sequenceBytes + sequenceLength;
  if (fixedEnd > bytes.length) invalid("BAM variable fields exceed their record extent.");
  if (bytes[32 + nameLength - 1] !== 0) invalid("BAM query name lacks its NUL terminator.");
  const name = ascii(bytes.subarray(32, 31 + nameLength), "query name");
  if (!name || name.includes("@") || name.includes(" ")) invalid("BAM query name has invalid syntax.");
  let at = 32 + nameLength, queryLength = 0;
  const cigar: { operation: string; length: number }[] = [];
  for (let i = 0; i < cigarCount; i++, at += 4) {
    const word = data.getUint32(at, true), code = word & 15, length = word >>> 4;
    if (code > 8) unsupported("BAM CIGAR operation is outside MIDNSHP=X.");
    if (length === 0) invalid("BAM CIGAR operation length is zero.");
    const operation = "MIDNSHP=X"[code]!;
    if ("MIS=X".includes(operation)) queryLength += length;
    cigar.push({ operation, length });
  }
  if (sequenceLength > 0 && cigarCount > 0 && queryLength !== sequenceLength) {
    invalid("BAM CIGAR query length differs from sequence length.");
  }
  // Contiguous ASCII avoids one string/rope allocation per base in long crossing records.
  const bases = "=ACMGRSVTWYHKDBN", decodedBases = new Uint8Array(sequenceLength);
  for (let i = 0; i < sequenceLength; i++) {
    decodedBases[i] = bases.charCodeAt((bytes[at + (i >>> 1)]! >>> (i & 1 ? 0 : 4)) & 15);
  }
  const sequence = new TextDecoder().decode(decodedBases);
  at += sequenceBytes;
  let qualities: Uint8Array | null = null;
  if (sequenceLength > 0) {
    const missing = bytes[at] === 255;
    for (let i = 0; i < sequenceLength; i++) {
      if (missing ? bytes[at + i] !== 255 : bytes[at + i]! > 93) {
        invalid("BAM quality values are mixed missing or outside Phred 0..93.");
      }
    }
    if (!missing) qualities = bytes.slice(at, at + sequenceLength);
  }
  at += sequenceLength;
  const auxiliary: BamAuxiliaryType[] = [];
  while (at < bytes.length) {
    if (auxiliary.length === maxAuxiliary) {
      throw new ArchiveError("budget-exceeded", "BAM auxiliary entry policy exhausted.");
    }
    if (bytes.length - at < 3) invalid("BAM auxiliary field is truncated.");
    const tag = ascii(bytes.subarray(at, at + 2), "auxiliary tag"), type = String.fromCharCode(bytes[at + 2]!);
    if (!/^[A-Za-z][A-Za-z0-9]$/.test(tag)) invalid("BAM auxiliary tag has invalid syntax.");
    if (tag === "CG") unsupported("BAM long-CIGAR CG convention is not supported.");
    at += 3;
    let value: string | number;
    if (type === "Z") {
      const end = bytes.indexOf(0, at);
      if (end < 0) invalid("BAM auxiliary text lacks a terminator.");
      value = ascii(bytes.subarray(at, end), "auxiliary text");
      at = end + 1;
    } else if (type === "A") {
      if (at === bytes.length) invalid("BAM auxiliary character is truncated.");
      value = ascii(bytes.subarray(at, at + 1), "auxiliary character");
      if (value === " ") invalid("BAM auxiliary character cannot be a space.");
      at++;
    } else {
      const width = type === "c" || type === "C"
        ? 1
        : type === "s" || type === "S"
        ? 2
        : type === "i" || type === "I" || type === "f"
        ? 4
        : 0;
      if (!width) unsupported("BAM auxiliary encoding is outside the scalar profile.");
      if (width > bytes.length - at) invalid("BAM auxiliary number is truncated.");
      value = type === "c"
        ? data.getInt8(at)
        : type === "C"
        ? data.getUint8(at)
        : type === "s"
        ? data.getInt16(at, true)
        : type === "S"
        ? data.getUint16(at, true)
        : type === "i"
        ? data.getInt32(at, true)
        : type === "I"
        ? data.getUint32(at, true)
        : data.getFloat32(at, true);
      if (!Number.isFinite(value)) unsupported("BAM non-finite auxiliary floats are not in the admitted profile.");
      at += width;
    }
    auxiliary.push({ tag, type: type as BamAuxiliaryType["type"], value });
  }
  return {
    ordinal,
    virtualOffset,
    name,
    flags,
    referenceId,
    position,
    mappingQuality,
    bin,
    mateReferenceId,
    matePosition,
    templateLength,
    cigar,
    sequence: sequenceLength ? sequence : null,
    qualities,
    auxiliary,
  };
}
