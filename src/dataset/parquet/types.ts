/**
 * Option, column, row-group and read types for the Parquet reader.
 *
 * @module
 */
import type { ArchiveLimitsType, ArchiveWorkType } from "../../archive/budget.ts";

/** Opening authority remains active for every later read. All caps are finite admission limits. */
export interface ParquetOpenOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  /** Default: 8 MiB of serialized footer bytes, admitted before its owned copy. */
  readonly maxFooterBytes?: number;
  /** Default: 64 KiB of lookahead per page header. Repeated lookahead counts as source work. */
  readonly maxPageHeaderBytes?: number;
  /** Default: 8 MiB for each selected, uncompressed page body. */
  readonly maxPageBytes?: number;
  /** Default: 1,024 flat leaf columns. Nested/repeated schemas are refused. */
  readonly maxColumns?: number;
  /** Default: 4,096 row groups in the footer. */
  readonly maxRowGroups?: number;
  /** Default: 1,048,576 Compact fields, collection elements and varint bytes per operation. */
  readonly maxCompactValues?: number;
  /** Default: 32 nested Compact structs/containers, including skipped unknown fields. */
  readonly maxDepth?: number;
  /** Default: 65,536 bytes per Compact binary/string field, including skipped fields. */
  readonly maxStringBytes?: number;
  /** Default: 8 MiB of retained strings and conservative index/page descriptor allowances. */
  readonly maxRetainedMetadataBytes?: number;
  /** Default: 65,536 page headers scanned across the selected column's intersecting row groups. */
  readonly maxPages?: number;
  /** Default: 1,048,576 rows returned by one read; this does not limit file row count. */
  readonly maxRows?: number;
  /** Default: false. An identity alone is not stable replay evidence. */
  readonly allowUnverifiedSource?: boolean;
}

/** Row ranges are zero-based; omitted length means the remaining rows, subject to output limits. */
export interface ParquetReadOptionsType extends ArchiveLimitsType {
  readonly offset?: number;
  readonly length?: number;
  /** Composes with the opening signal; it cannot revoke the opening owner's cancellation. */
  readonly signal?: AbortSignal;
}

/** Physical values, including identity signed INT32/INT64 annotations. Other logical conversions are refused. */
export interface ParquetColumnType {
  readonly id: number;
  readonly name: string;
  readonly physical: number;
  readonly optional: boolean;
  readonly readable: boolean;
  readonly reason?: string;
}

/** Footer row counts are validated against each other, not proof that unread pages contain those rows. */
export interface ParquetRowGroupType {
  readonly id: number;
  readonly offset: number;
  readonly rows: number;
}

/** A CRC covers only this stored page body. Headers, footer and publisher identity are unauthenticated.
 * `not-read` means the body was not fully acquired or CRC checked; bounded
 * header lookahead can still fetch a prefix of that body's physical bytes.
 */
export interface ParquetPageEvidenceType {
  readonly rowGroup: number;
  /** Physical byte offset of the page header. The body CRC excludes that header. */
  readonly offset: number;
  readonly rows: number;
  readonly selected: boolean;
  readonly checksum: "crc32-verified" | "not-provided" | "not-read";
}

/** INT64 uses bigint; BOOLEAN uses 0/1 bytes. Null slots are zero and require the separate validity mask. */
export type ParquetValuesType = Uint8Array | Int32Array | BigInt64Array | Float32Array | Float64Array;

/** Owned output. IEEE values are preserved, without a NaN payload bit-identity guarantee. */
export interface ParquetReadType {
  readonly values: ParquetValuesType;
  readonly validity: Uint8Array;
  readonly pages: readonly ParquetPageEvidenceType[];
  readonly integrity: "selected-pages";
  readonly work: ArchiveWorkType;
}

/** No source ownership is transferred and no file paths, codecs, queries or mounts are opened. */
export interface ParquetDatasetType {
  readonly rows: number;
  readonly columns: readonly ParquetColumnType[];
  readonly rowGroups: readonly ParquetRowGroupType[];
  readonly integrity: "metadata-unverified";
  readonly work: ArchiveWorkType;
  /**
   * Reads one column into typed arrays.
   * @param column Column index from the schema.
   * @param options Value range, limits and cancellation.
   */
  read(column: number, options?: ParquetReadOptionsType): Promise<ParquetReadType>;
}

export interface PolicyType {
  footer: number;
  header: number;
  page: number;
  columns: number;
  groups: number;
  compact: number;
  depth: number;
  string: number;
  retained: number;
  pages: number;
  rows: number;
}
