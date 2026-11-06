/** Private BGZF acquisition. Each member is fully decoded and checked before its bytes become visible. @module */
import type { ByteSourceType } from "../../source.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../../archive/record.ts";
import { sourceRange } from "../../source.ts";
import { isBytes, toView } from "../../bytes.ts";
import { ArchiveError, crc32, createArchiveLedger, integer, invalid, unsupported, view } from "../../archive/record.ts";
import { readDeflate } from "../../archive/deflate.ts";

/** Separate format maxima and finite lifetime policy: failed reservations are never refunded. */
export interface BamLimitsType extends ArchiveLimitsType {
  /** Header text bytes. Default 1 MiB. */
  readonly maxHeaderBytes?: number;
  /** Header lines admitted before allocating per-line field arrays. Default 4096. */
  readonly maxHeaderLines?: number;
  /** Reference dictionary entries. Default 4096. */
  readonly maxReferences?: number;
  /** Reference name bytes including NUL. Default 1024. */
  readonly maxNameBytes?: number;
  /** One record body, excluding its four-byte size. Default 1 MiB. */
  readonly maxRecordBytes?: number;
  /** Cumulative record attempts across iterators, not the requested preview size. Default 1024. */
  readonly maxTotalRecords?: number;
  /** BGZF members across opening and all iterators, including empty members. Default 4096. */
  readonly maxBlocks?: number;
  /** Cumulative RFC 1951 block attempts, including empty blocks. Default 65536. */
  readonly maxDeflateBlocks?: number;
  /** CIGAR operations per record. Default 65535. */
  readonly maxCigar?: number;
  /** Ordered auxiliary entries per record. Default 256. */
  readonly maxAuxiliary?: number;
}
/** Cumulative observable work includes opening and all earlier iterations. */
export interface BamWorkType extends ArchiveWorkType {
  /** Complete-member admission attempts, including failures and empty blocks. */
  readonly blocks: number;
  /** RFC 1951 block admission attempts. */
  readonly deflateBlocks: number;
  /** Record admission attempts, including records that later fail parsing. */
  readonly records: number;
}

