/** Pure six-type IPC column decoding; source acquisition belongs to its caller. @module */
import { ArchiveError } from "../../archive/record.ts";
import { requireEligibleSchema, validateBatch } from "./schema.ts";
import type { ArrowBatchType, ArrowSchemaType } from "./schema.ts";

/** These safety limits are independent of physical source requests and Arrow format maxima. */
export interface ArrowColumnLimitsType {
  /** Ordinals preserve duplicate names. Omission selects every field; an empty list selects none. */
  readonly columns?: readonly number[];
  /** Default: 16 MiB per acquired selected physical buffer. */
  readonly maxBufferBytes?: number;
  /** Default: 64 MiB across all selected physical buffers in one admission. */
  readonly maxSelectedBytes?: number;
  /** Default: 1,048,576 value slots per column. */
  readonly maxRows?: number;
  /** Default: 64 MiB of conservative retained output allowance, including masks and UTF-16 text. */
  readonly maxOutputBytes?: number;
}
/** Identity and validity shared by every owned decoded column representation. */
export interface ArrowColumnBaseType {
  /** Zero-based schema position, independent of a possibly duplicate name. */
  readonly ordinal: number;
  /** Original field name; null means absent, while an empty string remains present. */
  readonly name: string | null;
  /** Number of logical value slots, including null slots. */
  readonly rows: number;
  /** Owned value/mask accounting; text adds UTF-16 bytes plus an eight-byte reference allowance per row, not heap headers. */
  readonly outputBytes: number;
  /** Owned one-byte-per-row mask: 1 is present, 0 is null. Null values use canonical zero/empty slots. */
  readonly validity: Uint8Array;
}
/**
 * Owned selected-column values and a separate validity mask. Read the mask to
 * distinguish a null slot from its canonical zero or empty placeholder. Int64
 * values remain bigint, and float64 retains signed zero and IEEE special values.
 * Binary values use one contiguous payload plus rows+1 offsets, rather than one
 * allocation per row. UTF-8 values are strings decoded with fatal validation.
 */
export type ArrowColumnType =
  & ArrowColumnBaseType
  & (
    | {
      /** Signed 32-bit integer layout. */
      readonly physical: "int32";
      /** Owned values, with null slots set to zero. */
      readonly values: Int32Array;
    }
    | {
      /** Signed 64-bit integer layout. */
      readonly physical: "int64";
      /** Owned exact bigint values, with null slots set to 0n. */
      readonly values: BigInt64Array;
    }
    | {
      /** IEEE binary64 layout. */
      readonly physical: "float64";
      /** Owned values, with null slots set to positive zero. */
      readonly values: Float64Array;
    }
    | {
      /** Logical boolean layout. */
      readonly physical: "boolean";
      /** Owned unpacked 0/1 values, with null slots set to zero. */
      readonly values: Uint8Array;
    }
    | {
      /** UTF-8 logical layout. */
      readonly physical: "utf8";
      /** Decoded strings in row order; null slots contain an empty string. */
      readonly values: readonly string[];
    }
    | {
      /** Opaque binary layout. */
      readonly physical: "binary";
      /** Owned concatenated payload for present rows. */
      readonly values: Uint8Array;
      /** Owned rows+1 offsets delimiting each row in values; null rows have equal adjacent offsets. */
      readonly offsets: Int32Array;
    }
  );
/** Admission is allocation/I/O preflight, not a claim that payloads are valid. */
export interface ArrowColumnsAdmissionType {
  /** Safe-number row count admitted before output allocation. */
  readonly rows: number;
  /** Total logical physical-buffer bytes selected for acquisition, excluding padding. */
  readonly selectedBytes: number;
  /** Upper bound used for admission, not an exact heap measurement or actual string byte count. */
  readonly outputBytes: number;
  /** Selection order with independently admitted input and conservative output bytes per ordinal. */
  readonly columns: readonly { readonly ordinal: number; readonly inputBytes: number; readonly outputBytes: number }[];
}
/** Only selected payloads were decoded; unread columns have metadata checks only. */
export interface ArrowColumnsType extends ArrowColumnsAdmissionType {
  /** Owned decoded columns in caller selection order, rather than schema order when reordered. */
  readonly values: readonly ArrowColumnType[];
  /** IPC supplies no checksum or authentication for these payloads. */
  readonly integrity: "none";
  /** Only selected payloads were decoded; excluded columns retain metadata-only checks. */
  readonly scope: "selected-columns";
}
function invalid(message: string): never {
  throw new ArchiveError("invalid-archive", `Arrow ${message}`);
}
function budget(message: string): never {
  throw new ArchiveError("budget-exceeded", `Arrow ${message}`);
}
function policy(options: ArrowColumnLimitsType) {
  const limits = {
    buffer: options.maxBufferBytes ?? 16 * 1024 * 1024,
    selected: options.maxSelectedBytes ?? 64 * 1024 * 1024,
    rows: options.maxRows ?? 1048576,
    output: options.maxOutputBytes ?? 64 * 1024 * 1024,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`Arrow ${name} limit must be a nonnegative safe integer.`);
    }
  }
  return limits;
}

