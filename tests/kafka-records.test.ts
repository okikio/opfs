/** Native frozen-wire proof and authored adversarial controls for pure Kafka record batches. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { crc32c, decodeRecords, encodeBatch, snapshotRecords } from "../src/kafka/records.ts";
import type { KafkaFetchedRecordType, KafkaRecordType } from "../src/kafka/records.ts";
import { frame, MAX_FRAME, MAX_LONG, MIN_LONG, Reader, unframe, Writer } from "../src/kafka/wire.ts";
import { crc32c as controlCrc } from "./fixtures/kafka/records.ts";
import { decode as javaTerminal } from "./fixtures/kafka/manifest.ts";

const TIME = 1700000000000n;
/** Exact retained artifacts. Loading these files executes neither their historical producers nor native programs. */
function frozen(name: string, sha256: string): Buffer<ArrayBuffer> {
  const path = fileURLToPath(new URL(`./fixtures/kafka/native-second/${name}`, import.meta.url).href);
  const info = lstatSync(path);
  expect(info.isFile()).toBe(true);
  expect(info.size).toBeLessThan(262144);
  const bytes = readFileSync(path);
  expect(bytes.length).toBe(info.size);
  expect(bytes.length).toBeLessThan(262144);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
  return bytes;
}
/** These two fixed-topic, hash-admitted Fetch4 envelopes place their record set after byte69. */
function nativePage(kind: "sdk" | "literal"): Buffer<ArrayBuffer> {
  const bytes = kind === "sdk"
    ? frozen("read/fetch-response.bin", "d79d756497f3ae3f62f8dcdce69afdafb8a8a727e40f67b405a9e1b5dc00e16a")
    : frozen("append/fetch-response.bin", "c70802ff45d705538d5a0668826468cf77f4405bcae43e93f5346bde9c5f286c");
  expect(bytes.readInt32BE(0)).toBe(bytes.length - 4);
  expect(bytes.readInt32BE(4)).toBe(3106);
  expect(bytes.readInt32BE(65)).toBe(bytes.length - 69);
  return bytes.subarray(69);
}
/** Restated authored originals; no candidate encoder or decoder supplies expected bytes. */
function originals(): KafkaRecordType[] {
  return [
    {
      timestamp: TIME,
      key: null,
      value: Uint8Array.from({ length: 131072 }, (_, index) => index % 256),
      headers: [{ name: "dup", value: Uint8Array.of(0, 255) }, { name: "dup", value: null }, {
        name: "dup",
        value: new Uint8Array(),
      }],
    },
    { timestamp: TIME + 1n, key: new Uint8Array(), value: null, headers: [] },
    {
      timestamp: TIME + 2n,
      key: Uint8Array.of(0, 255, 0),
      value: new Uint8Array(),
      headers: [{ name: "trace", value: Uint8Array.of(13, 10, 0, 128) }],
    },
  ];
}
/** Compare full payloads without a failed assertion formatting a 128KiB array into a huge diagnostic. */
function bytes(actual: Uint8Array | null, expected: Uint8Array | null): void {
  if (expected === null) expect(actual).toBeNull();
  else {
    expect(actual === null).toBe(false);
    if (actual === null) throw new Error("Expected nonnull payload.");
    expect(actual.byteLength).toBe(expected.byteLength);
    expect(Buffer.from(actual).equals(Buffer.from(expected)), "Complete binary payload differs.").toBe(true);
  }
}
function same(records: readonly KafkaFetchedRecordType[], shift: bigint): void {
  const expected = originals();
  expect(records.length).toBe(expected.length);
  for (const [index, original] of expected.entries()) {
    const actual = records[index]!;
    expect(actual.offset).toBe(shift + BigInt(index));
    expect(actual.timestamp).toBe(original.timestamp);
    bytes(actual.key, original.key);
    bytes(actual.value, original.value);
    expect(actual.headers.map((header) => header.name)).toEqual(original.headers.map((header) => header.name));
    for (const [at, header] of original.headers.entries()) bytes(actual.headers[at]!.value, header.value);
  }
}

