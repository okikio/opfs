/** Indexed Arrow IPC previews over a caller-owned stable byte source. @module */
import type { ByteSourceType } from "../source.ts";
import { isBytes, toView } from "../bytes.ts";
import { close } from "../close.ts";
import { ArchiveBudget, ArchiveError, createArchiveLedger, integer } from "../archive/record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";
import { inspectBlocks, inspectFileMagic, inspectFileTail, inspectPrefix } from "./arrow/framing.ts";
import { parseFooter, parseMessage, requireEligibleSchema, validateBatch } from "./arrow/schema.ts";
import type { ArrowFieldType, ArrowMetadataLimitsType, ArrowSchemaType } from "./arrow/schema.ts";
import { admitColumns, decodeColumn } from "./arrow/columns.ts";
import type { ArrowColumnLimitsType, ArrowColumnType } from "./arrow/columns.ts";

export { ArchiveError, createArchiveLedger } from "../archive/record.ts";
export type { ArchiveErrorCodeType, ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";
export type { ByteSourceType };
export type { SourceReadOptionsType } from "../source.ts";
export type { ArrowColumnLimitsType, ArrowColumnType, ArrowFieldType, ArrowMetadataLimitsType, ArrowSchemaType };
export type { ArrowColumnBaseType } from "./arrow/columns.ts";
export type { FlatBufferLimitsType } from "./arrow/flatbuffers.ts";
export type { ArrowKeyValueType, ArrowPhysicalType } from "./arrow/schema.ts";

/**
 * Safety limits apply across opening and all reads from the returned dataset.
 * The source and its resources remain caller-owned. Metadata/column limits are
 * implementation policy, independent of Arrow's format limits.
 */
export interface ArrowOpenOptionsType
  extends ArchiveLimitsType, ArrowMetadataLimitsType, Omit<ArrowColumnLimitsType, "columns"> {
  /** Borrowed signal for opening and every later read; abort never closes the source. */
  readonly signal?: AbortSignal;
  /** Default: 8 MiB per footer or message, including metadata padding. */
  readonly maxMetadataBytes?: number;
  /** Default: false. An identity string alone does not prove stable replay. */
  readonly allowUnverifiedSource?: boolean;
}
/** One read returns a complete selected column batch; there is no scalar-row seek. */
export interface ArrowReadOptionsType {
  /** Additional cancellation for this read; the opening signal remains authoritative. */
  readonly signal?: AbortSignal;
}
/** An indexed range, not proof that its message or payload has been read. */
export interface ArrowBatchIndexType {
  /** Zero-based ordinal in the footer, separate from any column ordinal. */
  readonly id: number;
  /** Physical source position of the eight-byte message prefix. */
  readonly offset: number;
  /** Prefix plus padded FlatBuffer bytes; bodies are counted separately. */
  readonly metadataBytes: number;
  /** Declared padded body length; unread body bytes are not verified. */
  readonly bodyBytes: number;
}
/**
 * Owned column values remain stable after later reads. Only selected payloads
 * are validated; Arrow IPC supplies no checksum or authentication for them.
 */
export interface ArrowReadType {
  /** Zero-based record-batch ordinal. */
  readonly batch: number;
  /** Complete row count of each returned column, including null slots. */
  readonly rows: number;
  /** Owned outputs in the caller's requested ordinal order. */
  readonly columns: readonly ArrowColumnType[];
  /** IPC has no content checksum or authentication in this profile. */
  readonly integrity: "none";
  /** Excluded payloads are unread or uninterpreted; their metadata was checked. */
  readonly scope: "selected-columns";
  /** Output bytes are conservative admitted storage, including string allowances. */
  readonly work: ArchiveWorkType;
}
/**
 * A borrowed range reader. Opening compares embedded/footer schemas and checks
 * every indexed extent. It does not inspect unselected batch messages or bodies.
 * No connection, mount, worker or disposal operation is created.
 */
export interface ArrowDatasetType {
  /** Immutable schema fields; names can repeat, so reads use ordinals. */
  readonly columns: readonly ArrowFieldType[];
  /** Immutable footer geometry, without an all-message or all-payload claim. */
  readonly batches: readonly ArrowBatchIndexType[];
  /** No content checksum or authentication was established by opening. */
  readonly integrity: "none";
  /** Opening checks the footer index and matching embedded/footer schemas only. */
  readonly scope: "footer-and-schema";
  /** Frozen opening work; later reads report their own work. */
  readonly work: ArchiveWorkType;
  /** Decode complete selected columns after admitting all metadata in that batch. */
  read(batch: number, columns: readonly number[], options?: ArrowReadOptionsType): Promise<ArrowReadType>;
}

/** A stream's limits cover its entire iteration, including batches the caller retains. */
export interface ArrowStreamOptionsType extends Omit<ArrowOpenOptionsType, "allowUnverifiedSource"> {
  /** Distinct column ordinals; omission selects all, while [] selects none. */
  readonly columns?: readonly number[];
  /** Default: 64 KiB per incoming chunk. Oversized chunks are refused before copying. */
  readonly maxChunkBytes?: number;
}
/** Each yielded batch carries the admitted schema and cumulative stream work. */
export interface ArrowStreamBatchType extends Omit<ArrowReadType, "batch"> {
  /** Zero-based position among record-batch messages, excluding the schema. */
  readonly batch: number;
  /** Immutable shared schema; custom metadata remains ordered opaque data. */
  readonly schema: ArrowSchemaType;
}

function invalid(message: string): never {
  throw new ArchiveError("invalid-archive", `Arrow ${message}`);
}
/** Wire integers remain bigint until their complete extent is known to be addressable. */
function exact(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) invalid("extent exceeds safe addressable integers.");
  return Number(value);
}
/** Freeze all exposed schema data so a caller cannot change a later buffer plan. */
function freezeSchema(schema: ArrowSchemaType): ArrowSchemaType {
  const metadata = (pairs: ArrowSchemaType["metadata"]) =>
    Object.freeze(pairs.map((pair) => Object.freeze({ ...pair })));
  return Object.freeze({
    ...schema,
    metadata: metadata(schema.metadata),
    features: Object.freeze([...schema.features]),
    fields: Object.freeze(
      schema.fields.map((field) => Object.freeze({ ...field, metadata: metadata(field.metadata) })),
    ),
  });
}
/** Ordered metadata and ordinals matter; duplicate names and keys do not become maps. */
function sameSchema(left: ArrowSchemaType, right: ArrowSchemaType): boolean {
  const pairs = (a: ArrowSchemaType["metadata"], b: ArrowSchemaType["metadata"]): boolean =>
    a.length === b.length && a.every((pair, i) => pair.key === b[i]!.key && pair.value === b[i]!.value);
  return left.endianness === right.endianness && pairs(left.metadata, right.metadata) &&
    left.features.length === right.features.length &&
    left.features.every((feature, i) => feature === right.features[i]) &&
    left.fields.length === right.fields.length && left.fields.every((field, i) => {
      const other = right.fields[i]!;
      return field.ordinal === other.ordinal && field.name === other.name && field.nullable === other.nullable &&
        field.physical === other.physical && field.dictionary === other.dictionary &&
        pairs(field.metadata, other.metadata);
    });
}
/** Compose explicit accounting owners once. Failed reservations remain charged. */
function joinLedgers(lifetime: ArchiveLedgerType, external?: ArchiveLedgerType): ArchiveLedgerType {
  const reserve = external?.reserve.bind(external);
  return {
    reserve(kind, bytes) {
      lifetime.reserve(kind, bytes);
      reserve?.(kind, bytes);
    },
    inspect: () => lifetime.inspect(),
  };
}

