/** Bounded physical numeric Parquet previews over a borrowed stable byte source. @module */
import type {
  ParquetColumnType,
  ParquetDatasetType,
  ParquetOpenOptionsType,
  ParquetPageEvidenceType,
  ParquetReadOptionsType,
  ParquetReadType,
  ParquetRowGroupType,
  PolicyType,
} from "./types.ts";
import { levels, values, width } from "./values.ts";
import {
  type ChunkType,
  group,
  type GroupType,
  page,
  type PageType,
  required,
  schema,
  type SchemaType,
} from "./metadata.ts";
import { Compact, limit, Meter, NeedMore } from "./compact.ts";
import { ArchiveBudget, assertInteger, createArchiveLedger, toSafeInteger } from "../../archive/budget.ts";
import type { ByteSourceType } from "../../source.ts";
import { ArchiveError, invalid, unsupported } from "../../archive/error.ts";
import { createView } from "../../archive/field.ts";
import type { ArchiveLedgerType } from "../../archive/budget.ts";
import { crc32 } from "../../hash.ts";
export { ArchiveError } from "../../archive/error.ts";
export { createArchiveLedger } from "../../archive/budget.ts";
export type { ArchiveErrorCodeType } from "../../archive/error.ts";
export type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../../archive/budget.ts";

/** Open bounded metadata, then preview selected physical numeric values.
 *
 * File metadata is unverified input even when selected page bodies have CRCs.
 * The caller keeps source ownership and must provide stable replay evidence.
 */
