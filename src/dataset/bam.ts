/** Bounded sequential BAM previews over a caller-owned stable byte source. @module */
import type { ByteSourceType } from "../source.ts";
import type { BamLimitsType, BamWorkType } from "./bam/bgzf.ts";
import type { BamRecordType, BamReferenceType } from "./bam/record.ts";
import { integer, invalid, unsupported, view } from "../archive/record.ts";
import { Budget, Cursor, marker } from "./bam/bgzf.ts";
import { record, referenceName } from "./bam/record.ts";
export { ArchiveError } from "../archive/record.ts";
export type { ArchiveErrorCodeType, ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";
export type { ByteSourceType, SourceReadOptionsType } from "../source.ts";
export type { BamLimitsType, BamWorkType } from "./bam/bgzf.ts";
export type { BamAuxiliaryType, BamRecordType, BamReferenceType } from "./bam/record.ts";

/** Opening and subsequent iteration share one finite lifetime policy. */
export interface BamOptionsType extends BamLimitsType {
  /** Cancellation of opening only. Each iterator supplies its own independent signal. */
  readonly signal?: AbortSignal;
}
/** A BAM header is descriptive text plus the authoritative binary reference dictionary. */
export interface BamHeaderType {
  /** Original decoded header text, including its line endings. */
  readonly text: string;
  /** Immutable ordinal reference dictionary. */
  readonly references: readonly BamReferenceType[];
}
/** Preview count is deliberate selection; lifetime safety limits still apply independently. */
export interface BamReadOptionsType {
  /** Stop without probing the next record after this count. Default 20; zero returns a preview page without record reads. */
  readonly maxRecords?: number;
  /** Records per owned result page, from 1 through 256. Default 20. */
  readonly pageRecords?: number;
  /** Borrowed cancellation for this iterator; it never closes the source. */
  readonly signal?: AbortSignal;
}
/** A checked page describes exactly the work visited, never verification of an unread suffix. */
export interface BamPageType {
  /** Records own their strings and arrays. Typed arrays remain caller-mutable. */
  readonly records: readonly BamRecordType[];
  /** More pages, deliberate count stop, or observed physical EOF. A natural EOF may use an empty terminal page. */
  readonly end: "more" | "preview" | "eof";
  /** Each visited BGZF block had its complete DEFLATE extent, CRC32 and ISIZE checked. No authentication is supplied. */
  readonly verification: "checked-blocks";
  /** Cumulative opening and iteration work, including earlier failed attempts. */
  readonly work: BamWorkType;
}
/** Reusable sequential starting point. Iterators restart after the header and share safety limits. */
export interface BamDatasetType {
  /** Frozen text/dictionary metadata. */
  readonly header: BamHeaderType;
  /** Literal evidence about the required physical tail; it does not verify middle blocks. */
  readonly finalMarker: "canonical-physical";
  /** At most one iterator may be active; source and decoder allocations remain bounded. */
  records(options?: BamReadOptionsType): AsyncGenerator<BamPageType>;
  /** Inspect detached lifetime counters without reading source bytes. */
  inspect(): BamWorkType;
}

/**
 * Open a strict BAM 1.x prefix profile with a canonical physical final BGZF marker.
 *
 * The source must identify a stable snapshot. Opening checks the physical marker and bounded header; it does not read
 * every alignment. Records are assembled across independently checked BGZF members using the owned RFC 1951 decoder.
 * A preview count of 20 returns at most 20 records, even when a record spans several blocks. It never probes record 21
 * merely to decide whether the file ended. Inspect page.end to distinguish that stop from observed physical EOF.
 *
 * Source ownership remains with the caller on success, failure, abort and early iterator return. Opening's signal owns
 * only opening; supply a signal separately to each iterator. Source failures keep their exact thrown reason. There are
 * no acquired streams or background reads to retire. A pending next() waits for its current borrowed source read;
 * cancellation requires the supplied signal and cooperation from that source.
 *
 * This profile refuses H/B auxiliary values, CG long CIGAR, non-finite auxiliary floats, optional gzip header flags,
 * regional indexes and noncanonical physical tails. A checked prefix is not whole-file verification or authentication.
 *
 * @example Inspect the first 20 records from a caller-owned immutable Blob.
 * ```ts
 * import { openBam } from "@okikio/opfs/dataset/bam";
 * import { createBlobSource } from "@okikio/opfs/source";
 * async function preview(file: Blob, signal: AbortSignal) {
 *   const bam = await openBam(createBlobSource(file), { signal });
 *   for await (const page of bam.records({ maxRecords: 20, signal })) {
 *     console.log(bam.header.references, page.records, page.end, page.work);
 *   }
 * }
 * ```
 */
export async function openBam(source: ByteSourceType, options: BamOptionsType = {}): Promise<BamDatasetType> {
  options.signal?.throwIfAborted();
  if (source.stability !== "immutable" && source.stability !== "provider" && source.stability !== "caller") {
    throw new TypeError("BAM requires an explicitly stable byte source.");
  }
  const budget = new Budget(source, options);
  await marker(budget, options.signal);
  const cursor = new Cursor(budget, options.signal);
  const magic = await cursor.take(4);
  if (magic[0] !== 66 || magic[1] !== 65 || magic[2] !== 77 || magic[3] !== 1) invalid("BAM magic is invalid.");
  const i32 = async (): Promise<number> => view(await cursor.take(4)).getInt32(0, true);
  const textLength = await i32();
  if (textLength < 0) invalid("BAM header text length is negative.");
  if (textLength > budget.limits.maxHeaderBytes) budget.refuse("header text");
  budget.reserve("outputBytes", textLength * 2);
  const textBytes = await cursor.take(textLength);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(textBytes);
  } catch {
    invalid("BAM header text is not valid UTF-8.");
  }
  if (text.includes("\0") || text.startsWith("\ufeff")) invalid("BAM header text contains NUL or a byte-order mark.");
  if (text && !text.endsWith("\n")) unsupported("BAM first profile requires newline-terminated header text.");
  const referenceCount = await i32();
  if (referenceCount < 0) invalid("BAM reference count is negative.");
  if (referenceCount > budget.limits.maxReferences) budget.refuse("reference count");
  budget.reserve("outputBytes", referenceCount * 64);
  const references: BamReferenceType[] = [], names = new Set<string>();
  for (let id = 0; id < referenceCount; id++) {
    const nameLength = await i32();
    if (nameLength < 2) invalid("BAM reference name length is invalid.");
    if (nameLength > budget.limits.maxNameBytes) budget.refuse("reference name");
    budget.reserve("outputBytes", nameLength * 2);
    const bytes = await cursor.take(nameLength);
    if (bytes[nameLength - 1] !== 0) invalid("BAM reference name lacks NUL.");
    const name = referenceName(bytes.subarray(0, nameLength - 1)), length = await i32();
    if (length < 1 || names.has(name)) invalid("BAM reference length/name is invalid or duplicated.");
    names.add(name);
    references.push(Object.freeze({ id, name, length }));
  }
  // When textual @SQ records exist, their order and lengths must agree with the binary dictionary.
  let textReferences = 0, lineCount = 0, textAt = 0;
  while (textAt < text.length) {
    if (++lineCount > budget.limits.maxHeaderLines) budget.refuse("header line count");
    const end = text.indexOf("\n", textAt);
    const line = text.slice(textAt, end);
    textAt = end + 1;
    if (!line) invalid("BAM header contains an empty line.");
    if (!/^@(HD|SQ|RG|PG|CO)(\t|\r?$)/.test(line)) invalid("BAM header line has invalid syntax.");
    if (!line.startsWith("@SQ\t")) continue;
    const fields = line.replace(/\r$/, "").split("\t", 66).slice(1);
    if (fields.length > 64) unsupported("BAM textual reference field count exceeds 64.");
    const sn = fields.filter((field) => field.startsWith("SN:")),
      ln = fields.filter((field) => field.startsWith("LN:"));
    const expected = references[textReferences++];
    if (
      sn.length !== 1 || ln.length !== 1 || !expected || sn[0]!.slice(3) !== expected.name ||
      !/^[1-9][0-9]*$/.test(ln[0]!.slice(3)) || Number(ln[0]!.slice(3)) !== expected.length
    ) {
      invalid("BAM textual and binary reference dictionaries disagree.");
    }
  }
  if (textReferences && textReferences !== references.length) {
    invalid("BAM textual reference dictionary is incomplete.");
  }
  const header = Object.freeze({ text, references: Object.freeze(references) });
  let busy = false;
  return Object.freeze({
    header,
    finalMarker: "canonical-physical" as const,
    inspect: () => budget.inspect(),
    async *records(readOptions: BamReadOptionsType = {}): AsyncGenerator<BamPageType> {
      const maxRecords = readOptions.maxRecords ?? 20, pageRecords = readOptions.pageRecords ?? 20;
      integer(maxRecords, "BAM preview record count");
      integer(pageRecords, "BAM page record count");
      if (pageRecords < 1 || pageRecords > 256) throw new RangeError("BAM pageRecords must be 1..256.");
      readOptions.signal?.throwIfAborted();
      if (busy) throw new TypeError("BAM permits only one active record iterator.");
      busy = true;
      try {
        const input = new Cursor(budget, readOptions.signal, cursor);
        let ordinal = 0, page: BamRecordType[] = [];
        const result = (end: BamPageType["end"]): BamPageType => ({
          records: page,
          end,
          verification: "checked-blocks",
          work: budget.inspect(),
        });
        while (ordinal < maxRecords) {
          const location = await input.location();
          if (location === null) {
            yield result("eof");
            return;
          }
          budget.record();
          const length = view(await input.take(4)).getInt32(0, true);
          if (length < 32) invalid(`BAM record at ${location} has an invalid body length.`);
          if (length > budget.limits.maxRecordBytes) budget.refuse(`record at ${location}`);
          // Conservative storage charge covers decoded strings, arrays and bounded operation/auxiliary objects.
          budget.reserve("outputBytes", length * 16 + 256);
          const bytes = await input.take(length);
          page.push(record(bytes, references, ordinal++, location, budget.limits.maxCigar, budget.limits.maxAuxiliary));
          if (ordinal === maxRecords) {
            yield result("preview");
            return;
          }
          if (page.length === pageRecords) {
            yield result("more");
            page = [];
          }
        }
        yield result("preview");
      } finally {
        busy = false;
      }
    },
  });
}