/** A minimal authored null-key/null-value record; its one-byte zigzag length is six bytes of body. */
function nullRecord(delta = 0): Buffer<ArrayBuffer> {
  if (delta < 0 || delta > 63) throw new Error("Authored control delta exceeds its fixed encoding.");
  return Buffer.from([12, 0, 0, delta * 2, 1, 1, 0]);
}
/** Authored grammar controls only. This independent fixture CRC is not the successful-value oracle. */
function authored(options: {
  readonly base?: bigint;
  readonly last?: number;
  readonly records?: readonly Buffer<ArrayBuffer>[];
  readonly attributes?: number;
  readonly count?: number;
  readonly firstTime?: bigint;
  readonly maxTime?: bigint;
  readonly producer?: bigint;
} = {}): Buffer<ArrayBuffer> {
  const records = options.records ?? [nullRecord()], raw = Buffer.concat(records), body = Buffer.alloc(40 + raw.length);
  body.writeInt16BE(options.attributes ?? 0, 0);
  body.writeInt32BE(options.last ?? 0, 2);
  body.writeBigInt64BE(options.firstTime ?? 100n, 6);
  body.writeBigInt64BE(options.maxTime ?? 100n, 14);
  body.writeBigInt64BE(options.producer ?? -1n, 22);
  body.writeInt16BE(-1, 30);
  body.writeInt32BE(-1, 32);
  body.writeInt32BE(options.count ?? records.length, 36);
  raw.copy(body, 40);
  const header = Buffer.alloc(21);
  header.writeBigInt64BE(options.base ?? 0n, 0);
  header.writeInt32BE(body.length + 9, 8);
  header.writeInt32BE(-1, 12);
  header[16] = 2;
  header.writeUInt32BE(controlCrc(body), 17);
  return Buffer.concat([header, body]);
}

describe("Kafka native record evidence", () => {
  it("decodes every byte, timestamp, offset and ordered header in Java-produced batches", () => {
    const page = decodeRecords(nativePage("sdk"), 0n);
    same(page.records, 0n);
    expect(page.nextOffset).toBe(3n);
    expect(page.wireRecords).toBe(3);
    expect(page.headers).toBe(4);
    expect(page.batches.map((batch) => [batch.baseOffset, batch.lastOffset, batch.leaderEpoch])).toEqual([[0n, 0n, 0], [
      1n,
      1n,
      0,
    ], [2n, 2n, 0]]);
  });
  it("agrees with the literal batch independently consumed by Java and the retained JDK CRC32C value", () => {
    const literal = frozen(
      "append/produce-batch.bin",
      "e57663f3a2ee7fad59b09267bf6654968187f7ed06c34442f73b908b87c064d9",
    );
    const crcInput = frozen("crc-input.bin", "5b61cf7e58fa3ebeaf41acbd160a363e4894491c0621bb17dc674ea67d422d9a");
    expect(crc32c(crcInput)).toBe(0x0f033be4);
    expect(literal.readUInt32BE(17)).toBe(0x0f033be4);
    bytes(encodeBatch(originals()), literal);
    const page = decodeRecords(nativePage("literal"), 3n);
    same(page.records, 3n);
    expect(page.nextOffset).toBe(6n);
    const observed = javaTerminal(
      frozen("sdk-fetch.bin", "50ffdf44efb0c59b5f827db4679b10eff32921be4cf7e3a04011f8943a6ebb42"),
    );
    expect(observed.status).toBe(0);
    expect(observed.faults).toEqual([]);
    expect(observed.records.map((record) => record.timestampType)).toEqual([
      "CREATE_TIME",
      "CREATE_TIME",
      "CREATE_TIME",
    ]);
    same(observed.records, 3n);
  });
  it("owns returned payloads after the channel frame changes", () => {
    const wire = nativePage("literal"), page = decodeRecords(wire, 3n);
    wire.fill(0);
    same(page.records, 3n);
    expect(page.records[0]!.value!.buffer).not.toBe(wire.buffer);
    expect(page.records[0]!.headers[0]!.value!.buffer).not.toBe(wire.buffer);
  });
  it("enforces whole-page record, byte and header quotas before requested-offset filtering", () => {
    for (
      const limits of [{ maxRecords: 2 }, { maxBytes: 1 }, { maxHeaders: 3 }, { maxHeaders: 0 }, {
        maxRecordHeaders: 2,
      }]
    ) {
      expect(() => decodeRecords(nativePage("sdk"), 3n, limits)).toThrow();
    }
    const page = decodeRecords(nativePage("sdk"), 3n);
    expect(page.records).toEqual([]);
    expect(page.wireRecords).toBe(3);
    expect(page.headers).toBe(4);
    expect(page.nextOffset).toBe(3n);
  });
});

