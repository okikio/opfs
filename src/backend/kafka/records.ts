/** Pure uncompressed magic-2 batches, admitted as complete pages before filtering. @module */
import { resolveLimit } from "../../check.ts";
import { isBytes, toView } from "../../bytes.ts";
import { long, MAX_FRAME, MAX_LONG, Reader, Writer } from "./wire.ts";

/** Ordered binary header; duplicate names are meaningful and remain in order. */
export interface KafkaHeaderType {
  /** Header key, decoded as UTF-8. */
  readonly name: string;
  /** Null and zero-length bytes are distinct Kafka values. */
  readonly value: Uint8Array | null;
}
/** One explicit CreateTime record. Payload arrays are borrowed until snapshotRecords(). */
export interface KafkaRecordType {
  /** Nonnegative signed int64 milliseconds; no implicit clock or Number conversion. */
  readonly timestamp: bigint;
  /** Record key. Null and zero-length bytes are distinct Kafka values. */
  readonly key: Uint8Array | null;
  /** Record value. Null is a tombstone on a compacted topic. */
  readonly value: Uint8Array | null;
  /** Headers in wire order. */
  readonly headers: readonly KafkaHeaderType[];
}
/** A returned record owns its nested payload bytes independently of the response frame. */
export interface KafkaFetchedRecordType extends KafkaRecordType {
  /** Absolute partition offset: the batch base offset plus the record's offset delta. */
  readonly offset: bigint;
}
/** Caller policy can lower these implementation ceilings, never raise them. */
export interface KafkaRecordLimitsType {
  /** Maximum complete serialized record bytes over the whole page; default/ceiling 1 MiB. */
  readonly maxBytes?: number;
  /** Wire records before offset filtering; default/ceiling 1024. */
  readonly maxRecords?: number;
  /** Aggregate headers before offset filtering; default/ceiling 1024. Zero refuses all headers. */
  readonly maxHeaders?: number;
  /** Headers in any one record; default/ceiling 64. Zero refuses all headers. */
  readonly maxRecordHeaders?: number;
}
/** Native batch boundaries survive compaction, even when there are no records. */
export interface KafkaBatchType {
  /** Offset of the batch's first record slot. */
  readonly baseOffset: bigint;
  /** Offset of the batch's last record slot, from the header's last offset delta. */
  readonly lastOffset: bigint;
  /** `lastOffset + 1`: where the next fetch continues, even when compaction removed every record. */
  readonly nextOffset: bigint;
  /** First timestamp in the batch, in milliseconds. */
  readonly baseTimestamp: bigint;
  /** Largest timestamp in the batch, in milliseconds. */
  readonly maxTimestamp: bigint;
  /** Partition leader epoch recorded in the batch header. */
  readonly leaderEpoch: number;
  /** Records present on the wire in this batch. */
  readonly recordCount: number;
}
/** A completely admitted page; no result is published when a later batch fails. */
export interface KafkaRecordsType {
  /** Records at or after the requested offset, in offset order. */
  readonly records: readonly KafkaFetchedRecordType[];
  /** Offset to request next: past every admitted batch, or the requested offset when the page had none. */
  readonly nextOffset: bigint;
  /** Every admitted batch header, including empty compacted batches. */
  readonly batches: readonly KafkaBatchType[];
  /** Records read from the wire before offset filtering, counted against `maxRecords`. */
  readonly wireRecords: number;
  /** Serialized record bytes over the page, counted against `maxBytes`. */
  readonly recordBytes: number;
  /** Headers read before offset filtering, counted against `maxHeaders`. */
  readonly headers: number;
}
/** Fully admitted local record policy; validation performs no allocation or I/O. */
export interface LimitsType {
  /** Resolved `KafkaRecordLimitsType.maxBytes`. */
  readonly maxBytes: number;
  /** Resolved `KafkaRecordLimitsType.maxRecords`. */
  readonly maxRecords: number;
  /** Resolved `KafkaRecordLimitsType.maxHeaders`. */
  readonly maxHeaders: number;
  /** Resolved `KafkaRecordLimitsType.maxRecordHeaders`. */
  readonly maxRecordHeaders: number;
}
/** Invalid binary structure and unsupported profiles use fixed messages, never record content. */
function require(value: boolean, message: string): asserts value {
  if (!value) throw new Error(message);
}
/** Admits caller ceilings independently of whether an append contains records. */
export function recordLimits(options: KafkaRecordLimitsType = {}): LimitsType {
  return {
    maxBytes: resolveLimit(options.maxBytes, 1024 * 1024, 1024 * 1024, "Kafka record policy", 1),
    maxRecords: resolveLimit(options.maxRecords, 1024, 1024, "Kafka record policy", 1),
    maxHeaders: resolveLimit(options.maxHeaders, 1024, 1024, "Kafka record policy", 0),
    maxRecordHeaders: resolveLimit(options.maxRecordHeaders, 64, 64, "Kafka record policy", 0),
  };
}
/** Bounded lossless UTF8 encoding; character admission happens before allocation. */
function nameBytes(name: string, maximum: number): Uint8Array<ArrayBuffer> {
  require(typeof name === "string" && name.length <= maximum, "Kafka header name exceeds record policy.");
  const bytes = new TextEncoder().encode(name);
  require(bytes.byteLength <= maximum, "Kafka header name exceeds record policy.");
  require(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) === name,
    "Kafka header name is not lossless UTF8.",
  );
  return bytes;
}
/**
 * Copies caller arrays and all nested payloads synchronously, before transport
 * acquisition can yield. Payload/name admission precedes each copy. Encoding
 * later includes framing overhead in maxBytes and can therefore still refuse a
 * snapshot exactly at the payload ceiling. The returned private copy has one owner.
 */