/**
 * Validate all metadata, then reserve the complete selection before any source
 * requests. Async owners must use this aggregate result instead of resetting
 * the same allowance independently for every column. No body bytes are read.
 */
export function admitColumns(
  schema: ArrowSchemaType,
  batch: ArrowBatchType,
  bodyLength: bigint,
  options: ArrowColumnLimitsType = {},
): ArrowColumnsAdmissionType {
  const limits = policy(options), plan = requireEligibleSchema(schema);
  if (plan.fields.length > 1024) budget("column count exceeds 1024 fields.");
  if (plan.fields.some((field, index) => field.ordinal !== index)) invalid("field ordinals are not contiguous.");
  // Body size is geometry here, not bytes to allocate/read. Each selected extent
  // and their sum have separate allowances; unselected body bytes need no copy.
  if (bodyLength < 0n || bodyLength > BigInt(Number.MAX_SAFE_INTEGER)) {
    invalid("body length is outside exact source extents.");
  }
  validateBatch(batch, plan, bodyLength, { maxRows: limits.rows, maxBodyBytes: Number.MAX_SAFE_INTEGER });
  const selection = options.columns === undefined ? plan.fields.map((field) => field.ordinal) : options.columns;
  if (selection.length > plan.fields.length) invalid("selection contains too many ordinals.");
  const seen = new Set<number>(), columns: { ordinal: number; inputBytes: number; outputBytes: number }[] = [];
  let selectedBytes = 0n, outputBytes = 0n;
  for (const ordinal of selection) {
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= plan.fields.length || seen.has(ordinal)) {
      throw new TypeError("Arrow selected ordinals must be distinct existing nonnegative integers.");
    }
    seen.add(ordinal);
    const field = plan.fields[ordinal]!;
    let input = 0n;
    for (let index = 0; index < field.buffers; index++) {
      const length = batch.buffers[field.buffer + index]!.length;
      if (length > BigInt(limits.buffer)) budget("single selected buffer bytes exceed their allowance.");
      input += length;
    }
    const rows = batch.rows;
    let output = rows; // Returned validity is deliberately byte-per-row.
    if (field.physical === "int32") output += rows * 4n;
    else if (field.physical === "int64" || field.physical === "float64") output += rows * 8n;
    else if (field.physical === "boolean") output += rows;
    else {
      const payload = batch.buffers[field.buffer + 2]!.length;
      // UTF-16 bytes cannot exceed twice the input UTF-8 bytes. Reference slots
      // are conservatively charged at eight bytes; engine object headers differ.
      output += field.physical === "utf8" ? payload * 2n + rows * 8n : payload + (rows + 1n) * 4n;
    }
    selectedBytes += input;
    outputBytes += output;
    if (selectedBytes > BigInt(limits.selected)) budget("aggregate selected buffer bytes exceed their allowance.");
    if (outputBytes > BigInt(limits.output)) budget("retained output allowance is exceeded.");
    columns.push({ ordinal, inputBytes: Number(input), outputBytes: Number(output) });
  }
  return { rows: Number(batch.rows), selectedBytes: Number(selectedBytes), outputBytes: Number(outputBytes), columns };
}

/** Validate offsets across all rows, including nulls; payload bytes of null slots are uninterpreted. */
function offsets(bytes: Uint8Array, rows: number, payloadLength: number): DataView {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let prior = 0;
  for (let row = 0; row <= rows; row++) {
    const offset = view.getInt32(row * 4, true);
    if (offset < prior || offset > payloadLength) {
      invalid("variable offsets are negative, decreasing or outside payload.");
    }
    prior = offset;
  }
  return view;
}

/**
 * Decode exact acquired buffers for one ordinal. Input is borrowed only during
 * this synchronous call and must remain stable. Returned masks, typed values,
 * binary payload and offsets own their bytes. The async owner first admits its
 * entire selection with admitColumns(), then passes these exact field buffers.
 */
