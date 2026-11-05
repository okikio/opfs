import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { createArchiveLedger, openLas } from "../src/dataset/las.ts";
import type { LasReadType } from "../src/dataset/las.ts";
import type { ByteSourceType } from "../src/source.ts";
import fixture from "./fixtures/las/independent.json" with { type: "json" };

const source = (bytes: Uint8Array) => createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
const raw = (value: ArrayBufferView) => new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
function same(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) throw new Error(`LAS byte${i}: ${actual[i]} != ${expected[i]}`);
  }
}
function columns(result: LasReadType): Record<string, ArrayBufferView> {
  const count = result.X.length,
    synthetic = new Uint8Array(count),
    key_point = new Uint8Array(count),
    withheld = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    synthetic[i] = result.classificationFlags[i]! & 1;
    key_point[i] = (result.classificationFlags[i]! >>> 1) & 1;
    withheld[i] = result.classificationFlags[i]! >>> 2;
  }
  return {
    X: result.X,
    Y: result.Y,
    Z: result.Z,
    intensity: result.intensity,
    return_number: result.returnNumber,
    number_of_returns: result.returnCount,
    scan_direction_flag: result.scanDirection,
    edge_of_flight_line: result.edgeOfFlightLine,
    classification: result.classification,
    synthetic,
    key_point,
    withheld,
    scan_angle_rank: result.scanAngleRank,
    user_data: result.userData,
    point_source_id: result.sourceId,
    ...(result.gpsTime ? { gps_time: result.gpsTime } : {}),
    ...(result.red && result.green && result.blue ? { red: result.red, green: result.green, blue: result.blue } : {}),
    ...(result.physical ? { x: result.physical.x, y: result.physical.y, z: result.physical.z } : {}),
  };
}
/** Authored geometry controls remain separate from independent producer payloads. */
function control(): Uint8Array {
  const bytes = new Uint8Array(227 + 60), wire = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("LASF"));
  bytes[24] = 1;
  bytes[25] = 2;
  wire.setUint16(94, 227, true);
  wire.setUint32(96, 227, true);
  wire.setUint16(105, 20, true);
  wire.setUint32(107, 3, true);
  for (const at of [131, 139, 147]) wire.setFloat64(at, 1, true);
  for (const at of [179, 195, 211]) wire.setFloat64(at, 2, true);
  for (let i = 0; i < 3; i++) {
    wire.setInt32(227 + i * 20, i, true);
    wire.setInt32(227 + i * 20 + 4, -i, true);
    bytes[227 + i * 20 + 14] = 9;
    bytes[227 + i * 20 + 16] = 255;
  }
  return bytes;
}
describe("LAS1.2 bounded point preview", () => {
  it("matches all native laspy/reciprocal struct complete columns, physical coordinates and selected extents", async () => {
    expect(fixture.fixtures.length).toBe(32);
    expect(new Uint8Array(new Uint16Array([1]).buffer)[0]).toBe(1); // Native fixture oracle is little-endian.
    for (const item of fixture.fixtures) {
      const bytes = decodeBase64(item.file.base64), array = await openLas(source(bytes));
      const all = await array.read({ scale: "physical" }), actual = columns(all);
      for (const [key, original] of Object.entries(item.columns)) {
        same(raw(actual[key]!), decodeBase64(original.base64));
      }
      expect(array.format).toBe(item.format);
      expect(array.points).toBe(item.count);
      expect(all.integrity).toBe("not-provided");
      const start = Math.min(3, item.count),
        count = Math.min(7, item.count - start),
        part = await array.read({ offset: start, count, scale: "physical" });
      for (const [key, original] of Object.entries(item.columns)) {
        const complete = decodeBase64(original.base64), width = item.count ? complete.length / item.count : 0;
        same(raw(columns(part)[key]!), complete.subarray(start * width, (start + count) * width));
      }
      const records = decodeBase64(item.records.base64);
      same(records, bytes.subarray(array.pointOffset, array.pointOffset + array.points * array.recordBytes));
      same(
        decodeBase64(item.subset.base64),
        records.subarray(start * array.recordBytes, (start + count) * array.recordBytes),
      );
      expect(part.extra.length).toBe(count * array.extraBytesPerPoint);
      if (item.extra) {
        expect(array.headerExtension.size).toBeGreaterThan(0);
        expect(array.extraBytesPerPoint).toBe(1);
        same(all.extra, Uint8Array.from({ length: item.count }, (_, i) => i % 256));
      }
      for (let i = 0; i < all.scanAngleByte.length; i++) expect(all.scanAngleByte[i]).toBe(all.scanAngleRank[i]! & 255);
      expect(array.gpsTimeType).toBe(item.format % 2 ? "adjusted-standard" : "week");
    }
  });
  it("reads only selected physical records and VLR payload ranges, preserving opaque bytes", async () => {
    const item = fixture.fixtures.find((x) => x.format === 3 && x.extra && x.producer === "struct")!,
      bytes = decodeBase64(item.file.base64),
      reads: [number, number][] = [];
    const array = await openLas({
      size: bytes.length,
      stability: "caller",
      async read(at, n) {
        reads.push([at, n]);
        return bytes.slice(at, at + n);
      },
    });
    reads.length = 0;
    await array.read({ offset: 3, count: 7 });
    expect(reads).toEqual([[array.pointOffset + 3 * array.recordBytes, 7 * array.recordBytes]]);
    const vlr = array.vlrs.find((x) => x.userId === "OPFS_test")!;
    reads.length = 0;
    const selected = await array.readVlr(vlr.id, { offset: 4, length: 7 });
    same(selected.bytes, Uint8Array.of(4, 5, 6, 7, 8, 9, 10));
    expect(reads).toEqual([[vlr.offset + 4, 7]]);
    reads.length = 0;
    expect((await array.read({ count: 0 })).X.length).toBe(0);
    expect((await array.readVlr(vlr.id, { length: 0 })).bytes.length).toBe(0);
    expect(reads).toEqual([]);
    expect(array.georeferencing).toBe("none");
    const scratch = new Uint8Array(65536);
    const reused = await openLas({
      size: bytes.length,
      stability: "caller",
      async read(at, n) {
        scratch.fill(0);
        scratch.set(bytes.subarray(at, at + n));
        return scratch.subarray(0, n);
      },
    });
    expect(reused.pointsByReturn).toEqual(
      [111, 115, 119, 123, 127].map((at) => new DataView(bytes.buffer).getUint32(at, true)),
    );
  });
  it("refuses unsupported versions, compression, truncated geometry, reserved global bits and nonfinite declarations", async () => {
    const mutations: ((bytes: Uint8Array, view: DataView) => void)[] = [
      (b) => {
        b[0] = 0;
      },
      (b) => {
        b[25] = 4;
      },
      (b) => {
        b[104] = 128;
      },
      (b) => {
        b[104] = 4;
      },
      (_, v) => v.setUint16(6, 2, true),
      (_, v) => v.setUint16(94, 226, true),
      (_, v) => v.setUint32(96, 226, true),
      (_, v) => v.setUint16(105, 19, true),
      (_, v) => v.setUint32(107, 4, true),
      (_, v) => v.setFloat64(131, Infinity, true),
      (_, v) => v.setFloat64(179, NaN, true),
      (_, v) => v.setUint32(100, 1, true),
    ];
    for (const mutate of mutations) {
      const bytes = control();
      mutate(bytes, new DataView(bytes.buffer));
      await expect(openLas(source(bytes))).rejects.toThrow();
    }
    await expect(openLas(source(control().subarray(0, 226)))).rejects.toThrow();
    const bytes = control();
    new DataView(bytes.buffer).setUint32(96, 0xffffffff, true);
    await expect(openLas(source(bytes))).rejects.toThrow();
    const malformed: ByteSourceType = {
      size: 227,
      stability: "immutable",
      async read() {
        return new Uint8Array(226);
      },
    };
    await expect(openLas(malformed)).rejects.toThrow();
  });
  it("preadmits selected source/request/decoded/output costs and retains opening/additional ledger authority", async () => {
    const bytes = control();
    let reads = 0;
    const input: ByteSourceType = {
      size: bytes.length,
      stability: "immutable",
      async read(at, n) {
        reads++;
        return bytes.slice(at, at + n);
      },
    };
    const ledger = createArchiveLedger(), array = await openLas(input, { ledger });
    reads = 0;
    const result = await array.read({ count: 1, ledger });
    expect(ledger.inspect().sourceBytes).toBe(247);
    expect(ledger.inspect().outputBytes).toBe(26);
    expect(result.work.sourceBytes).toBe(20);
    for (const opts of [{ maxSourceBytes: 0 }, { maxRequests: 0 }, { maxDecodedBytes: 0 }, { maxOutputBytes: 0 }]) {
      reads = 0;
      await expect(array.read({ count: 1, ...opts })).rejects.toThrow();
      expect(reads).toBe(0);
    }
    const blocked = await openLas(input, { ledger: createArchiveLedger({ maxSourceBytes: 227 }) });
    reads = 0;
    await expect(blocked.read({ count: 1 })).rejects.toThrow();
    expect(reads).toBe(0);
    const blockedRequests = await openLas(input, { ledger: createArchiveLedger({ maxRequests: 1 }) });
    reads = 0;
    await expect(blockedRequests.read({ count: 1 })).rejects.toThrow();
    expect(reads).toBe(0);
    await expect(array.read({ count: 1, ledger: createArchiveLedger({ maxOutputBytes: 0 }) })).rejects.toThrow();
    await expect((await openLas(input, { maxPoints: 1 })).read({ count: 2 })).rejects.toThrow();
    await expect(openLas(input, { maxMetadataBytes: 226 })).rejects.toThrow();
    const item = fixture.fixtures.find((x) => x.extra && x.count === 37)!;
    await expect(openLas(source(decodeBase64(item.file.base64)), { maxVlrs: 0 })).rejects.toThrow();
  });
  it("captures source/options, composes abort including zero selections and preserves original provider errors", async () => {
    const bytes = control(),
      reason = new Error("abort"),
      parent = new AbortController(),
      input: ByteSourceType = {
        size: bytes.length,
        stability: "caller",
        async read(at, n) {
          return bytes.slice(at, at + n);
        },
      };
    const opts = { maxPoints: 1, signal: parent.signal }, pending = openLas(input, opts);
    opts.maxPoints = 999;
    input.read = async () => {
      throw new Error("mutated method");
    };
    const array = await pending;
    await expect(array.read({ count: 2 })).rejects.toThrow();
    expect((await array.read({ count: 1 })).X[0]).toBe(0);
    parent.abort(reason);
    await expect(array.read({ count: 0 })).rejects.toBe(reason);
    const provider = new Error("original provider");
    await expect(openLas({
      size: 227,
      stability: "caller",
      async read() {
        throw provider;
      },
    })).rejects.toBe(provider);
    const controller = new AbortController(),
      stable = await openLas({
        size: bytes.length,
        stability: "immutable",
        async read(at, n) {
          if (at >= 227) controller.abort(reason);
          return bytes.slice(at, at + n);
        },
      }, { signal: controller.signal });
    await expect(stable.read({ count: 1 })).rejects.toBe(reason);
    await expect(openLas({ ...source(bytes), stability: "foo" as "caller" })).rejects.toThrow();
    await expect(openLas({ ...source(bytes), identity: "x".repeat(8193) })).rejects.toThrow();
  });
  it("preserves raw scan bytes and exposes physical IEEE overflow without inventing validity", async () => {
    const bytes = control();
    new DataView(bytes.buffer).setFloat64(131, Number.MAX_VALUE, true);
    const array = await openLas(source(bytes)), result = await array.read({ scale: "physical" });
    expect(result.scanAngleByte[0]).toBe(255);
    expect(result.scanAngleRank[0]).toBe(-1);
    expect(result.physical?.x[2]).toBe(Infinity);
    await expect(array.read({ offset: 4, count: 0 })).rejects.toThrow();
    await expect(array.read({ offset: -1, count: 1 })).rejects.toThrow();
    await expect(array.read({ offset: 0, count: 1.5 })).rejects.toThrow();
  });
});