export async function openParquet(
  input: ByteSourceType,
  supplied: ParquetOpenOptionsType = {},
): Promise<ParquetDatasetType> {
  const options = { ...supplied };
  if (options.allowUnverifiedSource !== undefined && typeof options.allowUnverifiedSource !== "boolean") {
    throw new TypeError("Parquet unverified-source policy must be boolean.");
  }
  const { size, identity, stability } = input;
  assertInteger(size, "Parquet source size");
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("Parquet identity must be a bounded string.");
  }
  if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown Parquet source stability.");
  }
  if (stability === undefined && !options.allowUnverifiedSource) {
    throw unsupported("Parquet requires stable replay evidence.");
  }
  const readSource = input.read.bind(input);
  const source: ByteSourceType = Object.freeze({
    size,
    ...(identity === undefined ? {} : { identity }),
    ...(stability === undefined ? {} : { stability }),
    read: readSource,
  });
  const policy: PolicyType = {
    footer: options.maxFooterBytes ?? 8 * 1024 * 1024,
    header: options.maxPageHeaderBytes ?? 65536,
    page: options.maxPageBytes ?? 8 * 1024 * 1024,
    columns: options.maxColumns ?? 1024,
    groups: options.maxRowGroups ?? 4096,
    compact: options.maxCompactValues ?? 1048576,
    depth: options.maxDepth ?? 32,
    string: options.maxStringBytes ?? 65536,
    retained: options.maxRetainedMetadataBytes ?? 8 * 1024 * 1024,
    pages: options.maxPages ?? 65536,
    rows: options.maxRows ?? 1048576,
  };
  for (const [name, count] of Object.entries(policy)) assertInteger(count, `Parquet maximum ${name}`);
  const captured = new WeakMap<ArchiveLedgerType, ArchiveLedgerType>();
  const capture = (owner: ArchiveLedgerType | undefined): ArchiveLedgerType | undefined => {
    if (!owner) return undefined;
    let saved = captured.get(owner);
    if (!saved) {
      saved = { reserve: owner.reserve.bind(owner), inspect: owner.inspect.bind(owner) };
      captured.set(owner, saved);
    }
    return saved;
  };
  const lifetime = createArchiveLedger(options), opening = capture(options.ledger);
  const together = (owners: readonly (ArchiveLedgerType | undefined)[], signal?: AbortSignal): ArchiveLedgerType => {
    const unique = [...new Set(owners.filter((owner): owner is ArchiveLedgerType => owner !== undefined))];
    return {
      reserve(kind, count) {
        for (const owner of unique) {
          owner.reserve(kind, count);
          signal?.throwIfAborted();
        }
      },
      inspect: () => lifetime.inspect(),
    };
  };
  const budget = new ArchiveBudget(
    source,
    { ...options, ledger: together([lifetime, opening], options.signal) },
    options.signal,
  );
  const meter = new Meter(policy, options.signal);
  const metadata = async (offset: number, length: number): Promise<Uint8Array> => {
    budget.decoded(length);
    options.signal?.throwIfAborted();
    return (await budget.read(offset, length)).slice();
  };
  if (size < 12) throw invalid("Parquet file is too short.");
  const tail = await metadata(size - 8, 8);
  const magic = createView(tail).getUint32(4, true);
  if (magic === 0x45524150) throw unsupported("Parquet encrypted footers are unsupported.");
  if (magic !== 0x31524150) throw invalid("Parquet footer magic mismatch.");
  const footerLength = createView(tail).getUint32(0, true);
  if (footerLength > policy.footer) limit("Footer byte");
  if (footerLength > size - 12) throw invalid("Parquet footer overlaps its leading magic.");
  const footerOffset = size - 8 - footerLength;
  if (createView(await metadata(0, 4)).getUint32(0, true) !== 0x31524150) {
    throw invalid("Parquet leading magic mismatch.");
  }
  const footer = new Compact(await metadata(footerOffset, footerLength), meter);
  let version: number | undefined,
    schemaList: SchemaType[] | undefined,
    rows: number | undefined,
    groups: GroupType[] | undefined;
  try {
    footer.fields({
      1: (t) => {
        version = footer.number(t);
      },
      2: (t) => {
        schemaList = footer.list(t, 12, policy.columns + 1, () => schema(footer));
      },
      3: (t) => {
        rows = footer.number(t, 64);
      },
      4: (t) => {
        groups = footer.list(t, 12, policy.groups, () => group(footer, policy.columns));
      },
      8: () => {
        throw unsupported("Parquet footer encryption is unsupported.");
      },
      9: () => {
        throw unsupported("Parquet signed/encrypted footer metadata is unsupported.");
      },
    });
  } catch (error) {
    if (error instanceof NeedMore) throw invalid("Parquet footer is truncated.");
    throw error;
  }
  if (footer.at !== footerLength) throw invalid("Parquet footer has trailing bytes.");
  if (required(version, "file version") !== 1 && version !== 2) {
    throw unsupported("Parquet file metadata version is unsupported.");
  }
  const fields = required(schemaList, "schema"),
    groupList = required(groups, "row groups"),
    rowCount = required(rows, "file rows");
  const root = fields[0];
  if (!root || root.physical !== undefined || root.children !== fields.length - 1) {
    throw unsupported("Parquet requires a flat root schema.");
  }
  const names = new Set<string>();
  const columns: ParquetColumnType[] = [];
  for (let i = 1; i < fields.length; i++) {
    const field = fields[i]!;
    if (
      field.physical === undefined || field.children !== undefined || (field.repetition !== 0 && field.repetition !== 1)
    ) throw unsupported("Parquet nested/repeated schemas are unsupported.");
    if (field.physical > 7 || names.has(field.name)) {
      throw invalid("Parquet physical type or duplicate column name is invalid.");
    }
    if (field.typeLength === 0 || (field.physical === 7 && field.typeLength === undefined)) {
      throw invalid("Parquet fixed or declared type length is absent or zero.");
    }
    names.add(field.name);
    let reason = field.annotated
      ? "Logical annotations are unsupported."
      : width(field.physical) === 0
      ? "Physical type is outside the numeric profile."
      : undefined;
    for (const group of groupList) {
      const chunk = group.chunks[i - 1];
      if (
        !chunk || chunk.physical !== field.physical || chunk.path.length !== 1 || chunk.path[0] !== field.name ||
        chunk.values !== group.rows
      ) throw invalid("Parquet column chunk disagrees with the flat schema or row count.");
      if (chunk.codec !== 0) reason ??= "Compression is unsupported.";
      if (chunk.dictionary !== undefined || chunk.encodings.some((encoding) => encoding !== 0 && encoding !== 3)) {
        reason ??= "Value encoding/dictionaries are unsupported.";
      }
    }
    meter.retain(128);
    columns.push(
      Object.freeze({
        id: i - 1,
        name: field.name,
        physical: field.physical,
        optional: field.repetition === 1,
        readable: reason === undefined,
        ...(reason === undefined ? {} : { reason }),
      }),
    );
  }
  meter.retain(groupList.length * 64);
  const extents: ChunkType[] = [];
  const rowGroups: ParquetRowGroupType[] = [];
  let totalRows = 0;
  for (let i = 0; i < groupList.length; i++) {
    const group = groupList[i]!;
    if (group.chunks.length !== columns.length) throw invalid("Parquet row group column count disagrees with schema.");
    rowGroups.push(Object.freeze({ id: i, offset: totalRows, rows: group.rows }));
    totalRows = toSafeInteger(BigInt(totalRows) + BigInt(group.rows), `Parquet ${"total rows"}`);
    for (const chunk of group.chunks) {
      // Native empty columns can use the required zero page-offset sentinel.
      // It represents no physical extent and must never authorize page reads.
      if (chunk.stored === 0) {
        if (chunk.values !== 0 || chunk.uncompressed !== 0 || chunk.dictionary !== undefined) {
          throw invalid("Parquet empty column declares values, decoded bytes or a dictionary.");
        }
        if (chunk.data === 0) continue;
      }
      if (chunk.start < 4 || chunk.end > footerOffset || chunk.data < chunk.start || chunk.data > chunk.end) {
        throw invalid("Parquet column chunk extent is outside data bytes.");
      }
      if (chunk.stored !== 0) extents.push(chunk);
    }
  }
  if (totalRows !== rowCount) throw invalid("Parquet row groups disagree with file row count.");
  extents.sort((a, b) => a.start - b.start);
  for (let i = 1; i < extents.length; i++) {
    if (extents[i]!.start < extents[i - 1]!.end) throw invalid("Parquet column chunks overlap.");
  }
  options.signal?.throwIfAborted();
  return Object.freeze({
    rows: rowCount,
    columns: Object.freeze(columns),
    rowGroups: Object.freeze(rowGroups),
    integrity: "metadata-unverified" as const,
    work: Object.freeze(budget.inspect()),
    async read(columnId: number, supplied: ParquetReadOptionsType = {}): Promise<ParquetReadType> {
      const opts = { ...supplied };
      assertInteger(columnId, "Parquet column ID");
      const column = columns[columnId];
      if (!column) throw new RangeError("Parquet column ID is absent.");
      if (!column.readable) throw unsupported(column.reason!);
      const signal = options.signal && opts.signal
        ? AbortSignal.any([options.signal, opts.signal])
        : options.signal ?? opts.signal;
      signal?.throwIfAborted();
      const offset = opts.offset ?? 0, length = opts.length ?? rowCount - offset;
      assertInteger(offset, "Parquet row offset");
      assertInteger(length, "Parquet row length");
      if (offset > rowCount || length > rowCount - offset) {
        throw new RangeError("Parquet row selection exceeds the file.");
      }
      if (length > policy.rows) limit("Returned row");
      const owners = together([lifetime, opening, capture(opts.ledger)], signal);
      const credits = { sourceBytes: 0, requests: 0 };
      const operation = new ArchiveBudget(source, {
        ...opts,
        ledger: {
          reserve(kind, count) {
            if ((kind === "sourceBytes" || kind === "requests") && credits[kind] >= count) credits[kind] -= count;
            else owners.reserve(kind, count);
            signal?.throwIfAborted();
          },
          inspect: () => lifetime.inspect(),
        },
      }, signal);
      const readMeter = new Meter(policy, signal);
      const plans: { page: PageType; group: number; row: number; selected: boolean }[] = [];
      for (let g = 0; g < groupList.length; g++) {
        const group = groupList[g]!, base = rowGroups[g]!.offset;
        if (length === 0 || base >= offset + length || base + group.rows <= offset) continue;
        const chunk = group.chunks[columnId]!;
        let at = chunk.data, count = 0, uncompressed = 0;
        while (at < chunk.end) {
          if (plans.length >= policy.pages) limit("Page count");
          let lookahead = Math.min(256, policy.header, chunk.end - at), parsed: PageType | undefined;
          for (;;) {
            operation.decoded(lookahead);
            signal?.throwIfAborted();
            const cursor = new Compact((await operation.read(at, lookahead)).slice(), readMeter);
            try {
              parsed = page(cursor, at);
              break;
            } catch (error) {
              if (!(error instanceof NeedMore)) throw error;
              if (lookahead === Math.min(policy.header, chunk.end - at)) {
                if (lookahead === policy.header && lookahead < chunk.end - at) limit("Page header byte");
                throw invalid("Parquet page header is truncated.");
              }
              lookahead = Math.min(lookahead * 2 || 1, policy.header, chunk.end - at);
            }
          }
          const p = required(parsed, "page");
          if (p.rows > group.rows - count) throw invalid("Parquet page row count exceeds its row group.");
          if (p.encoding !== 0) throw unsupported("Parquet selected column requires PLAIN data pages.");
          if (p.version === 1 && (![3, 4].includes(p.definition) || ![3, 4].includes(p.repetition))) {
            throw invalid("Parquet v1 level encoding is invalid.");
          }
          if (p.stored !== p.decoded || p.stored > chunk.end - at - p.header) {
            throw invalid("Parquet uncompressed page size exceeds its chunk or differs from stored size.");
          }
          if (p.version === 1 && column.optional && p.definition !== 3) {
            throw unsupported("Parquet optional levels require RLE/bit-packed encoding.");
          }
          if (p.version === 2 && (p.repetition !== 0 || (!column.optional && p.definition !== 0))) {
            throw invalid("Parquet flat v2 page level lengths are inconsistent.");
          }
          readMeter.retain(160);
          plans.push({
            page: p,
            group: g,
            row: base + count,
            selected: base + count < offset + length && base + count + p.rows > offset,
          });
          count += p.rows;
          uncompressed = toSafeInteger(
            BigInt(uncompressed) + BigInt(p.decoded + p.header),
            `Parquet ${"uncompressed chunk size"}`,
          );
          at += p.header + p.stored;
        }
        if (count !== group.rows || at !== chunk.end || uncompressed !== chunk.uncompressed) {
          throw invalid("Parquet page totals disagree with column metadata.");
        }
      }
      let bodyBytes = 0, bodyRequests = 0;
      for (const plan of plans) {
        if (plan.selected) {
          if (plan.page.stored > policy.page) limit("Page byte");
          bodyBytes = toSafeInteger(BigInt(bodyBytes) + BigInt(plan.page.stored), `Parquet ${"selected page bytes"}`);
          if (plan.page.stored !== 0) bodyRequests++;
        }
      }
      const work = operation.inspect();
      if (
        bodyBytes > operation.limits.maxSourceBytes - work.sourceBytes ||
        bodyRequests > operation.limits.maxRequests - work.requests
      ) limit("Selected source/request");
      owners.reserve("sourceBytes", bodyBytes);
      owners.reserve("requests", bodyRequests);
      credits.sourceBytes = bodyBytes;
      credits.requests = bodyRequests;
      operation.decoded(bodyBytes);
      const outputBytes = toSafeInteger(
        BigInt(length) * BigInt(width(column.physical) + 1),
        `Parquet ${"output bytes"}`,
      );
      operation.decoded(outputBytes);
      operation.output(outputBytes);
      signal?.throwIfAborted();
      const output = values(column.physical, length), validity = new Uint8Array(length);
      const evidence: ParquetPageEvidenceType[] = [];
      for (const plan of plans) {
        const p = plan.page;
        if (!plan.selected) {
          evidence.push(
            Object.freeze({
              rowGroup: plan.group,
              offset: p.offset,
              rows: p.rows,
              selected: false,
              checksum: "not-read",
            }),
          );
          continue;
        }
        const body = (await operation.read(p.offset + p.header, p.stored)).slice();
        if (p.crc !== undefined && ((crc32(body) ^ 0xffffffff) >>> 0) !== p.crc) {
          throw new ArchiveError("checksum-mismatch", "Parquet selected page CRC32 mismatch.");
        }
        let start = 0, levelBytes = new Uint8Array();
        if (column.optional) {
          if (p.version === 1) {
            if (body.length < 4) {
              throw invalid("Parquet v1 definition length is truncated.");
            }
            const length = createView(body).getUint32(0, true);
            if (length > body.length - 4) throw invalid("Parquet v1 definition levels exceed the page.");
            start = 4 + length;
            levelBytes = body.subarray(4, start);
          } else {
            if (p.definition > body.length) throw invalid("Parquet v2 definition levels exceed the page.");
            start = p.definition;
            levelBytes = body.subarray(0, start);
          }
        }
        const payload = body.subarray(start), data = createView(payload);
        let present = 0;
        const emit = (row: number, valid: boolean): void => {
          readMeter.step();
          const at = plan.row + row - offset;
          if (valid) {
            const index = present++;
            if (at >= 0 && at < length) {
              validity[at] = 1;
              if (column.physical === 0) {
                if ((index >>> 3) >= payload.length) throw invalid("Parquet PLAIN boolean payload is truncated.");
                (output as Uint8Array)[at] = (payload[index >>> 3]! >>> (index & 7)) & 1;
              } else {
                const position = index * width(column.physical);
                if (position > payload.length - width(column.physical)) {
                  throw invalid("Parquet PLAIN numeric payload is truncated.");
                }
                if (column.physical === 2) (output as BigInt64Array)[at] = data.getBigInt64(position, true);
                else {(output as Int32Array | Float32Array | Float64Array)[at] = column.physical === 1
                    ? data.getInt32(position, true)
                    : column.physical === 4
                    ? data.getFloat32(position, true)
                    : data.getFloat64(position, true);}
              }
            }
          }
        };
        try {
          if (column.optional) levels(levelBytes, p.rows, emit, readMeter);
          else for (let row = 0; row < p.rows; row++) emit(row, true);
        } catch (error) {
          if (error instanceof NeedMore) throw invalid("Parquet definition levels are truncated.");
          throw error;
        }
        const expected = column.physical === 0 ? Math.ceil(present / 8) : present * width(column.physical);
        if (payload.length !== expected || (p.nulls !== undefined && p.nulls !== p.rows - present)) {
          throw invalid("Parquet PLAIN byte/null counts disagree with its page header.");
        }
        evidence.push(
          Object.freeze({
            rowGroup: plan.group,
            offset: p.offset,
            rows: p.rows,
            selected: true,
            checksum: p.crc === undefined ? "not-provided" : "crc32-verified",
          }),
        );
      }
      signal?.throwIfAborted();
      return {
        values: output,
        validity,
        pages: Object.freeze(evidence),
        integrity: "selected-pages",
        work: operation.inspect(),
      };
    },
  });
}

export type {
  ParquetColumnType,
  ParquetDatasetType,
  ParquetOpenOptionsType,
  ParquetPageEvidenceType,
  ParquetReadOptionsType,
  ParquetReadType,
  ParquetRowGroupType,
  ParquetValuesType,
} from "./types.ts";