/** One lifetime owner prevents an iterator restart from resetting the safety policy. */
export class Budget {
  readonly source: ByteSourceType;
  readonly limits: Required<
    Pick<
      BamLimitsType,
      | "maxHeaderBytes"
      | "maxHeaderLines"
      | "maxReferences"
      | "maxNameBytes"
      | "maxRecordBytes"
      | "maxTotalRecords"
      | "maxBlocks"
      | "maxDeflateBlocks"
      | "maxCigar"
      | "maxAuxiliary"
    >
  >;
  readonly #ledger: ArchiveLedgerType;
  readonly #external: ArchiveLedgerType | undefined;
  #blocks = 0;
  #deflateBlocks = 0;
  #records = 0;
  constructor(source: ByteSourceType, options: BamLimitsType) {
    sourceRange(source.size, 0, 0);
    if (source.size > 0xffffffffffff) unsupported("BAM source exceeds the 48-bit compressed virtual-offset profile.");
    this.source = source;
    this.#ledger = createArchiveLedger({ ...options, maxOutputBytes: options.maxOutputBytes ?? 8 * 1024 * 1024 });
    this.#external = options.ledger;
    this.limits = {
      maxHeaderBytes: options.maxHeaderBytes ?? 1024 * 1024,
      maxHeaderLines: options.maxHeaderLines ?? 4096,
      maxReferences: options.maxReferences ?? 4096,
      maxNameBytes: options.maxNameBytes ?? 1024,
      maxRecordBytes: options.maxRecordBytes ?? 1024 * 1024,
      maxTotalRecords: options.maxTotalRecords ?? 1024,
      maxBlocks: options.maxBlocks ?? 4096,
      maxDeflateBlocks: options.maxDeflateBlocks ?? 65536,
      maxCigar: options.maxCigar ?? 65535,
      maxAuxiliary: options.maxAuxiliary ?? 256,
    };
    for (const [name, count] of Object.entries(this.limits)) integer(count, name);
    if (
      this.limits.maxHeaderBytes > 8 * 1024 * 1024 || this.limits.maxRecordBytes > 8 * 1024 * 1024 ||
      this.limits.maxNameBytes > 65536
    ) {
      throw new RangeError(
        "BAM implementation ceilings are 8 MiB per header/record and 65536 bytes per reference name.",
      );
    }
  }
  reserve(kind: keyof ArchiveWorkType, count: number): void {
    this.#ledger.reserve(kind, count);
    this.#external?.reserve(kind, count);
  }
  block(): void {
    if (this.#blocks === this.limits.maxBlocks) this.refuse("BGZF block");
    this.#blocks++;
  }
  deflate(): void {
    if (this.#deflateBlocks === this.limits.maxDeflateBlocks) this.refuse("DEFLATE block");
    this.#deflateBlocks++;
  }
  record(): void {
    if (this.#records === this.limits.maxTotalRecords) this.refuse("Record");
    this.#records++;
  }
  refuse(label: string): never {
    throw new ArchiveError("budget-exceeded", `BAM ${label} lifetime policy exhausted.`);
  }
  inspect(): BamWorkType {
    return {
      ...this.#ledger.inspect(),
      blocks: this.#blocks,
      deflateBlocks: this.#deflateBlocks,
      records: this.#records,
    };
  }
  /** Source bytes are borrowed only until this read returns; retain our own copy before another source call. */
  async read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted();
    if (offset > this.source.size || length > this.source.size - offset) {
      invalid("BAM compressed member is truncated at physical EOF.");
    }
    sourceRange(this.source.size, offset, length);
    this.reserve("sourceBytes", length);
    this.reserve("requests", 1);
    const result = await this.source.read(offset, length, signal ? { signal } : {});
    signal?.throwIfAborted();
    if (!isBytes(result) || result.byteLength !== length) invalid("BAM source returned a different byte extent.");
    return new Uint8Array(toView(result));
  }
}

/** Canonical physical final marker is an explicit first-reader profile, not a general BAM validity rule. */
export async function marker(budget: Budget, signal?: AbortSignal): Promise<void> {
  if (budget.source.size < 28) invalid("BAM source is too short for the required final BGZF marker.");
  const tail = await budget.read(budget.source.size - 28, 28, signal);
  const expected = [31, 139, 8, 4, 0, 0, 0, 0, 0, 255, 6, 0, 66, 67, 2, 0, 27, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  if (!tail.every((byte, i) => byte === expected[i])) {
    unsupported("BAM first profile requires a canonical physical final BGZF marker.");
  }
}

/** A clone borrows an internally owned immutable block, never a foreign source buffer. */
export class Cursor {
  readonly #budget: Budget;
  readonly #signal: AbortSignal | undefined;
  #next = 0;
  #block = 0;
  #bytes: Uint8Array = new Uint8Array();
  #at = 0;
  constructor(budget: Budget, signal?: AbortSignal, previous?: Cursor) {
    this.#budget = budget;
    this.#signal = signal;
    if (previous) {
      this.#next = previous.#next;
      this.#block = previous.#block;
      this.#bytes = previous.#bytes;
      this.#at = previous.#at;
    }
  }
  /** Skip empty interior members; only the known physical source boundary is EOF. */
  async location(): Promise<bigint | null> {
    this.#signal?.throwIfAborted();
    while (this.#at === this.#bytes.length) {
      if (this.#next === this.#budget.source.size) return null;
      await this.#load();
    }
    return (BigInt(this.#block) << 16n) | BigInt(this.#at);
  }
  /** One bounded grammar extent may span many members. All members are verified before copying their bytes. */
  async take(length: number): Promise<Uint8Array> {
    integer(length, "BAM decoded extent");
    const bytes = new Uint8Array(length);
    let at = 0;
    while (at < length) {
      if (await this.location() === null) invalid("BAM decoded extent is truncated at physical EOF.");
      const count = Math.min(length - at, this.#bytes.length - this.#at);
      bytes.set(this.#bytes.subarray(this.#at, this.#at + count), at);
      at += count;
      this.#at += count;
    }
    this.#signal?.throwIfAborted();
    return bytes;
  }
  async #load(): Promise<void> {
    const budget = this.#budget;
    budget.block();
    const start = this.#next, header = await budget.read(start, 12, this.#signal);
    if (header[0] !== 31 || header[1] !== 139 || header[2] !== 8) invalid("BAM BGZF gzip magic/method is invalid.");
    if (header[3] !== 4) unsupported("BAM BGZF profile requires only the gzip FEXTRA flag.");
    const extraSize = view(header).getUint16(10, true);
    if (extraSize < 6 || extraSize > 65510) invalid("BAM BGZF extra-field extent is invalid.");
    const extra = await budget.read(start + 12, extraSize, this.#signal);
    const data = view(extra);
    let at = 0, size = 0, fields = 0;
    while (at < extraSize) {
      if (++fields > 64) unsupported("BAM BGZF extra-field count exceeds 64.");
      if (extraSize - at < 4) invalid("BAM BGZF extra-field header is truncated.");
      const width = data.getUint16(at + 2, true);
      if (width > extraSize - at - 4) invalid("BAM BGZF extra-field value is truncated.");
      if (extra[at] === 66 && extra[at + 1] === 67) {
        if (size || width !== 2) invalid("BAM BGZF BC field is duplicated or malformed.");
        size = data.getUint16(at + 4, true) + 1;
      }
      at += width + 4;
    }
    const headerSize = 12 + extraSize;
    if (!size || size < headerSize + 10 || size > 65536 || size > budget.source.size - start) {
      invalid("BAM BGZF BSIZE is outside its member extent.");
    }
    const rest = await budget.read(start + headerSize, size - headerSize, this.#signal);
    const trailer = view(rest), decodedSize = trailer.getUint32(rest.length - 4, true);
    if (decodedSize > 65536) invalid("BAM BGZF decoded ISIZE exceeds 65536.");
    budget.reserve("decodedBytes", decodedSize);
    const decoded = readDeflate(
      rest.subarray(0, rest.length - 8),
      decodedSize,
      new Uint8Array(),
      this.#signal,
      () => budget.deflate(),
    );
    if (((crc32(decoded) ^ 0xffffffff) >>> 0) !== trailer.getUint32(rest.length - 8, true)) {
      throw new ArchiveError("checksum-mismatch", `BAM BGZF CRC32 mismatch at compressed offset ${start}.`);
    }
    this.#block = start;
    this.#next = start + size;
    this.#bytes = decoded;
    this.#at = 0;
  }
}
