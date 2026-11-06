/** Checked synchronous access to one borrowed FlatBuffer metadata region. @module */
import { ArchiveError } from "../../archive/record.ts";

/** Safety policy, independent of Arrow's format limits and source-read accounting. */
export interface FlatBufferLimitsType {
  /** Maximum borrowed metadata region. Defaults to 8 MiB before any access. */
  readonly maxInputBytes?: number;
  /** Cumulative bytes inspected, including repeated scalar and extent reads. */
  readonly maxBytes?: number;
  /** Cumulative checked scalar/extent operations. Defaults to 1,048,576. */
  readonly maxSteps?: number;
  /** Root, vtable and forward references all consume this allowance. */
  readonly maxReferences?: number;
  /** UTF-8 bytes in one string, excluding its NUL terminator. Defaults to 1 MiB. */
  readonly maxStringBytes?: number;
}

/** A validated vector extent; its bytes remain borrowed from the metadata input. */
export interface FlatBufferVectorType {
  readonly offset: number;
  readonly length: number;
  readonly stride: number;
}

function integer(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a nonnegative safe integer.`);
}

function invalid(message: string): never {
  throw new ArchiveError("invalid-archive", `FlatBuffers ${message}`);
}

/**
 * Reads little-endian metadata without I/O or implicit copies. The caller must
 * keep the input unchanged until all synchronous reads finish. Do not retain
 * this reader across an asynchronous source acquisition without first owning
 * the input bytes. No method traverses a graph recursively.
 *
 * Positions are relative to this input, not its underlying ArrayBuffer. Slots
 * use physical schema indices, including union discriminator slots. Missing
 * slots return null so the Arrow grammar can apply its own schema default.
 */
export class FlatBuffers {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  readonly #maximum: Required<FlatBufferLimitsType>;
  #bytesRead = 0;
  #steps = 0;
  #references = 0;

  constructor(bytes: Uint8Array, limits: FlatBufferLimitsType = {}) {
    const maximum = {
      maxInputBytes: limits.maxInputBytes ?? 8 * 1024 * 1024,
      maxBytes: limits.maxBytes ?? 64 * 1024 * 1024,
      maxSteps: limits.maxSteps ?? 1048576,
      maxReferences: limits.maxReferences ?? 65536,
      maxStringBytes: limits.maxStringBytes ?? 1024 * 1024,
    };
    for (const [label, value] of Object.entries(maximum)) integer(value, label);
    if (bytes.byteLength > maximum.maxInputBytes) this.#limit("input bytes");
    this.#maximum = maximum;
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  #limit(label: string): never {
    throw new ArchiveError("budget-exceeded", `FlatBuffers ${label} limit exceeded.`);
  }

  /** Admission precedes every read/view; repeated work cannot evade the ledger. */
  #extent(offset: number, length: number): void {
    integer(offset, "FlatBuffers offset");
    integer(length, "FlatBuffers length");
    if (offset > this.#bytes.byteLength || length > this.#bytes.byteLength - offset) {
      invalid("extent is out of bounds.");
    }
    if (this.#steps >= this.#maximum.maxSteps) this.#limit("steps");
    if (length > this.#maximum.maxBytes - this.#bytesRead) this.#limit("interpreted bytes");
    this.#steps++;
    this.#bytesRead += length;
  }

  #reference(): void {
    if (this.#references >= this.#maximum.maxReferences) this.#limit("references");
    this.#references++;
  }

  /** Counts interpreted work, not source requests or an exact JavaScript heap size. */
  inspect(): { readonly bytes: number; readonly steps: number; readonly references: number } {
    return { bytes: this.#bytesRead, steps: this.#steps, references: this.#references };
  }

  u8(offset: number): number {
    this.#extent(offset, 1);
    return this.#view.getUint8(offset);
  }
  i8(offset: number): number {
    this.#extent(offset, 1);
    return this.#view.getInt8(offset);
  }
  u16(offset: number): number {
    this.#extent(offset, 2);
    return this.#view.getUint16(offset, true);
  }
  i16(offset: number): number {
    this.#extent(offset, 2);
    return this.#view.getInt16(offset, true);
  }
  u32(offset: number): number {
    this.#extent(offset, 4);
    return this.#view.getUint32(offset, true);
  }
  i32(offset: number): number {
    this.#extent(offset, 4);
    return this.#view.getInt32(offset, true);
  }
  u64(offset: number): bigint {
    this.#extent(offset, 8);
    return this.#view.getBigUint64(offset, true);
  }
  i64(offset: number): bigint {
    this.#extent(offset, 8);
    return this.#view.getBigInt64(offset, true);
  }

  /** A present uoffset is never null and must point beyond its own four bytes. */
  reference(offset: number): number {
    if (offset % 4 !== 0) invalid("reference slot is not four-byte aligned.");
    const displacement = this.u32(offset);
    this.#reference();
    if (displacement < 4 || displacement > this.#bytes.byteLength - offset) invalid("forward reference is invalid.");
    const target = offset + displacement;
    this.#extent(target, 1);
    return target;
  }

  /** Resolve and validate a root table, without interpreting its Arrow fields. */
  root(): number {
    const table = this.reference(0);
    this.#table(table);
    return table;
  }

  /** Signed displacement permits deduplicated vtables after their table. */
  #table(table: number): { vtable: number; slots: number; objectBytes: number } {
    if (table % 4 !== 0) invalid("table is not four-byte aligned.");
    const displacement = this.i32(table);
    this.#reference();
    if (displacement === 0) invalid("vtable displacement is zero.");
    const vtable = table - displacement;
    if (!Number.isSafeInteger(vtable) || vtable < 0) invalid("vtable reference is invalid.");
    if (vtable % 2 !== 0) invalid("vtable is not two-byte aligned.");
    const bytes = this.u16(vtable), objectBytes = this.u16(vtable + 2);
    if (bytes < 4 || bytes % 2 !== 0 || objectBytes < 4) invalid("vtable or object size is invalid.");
    this.#extent(vtable, bytes);
    this.#extent(table, objectBytes);
    if (vtable < table + objectBytes && table < vtable + bytes) invalid("vtable overlaps its table.");
    return { vtable, slots: (bytes - 4) / 2, objectBytes };
  }

  /** Validate a present field's complete inline width before reading its value. */
  field(table: number, slot: number, width: number): number | null {
    integer(slot, "FlatBuffers slot");
    integer(width, "FlatBuffers field width");
    if (width === 0) throw new TypeError("FlatBuffers field width must be positive.");
    const descriptor = this.#table(table);
    if (slot >= descriptor.slots) return null;
    const relative = this.u16(descriptor.vtable + 4 + slot * 2);
    if (relative === 0) return null;
    if (relative < 4 || relative > descriptor.objectBytes || width > descriptor.objectBytes - relative) {
      invalid("present field exceeds its table object.");
    }
    this.#extent(table + relative, width);
    return table + relative;
  }

  /** Counts and products are checked before exposing any vector elements. */
  vector(offset: number, stride: number): FlatBufferVectorType {
    integer(stride, "FlatBuffers vector stride");
    if (stride === 0) throw new TypeError("FlatBuffers vector stride must be positive.");
    if (offset % 4 !== 0) invalid("vector count is not four-byte aligned.");
    const length = this.u32(offset);
    if (length > Math.floor((this.#bytes.byteLength - offset - 4) / stride)) invalid("vector extent is out of bounds.");
    this.#extent(offset + 4, length * stride);
    return { offset: offset + 4, length, stride };
  }

  /** Strict UTF-8 preserves a literal BOM; the mandatory trailing NUL is not text. */
  string(offset: number): string {
    if (offset % 4 !== 0) invalid("string count is not four-byte aligned.");
    const length = this.u32(offset);
    if (length > this.#maximum.maxStringBytes) this.#limit("string bytes");
    this.#extent(offset + 4, length + 1);
    if (this.#bytes[offset + 4 + length] !== 0) invalid("string terminator is absent.");
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        this.#bytes.subarray(offset + 4, offset + 4 + length),
      );
    } catch {
      invalid("string contains invalid UTF-8.");
    }
  }
}