export function snapshotRecords(
  inputs: readonly KafkaRecordType[],
  options: KafkaRecordLimitsType = {},
): readonly KafkaRecordType[] {
  const policy = recordLimits(options);
  require(
    Array.isArray(inputs) && inputs.length > 0 && inputs.length <= policy.maxRecords,
    "Kafka append record count exceeds record policy.",
  );
  const count = inputs.length, output: KafkaRecordType[] = [];
  let bytes = 0, headers = 0;
  function copy(value: Uint8Array | null): Uint8Array<ArrayBuffer> | null {
    if (value === null) return null;
    require(isBytes(value), "Kafka record field must be nullable bytes.");
    const view = toView(value);
    require(view.byteLength <= policy.maxBytes - bytes, "Kafka records exceed byte policy.");
    bytes += view.byteLength;
    return new Uint8Array(view);
  }
  for (let index = 0; index < count; index++) {
    const input = inputs[index]!;
    const timestamp = long(input.timestamp);
    require(timestamp >= 0n, "Kafka CreateTime must be nonnegative.");
    const key = copy(input.key), value = copy(input.value), originalHeaders = input.headers;
    require(
      Array.isArray(originalHeaders) && originalHeaders.length <= policy.maxRecordHeaders,
      "Kafka record headers exceed per-record policy.",
    );
    const headerCount = originalHeaders.length;
    require(headerCount <= policy.maxHeaders - headers, "Kafka records exceed aggregate header policy.");
    headers += headerCount;
    const copied: KafkaHeaderType[] = [];
    for (let at = 0; at < headerCount; at++) {
      const header = originalHeaders[at]!, name = header.name;
      const encoded = nameBytes(name, policy.maxBytes - bytes);
      bytes += encoded.byteLength;
      copied.push({ name, value: copy(header.value) });
    }
    output.push({ timestamp, key, value, headers: copied });
  }
  return output;
}

/**
 * Reflected Castagnoli bit recurrence, initial/final XOR 0xffffffff. A bounded
 * reference loop avoids mutable global tables and import-time setup. CRC detects
 * accidental corruption; it provides no peer authentication or schema validation.
 */
