/**
 * Private Arrow V5 metadata grammar. Parsing validates metadata extents; schema
 * admission assigns buffer positions. Neither step reads or verifies body bytes.
 * Slots follow the pinned Arrow 21 Schema.fbs, Message.fbs and File.fbs schemas.
 * @module
 */
import { ArchiveError } from "../../archive/record.ts";
import { FlatBuffers } from "./flatbuffers.ts";
import type { FlatBufferLimitsType, FlatBufferVectorType } from "./flatbuffers.ts";

/** Each call owns an independent finite metadata-work allowance, not an I/O ledger. */
export interface ArrowMetadataLimitsType extends FlatBufferLimitsType {
  /** Maximum flat fields, and separately maximum field nodes per batch. Default: 1024. */
  readonly maxFields?: number;
  /** Aggregate custom metadata pairs across a single parsed message or footer. Default: 4096. */
  readonly maxEntries?: number;
  /** Maximum required-feature entries in one schema. Default: 64. Unsupported features still fail admission. */
  readonly maxFeatures?: number;
  /** Maximum physical buffer descriptors in one batch, including excluded columns. Default: 3072. */
  readonly maxBuffers?: number;
  /** Aggregate UTF-8 bytes retained as names, keys and values in this parse. Default: 1 MiB. */
  readonly maxRetainedStringBytes?: number;
  /** Maximum record-batch blocks in a footer. Default: 4096. This does not acquire their messages. */
  readonly maxBatches?: number;
  /** Maximum value slots per column in one batch. Default: 1,048,576. */
  readonly maxRows?: number;
  /** Maximum padded body bytes declared by one message or block. Default: 64 MiB. */
  readonly maxBodyBytes?: number;
}
/** Ordered opaque application metadata. Missing strings differ from empty strings. */
export interface ArrowKeyValueType {
  /** Opaque key text; null means absent, while an empty string remains present. Duplicate keys retain their order. */
  readonly key: string | null;
  /** Opaque value text, never executed or interpreted as an extension handler. Null differs from an empty string. */
  readonly value: string | null;
}
/** Exact flat physical layouts admitted by this first private reader profile. */
export type ArrowPhysicalType = "int32" | "int64" | "float64" | "boolean" | "utf8" | "binary";
/** Ordinals, rather than possibly duplicate or absent names, identify columns. */
export interface ArrowFieldType {
  /** Zero-based position in the schema; use this identity when names repeat. */
  readonly ordinal: number;
  /** Original name text. Empty, duplicate and absent (null) names remain distinct data. */
  readonly name: string | null;
  /** Whether field nodes may declare null slots. An absent wire flag defaults to false. */
  readonly nullable: boolean;
  /** Physical memory layout, independent of opaque application or extension metadata. */
  readonly physical: ArrowPhysicalType;
  /** Whether dictionary encoding was declared. The current reader refuses such a field before body decoding. */
  readonly dictionary: boolean;
  /** Ordered custom pairs, including duplicate keys; these do not install codecs or change the reader's layout. */
  readonly metadata: readonly ArrowKeyValueType[];
}
/** Known flat physical grammar; endianness/features/dictionaries still need admission. */
export interface ArrowSchemaType {
  /** Arrow enum: 0 is little-endian and 1 is big-endian. Only 0 passes current reader admission. */
  readonly endianness: number;
  /** Flat fields in their original ordinal order. Names do not form a unique lookup key. */
  readonly fields: readonly ArrowFieldType[];
  /** Ordered opaque schema annotations, preserved without executing extension behavior. */
  readonly metadata: readonly ArrowKeyValueType[];
  /** Required feature identifiers as exact wire int64 values. Nonzero features are currently refused. */
  readonly features: readonly bigint[];
}
/** Buffer ordinals are assigned only after all fields pass the supported profile. */
export interface ArrowPlanType {
  /** Schema whose entire field list passed physical-layout eligibility. */
  readonly schema: ArrowSchemaType;
  /** Each field adds its first physical buffer ordinal and its two- or three-buffer count. */
  readonly fields: readonly (ArrowFieldType & { readonly buffer: number; readonly buffers: 2 | 3 })[];
  /** Expected total buffer descriptors for every batch, including unselected columns. */
  readonly buffers: number;
}
/** One flat field's value-slot and null counts, not a decoded validity bitmap. */
export interface ArrowNodeType {
  /** Number of value slots, which must agree with the batch row count for this flat profile. */
  readonly length: bigint;
  /** Declared number of null slots; selected decoding separately verifies the actual bitmap. */
  readonly nulls: bigint;
}
/** Body-relative byte extent, excluding its trailing alignment padding. */
export interface ArrowBufferType {
  /** Eight-byte-aligned byte position relative to the message body. */
  readonly offset: bigint;
  /** Logical physical-buffer bytes, excluding trailing alignment padding. */
  readonly length: bigint;
}
/** Metadata-only description; the body must still be acquired and validated. */
export interface ArrowBatchType {
  /** Exact wire row count, retained as bigint until bounded materialization admission. */
  readonly rows: bigint;
  /** One node per field, in schema ordinal order for the flat supported profile. */
  readonly nodes: readonly ArrowNodeType[];
  /** Physical extents in schema layout order; metadata admission does not validate their payload bytes. */
  readonly buffers: readonly ArrowBufferType[];
}
/** Block.offset points at the continuation prefix; metadataLength includes that prefix and padding. */
export interface ArrowBlockType {
  /** Absolute file position of the block's modern continuation prefix. */
  readonly offset: bigint;
  /** Eight-byte prefix plus padded FlatBuffer metadata bytes; body bytes are separate. */
  readonly metadataLength: number;
  /** Includes body padding; individual Buffer lengths exclude their padding. */
  readonly bodyLength: bigint;
}
/** Footer index only; this does not establish that indexed messages exist or agree. */
export interface ArrowFooterType {
  /** Footer schema, still to be compared with the embedded schema by the file owner. */
  readonly schema: ArrowSchemaType;
  /** Ordered descriptors; acquiring and validating each indexed message remains a separate operation. */
  readonly batches: readonly ArrowBlockType[];
  /** Ordered opaque footer annotations. */
  readonly metadata: readonly ArrowKeyValueType[];
}
/** Schema or record-batch header with no retained view into its input metadata. */
export type ArrowMessageType =
  & {
    /** Padded body bytes following this metadata region, not a body-content verification result. */
    readonly bodyLength: bigint;
    /** Ordered opaque message annotations, separate from schema annotations. */
    readonly metadata: readonly ArrowKeyValueType[];
  }
  & (
    | { readonly kind: "schema"; readonly schema: ArrowSchemaType }
    | { readonly kind: "record-batch"; readonly batch: ArrowBatchType }
  );

