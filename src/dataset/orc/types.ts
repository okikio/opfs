/**
 * Option, column, stripe and read types for the ORC reader.
 *
 * @module
 */
import type { ArchiveLimitsType, ArchiveWorkType } from "../../archive/budget.ts";

/** Opening limits remain aggregate authority for all later reads; no source ownership transfers. */
export interface OrcOpenOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  /** Default: 8 MiB of owned serialized file footer bytes. */
  readonly maxFooterBytes?: number;
  /** Default: 1 MiB of owned serialized footer per selected stripe. */
  readonly maxStripeFooterBytes?: number;
  /** Default: 16 MiB total PRESENT/DATA bytes acquired by one selected read. */
  readonly maxSelectedStreamBytes?: number;
  /** Default: 4,096 file stripe descriptors. This is independent of request limits. */
  readonly maxStripes?: number;
  /** Default: 1,024 flat leaf columns. Nested schemas refuse opening. */
  readonly maxColumns?: number;
  /** Default: 8 MiB of conservative retained metadata allowances per operation, not an exact heap cap. */
  readonly maxRetainedMetadataBytes?: number;
  /** Default: 32 nested interpreted Protobuf messages. Unknown binary fields are skipped as opaque bytes. */
  readonly maxDepth?: number;
  /** Default: 65,536 stream descriptors scanned across selected stripes per read. */
  readonly maxStreams?: number;
  /** Default: 65,536 bytes per metadata string, including uninterpreted known text. */
  readonly maxStringBytes?: number;
  /** Default: 1,048,576 returned rows per read; file and decoded stripe row counts can be larger. */
  readonly maxRows?: number;
  /** Default: 8,388,608 wire fields/varint bytes and expanded RLE/row steps per operation. */
  readonly maxSteps?: number;
  /** Default: false. An identity alone is not stable replay evidence. */
  readonly allowUnverifiedSource?: boolean;
}

/** Row ranges are zero-based. The opening signal always remains authoritative. */
export interface OrcReadOptionsType extends ArchiveLimitsType {
  readonly offset?: number;
  readonly length?: number;
  readonly signal?: AbortSignal;
}

/** Schema eligibility only; a selected stripe can still refuse an unsupported encoding or stream role. */
export interface OrcColumnType {
  readonly id: number;
  readonly name: string;
  /** Original ORC Type.Kind number. */
  readonly kind: number;
  readonly supported: boolean;
  readonly reason?: string;
}

/** Declared geometry checked against source bounds; unread column bodies are not validated. */
export interface OrcStripeType {
  readonly id: number;
  /** Physical source offset, unlike rowOffset. */
  readonly offset: number;
  readonly rowOffset: number;
  readonly rows: number;
  readonly indexBytes: number;
  readonly dataBytes: number;
  readonly footerBytes: number;
}

/** LONG is exact bigint; BOOLEAN is 0/1. Null slots are zero and require the separate mask. */
export type OrcValuesType =
  | Uint8Array
  | Int8Array
  | Int16Array
  | Int32Array
  | BigInt64Array
  | Float32Array
  | Float64Array;

/** The selected column's complete streams were decoded, without a checksum or authentication claim. */
export interface OrcStripeReadType {
  readonly id: number;
  readonly rows: number;
  readonly selectedRows: number;
  readonly storedBytes: number;
  readonly encoding: "DIRECT";
}

/** Owned selected output; IEEE semantics are preserved without NaN payload bit-identity guarantees. */
export interface OrcReadType {
  readonly values: OrcValuesType;
  readonly validity: Uint8Array;
  readonly stripes: readonly OrcStripeReadType[];
  readonly integrity: "none";
  readonly scope: "selected-column-stripes";
  readonly work: ArchiveWorkType;
}

/** Borrowed range reader. No query engine, mount, worker or disposal operation is created. */
export interface OrcDatasetType {
  readonly rows: number;
  readonly columns: readonly OrcColumnType[];
  readonly stripes: readonly OrcStripeType[];
  readonly formatVersion: "0.11" | "0.12";
  /** Prose specification and official C++ writer use these two exact conventions. Geometry is checked independently. */
  readonly contentLengthBasis: "body" | "header-and-body";
  readonly integrity: "none";
  /** Frozen work from opening only, not later lifetime counters. */
  readonly work: ArchiveWorkType;
  /**
   * Reads one column into typed arrays.
   * @param columnId Column ID from the file's type list.
   * @param options Value range, limits and cancellation.
   */
  read(columnId: number, options?: OrcReadOptionsType): Promise<OrcReadType>;
}

export interface PolicyType {
  footer: number;
  stripeFooter: number;
  input: number;
  stripes: number;
  columns: number;
  retained: number;
  depth: number;
  streams: number;
  string: number;
  rows: number;
  steps: number;
}