export function crc32c(bytes: Uint8Array): number {
  require(isBytes(bytes), "Kafka CRC input must be bytes.");
  const view = toView(bytes);
  require(view.byteLength <= MAX_FRAME, "Kafka CRC input exceeds the frame ceiling.");
  let register = 0xffffffff;
  for (const byte of view) {
    register ^= byte;
    for (let bit = 0; bit < 8; bit++) register = (register >>> 1) ^ ((register & 1) ? 0x82f63b78 : 0);
  }
  return (register ^ 0xffffffff) >>> 0;
}
/** Nullable record bytes use zigzag int32 lengths, unlike classic request bytes. */
function field(writer: Writer, bytes: Uint8Array | null): void {
  if (bytes === null) writer.varint(-1);
  else writer.varint(bytes.byteLength).raw(bytes);
}
/**
 * Writes one nonempty uncompressed CreateTime batch. Inputs are copied before
 * serialization; this function performs no I/O or clock reads. Offsets start at
 * zero for broker assignment, and producer/epoch/sequence IDs are all -1, so a
 * retry can duplicate records. The CRC covers attributes through the last record.
 */
export function encodeBatch(
  inputs: readonly KafkaRecordType[],
  options: KafkaRecordLimitsType = {},
): Uint8Array<ArrayBuffer> {
  const policy = recordLimits(options), records = snapshotRecords(inputs, options);
  const baseTimestamp = records[0]!.timestamp;
  let maxTimestamp = baseTimestamp;
  const encoded = new Writer(policy.maxBytes);
  for (const [index, record] of records.entries()) {
    if (record.timestamp > maxTimestamp) maxTimestamp = record.timestamp;
    const body = new Writer(policy.maxBytes).byte(0).varlong(long(record.timestamp - baseTimestamp)).varint(index);
    field(body, record.key);
    field(body, record.value);
    body.varint(record.headers.length);
    for (const header of record.headers) {
      const name = nameBytes(header.name, policy.maxBytes);
      body.varint(name.byteLength).raw(name);
      field(body, header.value);
    }
    const bytes = body.finish();
    encoded.varint(bytes.byteLength).raw(bytes);
  }
  const crcBody = new Writer().short(0).int(records.length - 1).long(baseTimestamp).long(maxTimestamp)
    .long(-1n).short(-1).int(-1).int(records.length).raw(encoded.finish()).finish();
  const tail = new Writer().int(-1).byte(2).uint(crc32c(crcBody)).raw(crcBody).finish();
  return new Writer().long(0n).int(tail.byteLength).raw(tail).finish();
}

/** Nullable field admission happens before copying, preserving null versus empty. */
function readField(reader: Reader): Uint8Array<ArrayBuffer> | null {
  const size = reader.varint();
  if (size === -1) return null;
  require(size >= 0, "Kafka record has an invalid nullable field length.");
  return reader.copy(size);
}
/**
 * Validates every batch, CRC and record before returning any page or cursor.
 * Wire quotas include records older than requestedOffset. Compaction gaps and
 * zero-record batches retain their native last-offset boundary; neither record
 * count nor high watermark supplies a cursor. Any incomplete tail refuses the
 * whole page as outside this profile. Returned payload bytes are separately owned.
 */