type PolicyType = {
  readonly fields: number;
  readonly entries: number;
  readonly features: number;
  readonly buffers: number;
  readonly strings: number;
  readonly batches: number;
  readonly rows: bigint;
  readonly body: bigint;
};
function invalid(message: string): never {
  throw new ArchiveError("invalid-archive", `Arrow ${message}`);
}
function unsupported(message: string): never {
  throw new ArchiveError("unsupported-profile", `Arrow ${message}`);
}
function budget(message: string): never {
  throw new ArchiveError("budget-exceeded", `Arrow ${message}`);
}
function policy(options: ArrowMetadataLimitsType): PolicyType {
  const values = {
    fields: options.maxFields ?? 1024,
    entries: options.maxEntries ?? 4096,
    features: options.maxFeatures ?? 64,
    buffers: options.maxBuffers ?? 3072,
    strings: options.maxRetainedStringBytes ?? 1024 * 1024,
    batches: options.maxBatches ?? 4096,
    rows: options.maxRows ?? 1048576,
    body: options.maxBodyBytes ?? 64 * 1024 * 1024,
  };
  for (const [key, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`Arrow ${key} limit must be a nonnegative safe integer.`);
    }
  }
  return { ...values, rows: BigInt(values.rows), body: BigInt(values.body) };
}
/** Missing scalar slots use the defaults declared in the FlatBuffers schema. */
class Grammar {
  readonly fb: FlatBuffers;
  readonly maximum: PolicyType;
  #entries = 0;
  #strings = 0;
  constructor(bytes: Uint8Array, options: ArrowMetadataLimitsType) {
    this.maximum = policy(options);
    this.fb = new FlatBuffers(bytes, options);
  }
  pointer(table: number, slot: number): number | null {
    const at = this.fb.field(table, slot, 4);
    return at === null ? null : this.fb.reference(at);
  }
  table(table: number, slot: number): number {
    const at = this.pointer(table, slot);
    if (at === null) invalid("required table is absent.");
    // Validate even empty union payload tables (Bool, Binary and Utf8).
    this.fb.field(at, 0, 1);
    return at;
  }
  vector(table: number, slot: number, stride: number, maximum: number): FlatBufferVectorType {
    const at = this.pointer(table, slot);
    if (at === null) return { offset: 0, length: 0, stride };
    const vector = this.fb.vector(at, stride);
    if (vector.length > maximum) budget("vector count exceeds its allowance.");
    return vector;
  }
  short(table: number, slot: number): number {
    const at = this.fb.field(table, slot, 2);
    return at === null ? 0 : this.fb.i16(at);
  }
  byte(table: number, slot: number): number {
    const at = this.fb.field(table, slot, 1);
    return at === null ? 0 : this.fb.u8(at);
  }
  bool(table: number, slot: number): boolean {
    const value = this.byte(table, slot);
    if (value > 1) invalid("boolean scalar is neither zero nor one.");
    return value === 1;
  }
  int(table: number, slot: number): number {
    const at = this.fb.field(table, slot, 4);
    return at === null ? 0 : this.fb.i32(at);
  }
  long(table: number, slot: number): bigint {
    const at = this.fb.field(table, slot, 8);
    return at === null ? 0n : this.fb.i64(at);
  }
  string(table: number, slot: number): string | null {
    const at = this.pointer(table, slot);
    if (at === null) return null;
    const length = this.fb.u32(at);
    if (length > this.maximum.strings - this.#strings) budget("retained string bytes exceed their allowance.");
    this.#strings += length;
    return this.fb.string(at);
  }
  metadata(table: number, slot: number): ArrowKeyValueType[] {
    const vector = this.vector(table, slot, 4, this.maximum.entries - this.#entries);
    this.#entries += vector.length;
    const values: ArrowKeyValueType[] = [];
    for (let i = 0; i < vector.length; i++) {
      const item = this.fb.reference(vector.offset + i * 4);
      values.push({ key: this.string(item, 0), value: this.string(item, 1) });
    }
    return values;
  }
  version(table: number): void {
    if (this.short(table, 0) !== 4) unsupported("metadata version must be V5.");
  }
  schema(table: number): ArrowSchemaType {
    const endianness = this.short(table, 0);
    if (endianness !== 0 && endianness !== 1) invalid("endianness enum is unknown.");
    const vector = this.vector(table, 1, 4, this.maximum.fields), fields: ArrowFieldType[] = [];
    for (let ordinal = 0; ordinal < vector.length; ordinal++) {
      const field = this.fb.reference(vector.offset + ordinal * 4);
      const kind = this.byte(field, 2), type = this.table(field, 3);
      let physical: ArrowPhysicalType;
      if (kind === 2) {
        const width = this.int(type, 0), signed = this.bool(type, 1);
        if (!signed || (width !== 32 && width !== 64)) unsupported("only signed int32 and int64 are admitted.");
        physical = width === 32 ? "int32" : "int64";
      } else if (kind === 3) {
        if (this.short(type, 0) !== 2) unsupported("only float64 is admitted.");
        physical = "float64";
      } else if (kind === 4) physical = "binary";
      else if (kind === 5) physical = "utf8";
      else if (kind === 6) physical = "boolean";
      else unsupported("field union type is outside the six-type profile.");
      if (this.vector(field, 5, 4, this.maximum.fields).length !== 0) unsupported("nested fields are not admitted.");
      const dictionary = this.pointer(field, 4);
      if (dictionary !== null) {
        // A dictionary is a recognized refusal, never a guessed primitive layout.
        this.fb.field(dictionary, 0, 8);
      }
      fields.push({
        ordinal,
        name: this.string(field, 0),
        nullable: this.bool(field, 1),
        physical,
        dictionary: dictionary !== null,
        metadata: this.metadata(field, 6),
      });
    }
    const metadata = this.metadata(table, 2), features: bigint[] = [];
    const featureVector = this.vector(table, 3, 8, this.maximum.features);
    for (let i = 0; i < featureVector.length; i++) features.push(this.fb.i64(featureVector.offset + i * 8));
    return { endianness, fields, metadata, features };
  }
  body(length: bigint): void {
    if (length < 0n || length % 8n !== 0n) invalid("body length must be nonnegative and eight-byte aligned.");
    if (length > this.maximum.body) budget("body bytes exceed their allowance.");
  }
  batch(table: number): ArrowBatchType {
    if (this.pointer(table, 3) !== null) unsupported("compressed record batches are not admitted.");
    if (this.vector(table, 4, 8, this.maximum.entries).length !== 0) unsupported("variadic buffers are not admitted.");
    const rows = this.long(table, 0);
    if (rows < 0n) invalid("row count is negative.");
    if (rows > this.maximum.rows) budget("row count exceeds its allowance.");
    const nodes: ArrowNodeType[] = [], buffers: ArrowBufferType[] = [];
    const nodeVector = this.vector(table, 1, 16, this.maximum.fields);
    for (let i = 0; i < nodeVector.length; i++) {
      const at = nodeVector.offset + i * 16, length = this.fb.i64(at), nulls = this.fb.i64(at + 8);
      if (length < 0n || nulls < 0n || nulls > length) invalid("field node length or null count is invalid.");
      nodes.push({ length, nulls });
    }
    const bufferVector = this.vector(table, 2, 16, this.maximum.buffers);
    for (let i = 0; i < bufferVector.length; i++) {
      const at = bufferVector.offset + i * 16, offset = this.fb.i64(at), length = this.fb.i64(at + 8);
      if (offset < 0n || length < 0n || offset % 8n !== 0n) invalid("buffer extent is negative or unaligned.");
      buffers.push({ offset, length });
    }
    return { rows, nodes, buffers };
  }
}

/** Parse one FlatBuffer Message region, excluding its continuation/length prefix. */
export function parseMessage(bytes: Uint8Array, options: ArrowMetadataLimitsType = {}): ArrowMessageType {
  const grammar = new Grammar(bytes, options), table = grammar.fb.root();
  grammar.version(table);
  const kind = grammar.byte(table, 1), header = grammar.table(table, 2), bodyLength = grammar.long(table, 3);
  grammar.body(bodyLength);
  const metadata = grammar.metadata(table, 4);
  if (kind === 1) {
    if (bodyLength !== 0n) invalid("schema message has a body.");
    return { kind: "schema", schema: grammar.schema(header), bodyLength, metadata };
  }
  if (kind === 3) return { kind: "record-batch", batch: grammar.batch(header), bodyLength, metadata };
  unsupported("message union is outside the schema/record-batch profile.");
}

/** Parse only the footer region. Outer acquisition owns magic, framing and index/source bounds. */
export function parseFooter(bytes: Uint8Array, options: ArrowMetadataLimitsType = {}): ArrowFooterType {
  const grammar = new Grammar(bytes, options), table = grammar.fb.root();
  grammar.version(table);
  const schema = grammar.schema(grammar.table(table, 1));
  if (grammar.vector(table, 2, 24, grammar.maximum.batches).length !== 0) {
    unsupported("dictionary footer blocks are not admitted.");
  }
  const vector = grammar.vector(table, 3, 24, grammar.maximum.batches), batches: ArrowBlockType[] = [];
  let previousEnd = 8n;
  for (let i = 0; i < vector.length; i++) {
    const at = vector.offset + i * 24,
      offset = grammar.fb.i64(at),
      metadataLength = grammar.fb.i32(at + 8),
      bodyLength = grammar.fb.i64(at + 16);
    grammar.body(bodyLength);
    if (offset < previousEnd || offset % 8n !== 0n || metadataLength < 16 || metadataLength % 8 !== 0) {
      invalid("footer block is unordered, overlapping or unaligned.");
    }
    previousEnd = offset + BigInt(metadataLength) + bodyLength;
    batches.push({ offset, metadataLength, bodyLength });
  }
  return { schema, batches, metadata: grammar.metadata(table, 4) };
}

/** Admission precedes buffer ordinal assignment, including for unselected fields. */
export function requireEligibleSchema(schema: ArrowSchemaType): ArrowPlanType {
  if (schema.endianness !== 0) unsupported("only little-endian bodies are admitted.");
  if (schema.features.some((feature) => feature !== 0n)) unsupported("required schema features are not admitted.");
  if (schema.fields.some((field) => field.dictionary)) unsupported("dictionary fields are not admitted.");
  let buffers = 0;
  const fields = schema.fields.map((field) => {
    const count: 2 | 3 = field.physical === "utf8" || field.physical === "binary" ? 3 : 2;
    const result = { ...field, buffer: buffers, buffers: count };
    buffers += count;
    return result;
  });
  return { schema, fields, buffers };
}

/**
 * Check all node counts and body extents before acquiring selected payload ranges.
 * This does not inspect validity bits, offsets, UTF-8 or values, and cannot claim
 * complete body verification. All int64 arithmetic remains bigint until admitted.
 */
export function validateBatch(
  batch: ArrowBatchType,
  plan: ArrowPlanType,
  bodyLength: bigint,
  options: ArrowMetadataLimitsType = {},
): void {
  const maximum = policy(options);
  if (batch.rows < 0n || bodyLength < 0n || bodyLength % 8n !== 0n) invalid("batch rows or body length is invalid.");
  if (batch.rows > maximum.rows || bodyLength > maximum.body) {
    budget("batch rows or body bytes exceed their allowance.");
  }
  if (batch.nodes.length !== plan.fields.length || batch.buffers.length !== plan.buffers) {
    invalid("field node or buffer cardinality disagrees with schema.");
  }
  let end = 0n;
  for (const buffer of batch.buffers) {
    if (
      buffer.offset < end || buffer.offset < 0n || buffer.offset % 8n !== 0n || buffer.length < 0n ||
      buffer.offset > bodyLength || buffer.length > bodyLength - buffer.offset
    ) invalid("buffer lies outside the body or overlaps its predecessor.");
    end = buffer.offset + buffer.length;
  }
  for (const field of plan.fields) {
    const node = batch.nodes[field.ordinal]!;
    if (
      node.length !== batch.rows || node.nulls < 0n || node.nulls > node.length ||
      (!field.nullable && node.nulls !== 0n)
    ) invalid("field node disagrees with rows or nullability.");
    const validity = batch.buffers[field.buffer]!;
    const bitmapBytes = (batch.rows + 7n) / 8n;
    if (validity.length !== 0n && validity.length < bitmapBytes || node.nulls > 0n && validity.length < bitmapBytes) {
      invalid("validity bitmap is too short.");
    }
    const values = batch.buffers[field.buffer + 1]!;
    const minimum = field.physical === "int32"
      ? batch.rows * 4n
      : field.physical === "int64" || field.physical === "float64"
      ? batch.rows * 8n
      : field.physical === "boolean"
      ? bitmapBytes
      : (batch.rows + 1n) * 4n;
    if (values.length < minimum) invalid("values or offsets buffer is too short.");
  }
}