export function decodeColumn(
  schema: ArrowSchemaType,
  batch: ArrowBatchType,
  bodyLength: bigint,
  ordinal: number,
  buffers: readonly Uint8Array[],
  options: ArrowColumnLimitsType = {},
): ArrowColumnType {
  const admission = admitColumns(schema, batch, bodyLength, { ...options, columns: [ordinal] });
  const plan = requireEligibleSchema(schema), field = plan.fields[ordinal]!;
  if (buffers.length !== field.buffers) invalid("acquired column buffer count disagrees with schema.");
  for (let index = 0; index < buffers.length; index++) {
    if (BigInt(buffers[index]!.byteLength) !== batch.buffers[field.buffer + index]!.length) {
      invalid("acquired buffer length differs from its admitted extent.");
    }
  }
  const rows = admission.rows, bitmap = buffers[0]!, data = buffers[1]!;
  // Verify the declared null count before allocating any returned column.
  let nulls = 0;
  for (let row = 0; row < rows; row++) {
    if (bitmap.length !== 0 && ((bitmap[row >> 3]! >> (row & 7)) & 1) === 0) nulls++;
  }
  if (BigInt(nulls) !== batch.nodes[ordinal]!.nulls) invalid("validity bitmap count disagrees with its field node.");
  const variable = field.physical === "utf8" || field.physical === "binary"
    ? offsets(data, rows, buffers[2]!.length)
    : null;
  const validity = new Uint8Array(rows);
  for (let row = 0; row < rows; row++) validity[row] = bitmap.length === 0 ? 1 : (bitmap[row >> 3]! >> (row & 7)) & 1;
  const base: ArrowColumnBaseType = { ordinal, name: field.name, rows, validity, outputBytes: admission.outputBytes };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (field.physical === "int32") {
    const values = new Int32Array(rows);
    for (let row = 0; row < rows; row++) if (validity[row]) values[row] = view.getInt32(row * 4, true);
    return { ...base, physical: "int32", values };
  }
  if (field.physical === "int64") {
    const values = new BigInt64Array(rows);
    for (let row = 0; row < rows; row++) if (validity[row]) values[row] = view.getBigInt64(row * 8, true);
    return { ...base, physical: "int64", values };
  }
  if (field.physical === "float64") {
    const values = new Float64Array(rows);
    for (let row = 0; row < rows; row++) if (validity[row]) values[row] = view.getFloat64(row * 8, true);
    return { ...base, physical: "float64", values };
  }
  if (field.physical === "boolean") {
    const values = new Uint8Array(rows);
    for (let row = 0; row < rows; row++) if (validity[row]) values[row] = (data[row >> 3]! >> (row & 7)) & 1;
    return { ...base, physical: "boolean", values };
  }
  if (variable === null) invalid("variable column offsets are absent.");
  const payload = buffers[2]!;
  if (field.physical === "utf8") {
    const values: string[] = new Array<string>(rows);
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let outputBytes = rows * 9;
    for (let row = 0; row < rows; row++) {
      if (!validity[row]) {
        values[row] = "";
        continue;
      }
      try {
        values[row] = decoder.decode(
          payload.subarray(variable.getInt32(row * 4, true), variable.getInt32((row + 1) * 4, true)),
        );
        outputBytes += values[row]!.length * 2;
      } catch {
        invalid("selected UTF8 value contains invalid UTF-8.");
      }
    }
    return { ...base, physical: "utf8", values, outputBytes };
  }
  // Canonicalize null byte slots as empty while retaining one contiguous owned
  // payload. Prefix/suffix bytes outside logical offsets need not be retained.
  const outputOffsets = new Int32Array(rows + 1);
  let length = 0;
  for (let row = 0; row < rows; row++) {
    if (validity[row]) length += variable.getInt32((row + 1) * 4, true) - variable.getInt32(row * 4, true);
    outputOffsets[row + 1] = length;
  }
  const values = new Uint8Array(length);
  for (let row = 0; row < rows; row++) {
    if (validity[row]) {
      values.set(
        payload.subarray(variable.getInt32(row * 4, true), variable.getInt32((row + 1) * 4, true)),
        outputOffsets[row]!,
      );
    }
  }
  return {
    ...base,
    physical: "binary",
    values,
    offsets: outputOffsets,
    outputBytes: validity.byteLength + values.byteLength + outputOffsets.byteLength,
  };
}

/** Whole-body convenience path; range owners should acquire only admitted selected buffers instead. */
export function decodeColumns(
  schema: ArrowSchemaType,
  batch: ArrowBatchType,
  body: Uint8Array,
  options: ArrowColumnLimitsType = {},
): ArrowColumnsType {
  const bodyLength = BigInt(body.byteLength), admission = admitColumns(schema, batch, bodyLength, options);
  const plan = requireEligibleSchema(schema), values: ArrowColumnType[] = [];
  for (const column of admission.columns) {
    const field = plan.fields[column.ordinal]!, buffers: Uint8Array[] = [];
    for (let index = 0; index < field.buffers; index++) {
      const extent = batch.buffers[field.buffer + index]!;
      buffers.push(body.subarray(Number(extent.offset), Number(extent.offset + extent.length)));
    }
    values.push(decodeColumn(schema, batch, bodyLength, column.ordinal, buffers, options));
  }
  return { ...admission, values, integrity: "none", scope: "selected-columns" };
}