export function decodeRecords(
  bytes: Uint8Array,
  requestedOffset: bigint,
  options: KafkaRecordLimitsType = {},
): KafkaRecordsType {
  long(requestedOffset);
  require(requestedOffset >= 0n, "Kafka requested offset must be nonnegative.");
  const policy = recordLimits(options), page = new Reader(bytes);
  require(page.remaining <= MAX_FRAME, "Kafka record page exceeds the frame ceiling.");
  const records: KafkaFetchedRecordType[] = [], batches: KafkaBatchType[] = [];
  let wireRecords = 0, recordBytes = 0, headers = 0, nextOffset = requestedOffset;
  let previousLast = -1n;
  while (page.remaining > 0) {
    require(page.remaining >= 12, "Incomplete Kafka batch tail is outside this page profile.");
    require(batches.length < 1024, "Kafka page exceeds the batch count ceiling.");
    const baseOffset = page.long(), size = page.int();
    require(size >= 49 && size <= page.remaining, "Incomplete or unsupported Kafka batch extent.");
    require(baseOffset >= 0n && baseOffset > previousLast, "Kafka batch offset boundaries overlap or regress.");
    const batch = new Reader(page.take(size));
    const leaderEpoch = batch.int(), magic = batch.byte(), checksum = batch.uint();
    require(leaderEpoch >= -1, "Kafka partition leader epoch is invalid.");
    require(magic === 2, "Kafka batch magic is outside the supported profile.");
    const crcBody = batch.take(batch.remaining);
    require(crc32c(crcBody) === checksum, "Kafka record batch CRC32C differs.");
    batch.done();
    const body = new Reader(crcBody), attributes = body.short();
    require(attributes === 0, "Kafka batch attributes are outside the uncompressed CreateTime profile.");
    const lastDelta = body.int(), baseTimestamp = body.long(), maxTimestamp = body.long();
    require(lastDelta >= 0, "Kafka batch last offset delta is negative.");
    const lastOffset = long(baseOffset + BigInt(lastDelta));
    require(lastOffset < MAX_LONG, "Kafka batch successor exceeds signed int64.");
    const successor = lastOffset + 1n;
    const producerId = body.long(), producerEpoch = body.short(), sequence = body.int(), count = body.int();
    require(
      producerId === -1n && producerEpoch === -1 && sequence === -1,
      "Kafka idempotent producer state is outside this record profile.",
    );
    require(
      count >= 0 && count <= policy.maxRecords - wireRecords && count <= Math.floor(body.remaining / 7),
      "Kafka wire record count exceeds page policy or extent.",
    );
    if (count === 0) {
      require(baseTimestamp >= -1n && maxTimestamp >= -1n, "Kafka empty batch timestamp is invalid.");
      require(baseTimestamp === -1n || maxTimestamp >= baseTimestamp, "Kafka empty batch timestamp bounds regress.");
    } else {
      require(baseTimestamp >= 0n && maxTimestamp >= baseTimestamp, "Kafka CreateTime batch timestamps are invalid.");
    }
    wireRecords += count;
    let previousDelta = -1;
    for (let index = 0; index < count; index++) {
      const before = body.remaining, length = body.varint();
      require(length >= 6 && length <= body.remaining, "Kafka record extent is invalid.");
      const envelope = before - body.remaining + length;
      require(envelope <= policy.maxBytes - recordBytes, "Kafka wire records exceed page byte policy.");
      recordBytes += envelope;
      const record = new Reader(body.take(length));
      require(record.byte() === 0, "Kafka record attributes are outside the supported profile.");
      const timestamp = long(baseTimestamp + record.varlong()), delta = record.varint();
      require(timestamp >= 0n && timestamp <= maxTimestamp, "Kafka record timestamp is outside its batch bounds.");
      require(
        delta >= 0 && delta > previousDelta && delta <= lastDelta,
        "Kafka record offsets are outside increasing batch bounds.",
      );
      previousDelta = delta;
      const key = readField(record), value = readField(record), headerCount = record.varint();
      require(
        headerCount >= 0 && headerCount <= policy.maxRecordHeaders && headerCount <= policy.maxHeaders - headers &&
          headerCount <= Math.floor(record.remaining / 2),
        "Kafka record headers exceed policy or extent.",
      );
      headers += headerCount;
      const decoded: KafkaHeaderType[] = [];
      for (let at = 0; at < headerCount; at++) {
        const nameLength = record.varint();
        require(nameLength >= 0, "Kafka header name cannot be null.");
        const name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(record.take(nameLength));
        decoded.push({ name, value: readField(record) });
      }
      record.done();
      const offset = long(baseOffset + BigInt(delta));
      if (offset >= requestedOffset) records.push({ offset, timestamp, key, value, headers: decoded });
    }
    body.done();
    batches.push({
      baseOffset,
      lastOffset,
      nextOffset: successor,
      baseTimestamp,
      maxTimestamp,
      leaderEpoch,
      recordCount: count,
    });
    previousLast = lastOffset;
    if (successor > nextOffset) nextOffset = successor;
  }
  page.done();
  return { records, nextOffset, batches, wireRecords, recordBytes, headers };
}