/**
 * Open one V5, little-endian, uncompressed IPC file with six flat physical types.
 *
 * The caller supplies a stable source, for example createByteSource(bytes) or an
 * object source pinned to a provider revision. Opening reads the footer and the
 * embedded schema. read(batch, ordinals) then admits that batch's full metadata
 * and fetches only the selected columns' buffers. Column ordinals avoid ambiguity
 * when names repeat. Stopping reads never closes the borrowed source.
 *
 * Metadata admission is not payload verification: excluded buffers stay unread.
 * Selected columns are fully decoded before return, so a short UI preview still
 * pays the validation cost of each selected column in its record batch. Dictionary,
 * nested, compressed, legacy and big-endian profiles fail explicitly.
 *
 * @example Read the first column of the last batch from an immutable Blob.
 * ```ts
 * import { openArrow } from "@okikio/opfs/dataset/arrow";
 * import { createBlobSource } from "@okikio/opfs/source";
 * async function preview(file: Blob) {
 *   const dataset = await openArrow(createBlobSource(file));
 *   if (dataset.batches.length === 0 || dataset.columns.length === 0) return;
 *   return await dataset.read(dataset.batches.length - 1, [0]);
 * }
 * ```
 */
export async function openArrow(input: ByteSourceType, supplied: ArrowOpenOptionsType = {}): Promise<ArrowDatasetType> {
  const options = { ...supplied }, size = input.size, stability = input.stability, read = input.read.bind(input);
  integer(size, "Arrow source size");
  if (options.allowUnverifiedSource !== undefined && typeof options.allowUnverifiedSource !== "boolean") {
    throw new TypeError("Arrow allowUnverifiedSource must be a boolean.");
  }
  if (
    !options.allowUnverifiedSource && stability !== "immutable" && stability !== "provider" && stability !== "caller"
  ) {
    throw new TypeError("Arrow requires a stable source; an identity alone is insufficient.");
  }
  const source: ByteSourceType = { size, read };
  const lifetime = joinLedgers(createArchiveLedger(options), options.ledger);
  const opening = new ArchiveBudget(source, { ...options, ledger: lifetime }, options.signal);
  const ownedRead = async (budget: ArchiveBudget, offset: number, length: number): Promise<Uint8Array> =>
    new Uint8Array(await budget.read(offset, length));
  const metadataRead = async (budget: ArchiveBudget, offset: number, length: number): Promise<Uint8Array> => {
    budget.decoded(length);
    return await ownedRead(budget, offset, length);
  };
  if (size < 26) invalid("file is too short for its magic, schema and footer.");
  inspectFileMagic(await ownedRead(opening, 0, 8));
  const tail = inspectFileTail(await ownedRead(opening, size - 10, 10), size, options);
  const footer = parseFooter(await metadataRead(opening, tail.footerOffset, tail.footerLength), options);
  const schema = freezeSchema(footer.schema), plan = requireEligibleSchema(schema);
  const prefix = inspectPrefix(await ownedRead(opening, 8, 8), options);
  if (prefix.kind !== "message") invalid("embedded schema is absent.");
  const schemaEnd = 16 + prefix.metadataLength;
  if (schemaEnd > tail.footerOffset) invalid("embedded schema overlaps footer.");
  const embedded = parseMessage(await metadataRead(opening, 16, prefix.metadataLength), options);
  if (embedded.kind !== "schema" || !sameSchema(schema, embedded.schema)) {
    invalid("embedded and footer schemas disagree.");
  }
  const blocks = inspectBlocks(
    footer.batches,
    { sourceSize: size, footerOffset: tail.footerOffset, schemaEnd },
    options,
  );
  const batches = Object.freeze(blocks.map((block, id) =>
    Object.freeze({
      id,
      offset: block.offset,
      metadataBytes: block.metadataLength + 8,
      bodyBytes: block.bodyLength,
    })
  ));
  return Object.freeze({
    columns: schema.fields,
    batches,
    integrity: "none" as const,
    scope: "footer-and-schema" as const,
    work: Object.freeze(opening.inspect()),
    async read(
      batch: number,
      columns: readonly number[],
      suppliedRead: ArrowReadOptionsType = {},
    ): Promise<ArrowReadType> {
      integer(batch, "Arrow batch ordinal");
      const block = blocks[batch];
      if (!block) throw new RangeError("Unknown Arrow batch ordinal.");
      if (columns.length > schema.fields.length) throw new TypeError("Arrow selection has too many column ordinals.");
      const selected = [...columns], parent = options.signal, local = suppliedRead.signal;
      const signal = parent && local ? AbortSignal.any([parent, local]) : parent ?? local;
      signal?.throwIfAborted();
      const budget = new ArchiveBudget(source, { ...options, ledger: lifetime }, signal);
      const prefix = inspectPrefix(await ownedRead(budget, block.offset, 8), options);
      if (prefix.kind !== "message" || prefix.metadataLength !== block.metadataLength) {
        invalid("indexed metadata length disagrees with the message prefix.");
      }
      const message = parseMessage(await metadataRead(budget, block.metadataOffset, block.metadataLength), options);
      if (message.kind !== "record-batch" || message.bodyLength !== BigInt(block.bodyLength)) {
        invalid("indexed body length or record-batch kind disagrees with its message.");
      }
      validateBatch(message.batch, plan, message.bodyLength, options);
      const admitted = admitColumns(schema, message.batch, message.bodyLength, { ...options, columns: selected });
      // Charge conservative output storage before acquisition or materialization.
      budget.decoded(admitted.selectedBytes);
      budget.output(admitted.outputBytes);
      const output: ArrowColumnType[] = [];
      for (const column of admitted.columns) {
        const field = plan.fields[column.ordinal]!, buffers: Uint8Array[] = [];
        for (let at = 0; at < field.buffers; at++) {
          const extent = message.batch.buffers[field.buffer + at]!;
          buffers.push(await ownedRead(budget, block.bodyOffset + exact(extent.offset), exact(extent.length)));
        }
        signal?.throwIfAborted();
        output.push(decodeColumn(schema, message.batch, message.bodyLength, column.ordinal, buffers, {
          ...options,
          maxOutputBytes: column.outputBytes,
        }));
      }
      signal?.throwIfAborted();
      return {
        batch,
        rows: admitted.rows,
        columns: output,
        integrity: "none",
        scope: "selected-columns",
        work: budget.inspect(),
      };
    },
  });
}