describe("Kafka authored record refusal and cursor controls", () => {
  it("checks CRC before accepting a corrupt payload, and refuses incomplete final batches as a whole page", () => {
    const bad = authored();
    bad[bad.length - 1] = 2;
    expect(() => decodeRecords(bad, 0n)).toThrow(/CRC32C/u);
    const good = authored();
    for (const tail of [Buffer.of(0), good.subarray(0, 11), good.subarray(0, good.length - 1)]) {
      expect(() => decodeRecords(tail, 0n)).toThrow();
      expect(() => decodeRecords(Buffer.concat([good, tail]), 0n)).toThrow();
    }
  });
  it("rejects malformed record extents and fields after an independent control CRC is supplied", () => {
    const controls = [
      Buffer.from([10, 0, 0, 0, 1, 1, 0]), // Declared body too short.
      Buffer.from([14, 0, 0, 0, 1, 1, 0]), // Declared body exceeds available bytes.
      Buffer.from([0x8c, 0, 0, 0, 0, 1, 1, 0]), // Nonminimal record length.
      Buffer.from([12, 1, 0, 0, 1, 1, 0]), // Unsupported record attributes.
      Buffer.from([12, 0, 0, 0, 3, 1, 0]), // Nullable key length -2.
      Buffer.from([18, 0, 0, 0, 1, 1, 2, 2, 255, 1]), // Invalid UTF8 header name.
    ];
    for (const record of controls) expect(() => decodeRecords(authored({ records: [record] }), 0n)).toThrow();
    expect(() => decodeRecords(authored({ count: 2 }), 0n)).toThrow();
    expect(() => decodeRecords(authored({ firstTime: 100n, maxTime: 99n }), 0n)).toThrow();
  });
  it("refuses compressed, transactional, control and unknown attributes and idempotent producer state", () => {
    for (const attributes of [1, 2, 3, 4, 8, 16, 32, 64, 256]) {
      expect(() => decodeRecords(authored({ attributes }), 0n)).toThrow(/attributes/u);
    }
    expect(() => decodeRecords(authored({ producer: 7n }), 0n)).toThrow(/producer/u);
    const legacy = authored();
    legacy[16] = 1;
    expect(() => decodeRecords(legacy, 0n)).toThrow(/magic/u);
  });
  it("uses native batch boundaries across compaction gaps and zero-record batches", () => {
    const gaps = authored({ base: 30n, last: 10, records: [nullRecord(2), nullRecord(7)] });
    const empty = authored({ base: 41n, last: 4, records: [], firstTime: -1n, maxTime: -1n });
    const page = decodeRecords(Buffer.concat([gaps, empty]), 0n);
    expect(page.records.map((record) => record.offset)).toEqual([32n, 37n]);
    expect(page.wireRecords).toBe(2);
    expect(page.nextOffset).toBe(46n);
    expect(page.batches.map((batch) => batch.nextOffset)).toEqual([41n, 46n]);
    expect(decodeRecords(Buffer.concat([gaps, empty]), 50n).nextOffset).toBe(50n);
    expect(decodeRecords(new Uint8Array(), 123n).nextOffset).toBe(123n);
    expect(() => decodeRecords(authored({ last: 3, records: [nullRecord(2), nullRecord(2)] }), 0n)).toThrow();
    expect(() => decodeRecords(Buffer.concat([gaps, authored({ base: 40n })]), 0n)).toThrow();
  });
  it("refuses signed-int64 successor overflow without rounding offsets", () => {
    expect(() => decodeRecords(authored({ base: MAX_LONG, records: [] }), 0n)).toThrow();
    expect(() => decodeRecords(authored({ base: MAX_LONG - 1n, last: 2, records: [] }), 0n)).toThrow();
    const near = decodeRecords(authored({ base: MAX_LONG - 1n, records: [] }), 0n);
    expect(near.nextOffset).toBe(MAX_LONG);
    expect(() => decodeRecords(new Uint8Array(), -1n)).toThrow();
    expect(() => decodeRecords(new Uint8Array(), MAX_LONG + 1n)).toThrow();
  });
  it("snapshots caller-owned nested data before asynchronous transport can acquire it", () => {
    const value = Uint8Array.of(7, 8), header = Uint8Array.of(9), headers = [{ name: "one", value: header }];
    const input: KafkaRecordType[] = [{ timestamp: TIME, key: value, value, headers }];
    const copied = snapshotRecords(input);
    value.fill(0);
    header.fill(0);
    headers.push({ name: "later", value: header });
    input.length = 0;
    bytes(copied[0]!.key, Uint8Array.of(7, 8));
    bytes(copied[0]!.value, Uint8Array.of(7, 8));
    expect(copied[0]!.key).not.toBe(copied[0]!.value);
    expect(copied[0]!.headers.length).toBe(1);
    bytes(copied[0]!.headers[0]!.value, Uint8Array.of(9));
    expect(() => snapshotRecords([{ timestamp: -1n, key: null, value: null, headers: [] }])).toThrow();
    expect(() =>
      snapshotRecords([{ timestamp: TIME, key: null, value: null, headers: [{ name: "\ud800", value: null }] }])
    ).toThrow();
    expect(() => encodeBatch(originals(), { maxBytes: 131072 })).toThrow();
    expect(() => encodeBatch([], { maxRecords: 0 })).toThrow();
  });
});