/**
 * Read modern V5 IPC messages on demand, yielding complete selected column batches.
 *
 * The first next() acquires the reader. From then on, this operation has authority
 * to cancel the underlying stream on failure, abort or early iterator return. It
 * always releases its lock and awaits cancellation; a foreign source's cancel
 * promise must settle for cleanup to finish. No prefetch, reconnection or durable
 * resume state is created. A yielded batch does not validate later messages.
 *
 * The stream must start with a schema. Clean EOF at a message boundary and an
 * explicit EOS followed by EOF both finish successfully. Partial frames and bytes
 * after EOS fail. Earlier body bytes must be consumed to reach a later batch;
 * excluded columns have metadata checks, but their payloads are not decoded.
 *
 * @example Consume IPC stream batches without retaining the whole scan.
 * ```ts
 * import { readArrow } from "@okikio/opfs/dataset/arrow";
 * async function inspect(stream: ReadableStream<Uint8Array>) {
 *   for await (const batch of readArrow(stream, { columns: [0] })) {
 *     console.log(batch.rows, batch.columns[0]?.validity, batch.integrity);
 *   }
 * }
 * ```
 */
export async function* readArrow(
  stream: ReadableStream<Uint8Array>,
  supplied: ArrowStreamOptionsType = {},
): AsyncGenerator<ArrowStreamBatchType> {
  const inputOptions = { ...supplied }, selection = inputOptions.columns;
  if (selection !== undefined && selection.length > 1024) {
    throw new ArchiveError("budget-exceeded", "Arrow selected column count exceeds 1,024 fields.");
  }
  const options = { ...inputOptions, ...(selection === undefined ? {} : { columns: [...selection] }) };
  const maximum = options.maxChunkBytes ?? 65536;
  integer(maximum, "Arrow incoming chunk bytes");
  const meter = joinLedgers(createArchiveLedger(options), options.ledger), signal = options.signal;
  signal?.throwIfAborted();
  const reader = stream.getReader();
  let pending: Uint8Array<ArrayBuffer> = new Uint8Array(), position = 0, empty = 0;
  let finished = false, sourceErrored = false, cancellation: Promise<void> | undefined;
  const failures: unknown[] = [];
  // One cached cancellation owns retirement, even if abort and return race.
  const cancel = (reason?: unknown): Promise<void> => {
    cancellation ??= Promise.resolve().then(() => reader.cancel(reason));
    void cancellation.catch(() => {});
    return cancellation;
  };
  const abort = (): void => {
    void cancel(signal?.reason);
  };
  signal?.addEventListener("abort", abort, { once: true });
  /** Only a clean empty prefix position can interpret EOF as successful completion. */
  const take = async (length: number, boundary = false): Promise<Uint8Array | null> => {
    const output = new Uint8Array(length);
    let at = 0;
    while (at < length) {
      signal?.throwIfAborted();
      if (position === pending.length) {
        meter.reserve("requests", 1);
        let item: ReadableStreamReadResult<Uint8Array>;
        try {
          item = await reader.read();
        } catch (reason) {
          // An errored stream already owns its terminal failure. Cancelling it
          // again would report that same stored failure as a new cleanup event.
          sourceErrored = true;
          throw reason;
        }
        signal?.throwIfAborted();
        if (item.done) {
          if (boundary && at === 0) return null;
          invalid("stream ended inside a frame.");
        }
        if (!isBytes(item.value)) invalid("stream returned a non-byte chunk.");
        const bytes = toView(item.value);
        if (bytes.byteLength > maximum) {
          throw new ArchiveError("budget-exceeded", "Arrow incoming chunk exceeds its allowance.");
        }
        meter.reserve("sourceBytes", bytes.byteLength);
        if (bytes.byteLength === 0) {
          if (++empty > 16) throw new ArchiveError("budget-exceeded", "Arrow stream produced too many empty chunks.");
          continue;
        }
        empty = 0;
        // A tiny subarray never makes us retain its potentially huge backing buffer.
        pending = new Uint8Array(bytes);
        position = 0;
      }
      const count = Math.min(length - at, pending.length - position);
      output.set(pending.subarray(position, position + count), at);
      position += count;
      at += count;
    }
    return output;
  };
  try {
    let schema: ArrowSchemaType | undefined, batch = 0;
    while (true) {
      const bytes = await take(8, true);
      if (bytes === null) {
        if (!schema) invalid("stream ended before its schema.");
        finished = true;
        break;
      }
      const prefix = inspectPrefix(bytes, options);
      if (prefix.kind === "eos") {
        if (!schema) invalid("stream ended before its schema.");
        if (await take(1, true) !== null) invalid("stream contains bytes after EOS.");
        finished = true;
        break;
      }
      meter.reserve("decodedBytes", prefix.metadataLength);
      const message = parseMessage((await take(prefix.metadataLength))!, options);
      if (!schema) {
        if (message.kind !== "schema") invalid("stream's first message is not a schema.");
        requireEligibleSchema(message.schema);
        schema = freezeSchema(message.schema);
        continue;
      }
      if (message.kind !== "record-batch") invalid("stream contains a second schema.");
      if (batch >= (options.maxBatches ?? 4096)) {
        throw new ArchiveError("budget-exceeded", "Arrow stream batch count exceeds its allowance.");
      }
      const admission = admitColumns(schema, message.batch, message.bodyLength, options);
      // Whole bounded bodies must arrive in stream order. Indexed files can avoid
      // these excluded bytes; a forward-only stream cannot seek over them.
      meter.reserve("decodedBytes", exact(message.bodyLength));
      meter.reserve("outputBytes", admission.outputBytes);
      const body = (await take(exact(message.bodyLength)))!, plan = requireEligibleSchema(schema);
      const columns: ArrowColumnType[] = [];
      for (const column of admission.columns) {
        const field = plan.fields[column.ordinal]!, buffers: Uint8Array[] = [];
        for (let index = 0; index < field.buffers; index++) {
          const extent = message.batch.buffers[field.buffer + index]!, offset = exact(extent.offset);
          buffers.push(body.subarray(offset, offset + exact(extent.length)));
        }
        signal?.throwIfAborted();
        columns.push(decodeColumn(schema, message.batch, message.bodyLength, column.ordinal, buffers, options));
      }
      signal?.throwIfAborted();
      yield {
        batch: batch++,
        schema,
        rows: admission.rows,
        columns,
        integrity: "none",
        scope: "selected-columns",
        work: meter.inspect(),
      };
    }
  } catch (reason) {
    failures.push(reason);
  } finally {
    signal?.removeEventListener("abort", abort);
    await close([
      async () => {
        if (cancellation) await cancellation;
        else if (!finished && !sourceErrored) await cancel(failures[0]);
      },
      () => reader.releaseLock(),
    ], failures);
  }
}