describe("Kafka wire scalars and ownership", () => {
  it("matches the known Castagnoli check value for 123456789", () => {
    expect(crc32c(new TextEncoder().encode("123456789"))).toBe(0xe3069283);
  });
  it("reads and writes authored minimal zigzag boundaries", () => {
    const ints = [[0, "00"], [-1, "01"], [1, "02"], [63, "7e"], [64, "8001"], [-64, "7f"], [-65, "8101"], [
      -2147483648,
      "ffffffff0f",
    ], [2147483647, "feffffff0f"]] as const;
    for (const [value, hex] of ints) {
      const reader = new Reader(Buffer.from(hex, "hex"));
      expect(reader.varint()).toBe(value);
      reader.done();
      bytes(new Writer().varint(value).finish(), Buffer.from(hex, "hex"));
    }
    for (
      const [value, hex] of [[MIN_LONG, "ffffffffffffffffff01"], [MAX_LONG, "feffffffffffffffff01"], [
        9007199254740993n,
        "8280808080808020",
      ]] as const
    ) {
      const reader = new Reader(Buffer.from(hex, "hex"));
      expect(reader.varlong()).toBe(value);
      reader.done();
      bytes(new Writer().varlong(value).finish(), Buffer.from(hex, "hex"));
    }
  });
  it("rejects nonminimal, truncated and overflowing zigzag encodings", () => {
    for (const hex of ["8000", "80", "ffffffff10", "8080808080"]) {
      expect(() => new Reader(Buffer.from(hex, "hex")).varint()).toThrow();
    }
    for (const hex of ["8000", "80", "ffffffffffffffffff02", "80808080808080808080"]) {
      expect(() => new Reader(Buffer.from(hex, "hex")).varlong()).toThrow();
    }
    expect(() => new Writer().varint(2147483648)).toThrow();
    expect(() => new Writer().varint(1.5)).toThrow();
    expect(() => new Writer().varlong(MAX_LONG + 1n)).toThrow();
  });
  it("checks exact frames, field extents, bounded array counts and literal BOM text", () => {
    bytes(frame(Uint8Array.of(170)), Uint8Array.of(0, 0, 0, 1, 170));
    bytes(unframe(Uint8Array.of(0, 0, 0, 1, 170)), Uint8Array.of(170));
    for (const hex of ["ffffffff", "00000002aa", "00000001aabb"]) {
      expect(() => unframe(Buffer.from(hex, "hex"))).toThrow();
    }
    expect(() => new Reader(new Uint8Array(MAX_FRAME + 5))).toThrow();
    expect(() => new Reader(Uint8Array.of(0)).short()).toThrow();
    expect(() => new Reader(Buffer.from("00000002aa", "hex")).arrayLength(1)).toThrow();
    expect(() => new Reader(Uint8Array.of(1)).done()).toThrow();
    const bom = Buffer.from("0004efbbbf78", "hex");
    expect(new Reader(bom).text()).toBe("\ufeffx");
    bytes(new Writer().text("\ufeffx").finish(), bom);
    expect(() => new Reader(Buffer.from("0001ff", "hex")).text()).toThrow();
    expect(() => new Writer().text("\ud800")).toThrow();
    expect(() => new Writer(1).short(0)).toThrow();
  });
  it("copies returned reads and finished writes instead of aliasing borrowed fields", () => {
    const input = Uint8Array.of(3, 4), reader = new Reader(input), copied = reader.copy(2);
    input.fill(0);
    bytes(copied, Uint8Array.of(3, 4));
    const borrowed = Uint8Array.of(5), writer = new Writer().raw(borrowed), finished = writer.finish();
    borrowed[0] = 6;
    bytes(finished, Uint8Array.of(5));
    // raw() explicitly borrows until finish; a later finish observes the caller's synchronous mutation.
    bytes(writer.finish(), Uint8Array.of(6));
  });
});
