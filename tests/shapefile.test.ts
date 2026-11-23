import fixture from "./fixtures/shapefile/independent.json" with { type: "json" };
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { runInNewContext } from "node:vm";
import { createByteSource } from "../src/source.ts";
import type { ByteSourceType } from "../src/source.ts";
import { createArchiveLedger, openShapefile } from "../src/dataset/shapefile.ts";
import type { ShapefileOpenOptionsType } from "../src/dataset/shapefile.ts";
const encoder = new TextEncoder();
function join(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}
const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, true);
  return b;
};
function doubles(numbers: readonly number[]): Uint8Array {
  const b = new Uint8Array(numbers.length * 8), v = new DataView(b.buffer);
  for (let i = 0; i < numbers.length; i++) v.setFloat64(i * 8, numbers[i]!, true);
  return b;
}
const point = (x: number, y: number) => join(u32(1), doubles([x, y]));
const nullShape = () => u32(0);
function extent(xy: readonly number[]): number[] {
  const x = xy.filter((_, i) => i % 2 === 0), y = xy.filter((_, i) => i % 2 === 1);
  return [Math.min(...x), Math.min(...y), Math.max(...x), Math.max(...y)];
}
function geometry(type: 3 | 5 | 8, xy: readonly number[], parts: readonly number[] = []): Uint8Array {
  return join(
    u32(type),
    doubles(extent(xy)),
    ...(type === 8 ? [] : [u32(parts.length)]),
    u32(xy.length / 2),
    ...(type === 8 ? [] : parts.map(u32)),
    doubles(xy),
  );
}
function header(type: number, length: number, bounds: readonly number[]): Uint8Array {
  const b = new Uint8Array(100), v = new DataView(b.buffer);
  v.setInt32(0, 9994, false);
  v.setInt32(24, length / 2, false);
  v.setInt32(28, 1000, true);
  v.setInt32(32, type, true);
  b.set(doubles(bounds), 36);
  return b;
}
function components(type = 1, bodies: Uint8Array[] = [point(-0, 3.25), point(-4, -2), nullShape()]) {
  const bounds = [-10, -10, 10, 10], records: Uint8Array[] = [], index: Uint8Array[] = [];
  let at = 100;
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i]!, r = new Uint8Array(8), ix = new Uint8Array(8);
    new DataView(r.buffer).setInt32(0, i + 1, false);
    new DataView(r.buffer).setInt32(4, body.length / 2, false);
    new DataView(ix.buffer).setInt32(0, at / 2, false);
    new DataView(ix.buffer).setInt32(4, body.length / 2, false);
    records.push(r, body);
    index.push(ix);
    at += 8 + body.length;
  }
  const shp = join(header(type, at, bounds), ...records),
    shx = join(header(type, 100 + 8 * bodies.length, bounds), ...index);
  const dbf = new Uint8Array(97 + bodies.length * 33), v = new DataView(dbf.buffer);
  dbf[0] = 3;
  dbf[1] = 126;
  dbf[2] = 11;
  dbf[3] = 5;
  v.setUint32(4, bodies.length, true);
  v.setUint16(8, 97, true);
  v.setUint16(10, 33, true);
  dbf.set(encoder.encode("label"), 32);
  dbf[43] = 67;
  dbf[48] = 8;
  dbf.set(encoder.encode("exact"), 64);
  dbf[75] = 78;
  dbf[80] = 24;
  dbf[96] = 13;
  for (let i = 0; i < bodies.length; i++) {
    const at = 97 + i * 33;
    dbf.fill(32, at, at + 33);
    dbf.set(encoder.encode(`row${i}`), at + 1);
    dbf.set(encoder.encode("9007199254740993".padStart(24, " ")), at + 9);
  }
  return { shp, shx, dbf };
}
const options: ShapefileOpenOptionsType = { profile: "shp2d-dbf3" };
function sources(bytes = components()) {
  return {
    shp: createByteSource(bytes.shp, { identity: "authored-main" }),
    shx: createByteSource(bytes.shx, { identity: "authored-index" }),
    dbf: createByteSource(bytes.dbf, { identity: "authored-attributes" }),
  };
}
const open = (bytes = components(), extra: Partial<ShapefileOpenOptionsType> = {}) =>
  openShapefile(sources(bytes), { ...options, ...extra });

describe("Shapefile2D supplied component view", () => {
  it("retains every physical ordinal, exact coordinates and raw high-precision attribute bytes", async () => {
    const dataset = await open();
    expect(dataset.scope).toBe("geometry-and-raw-attributes");
    expect(dataset.index).toBe("cross-checked");
    expect(dataset.featureCount).toBe(3);
    expect(dataset.features().features.map((f) => [f.id, f.recordNumber, f.kind])).toEqual([[0, 1, "point"], [
      1,
      2,
      "point",
    ], [2, 3, "null"]]);
    const geometry = await dataset.read(0);
    expect(Array.from(geometry.xy)).toEqual([-0, 3.25]);
    expect(Object.is(geometry.xy[0], -0)).toBe(true);
    expect(geometry.integrity).toBe("not-provided");
    const row = await dataset.attributes(0);
    expect(row!.deleted).toBe(false);
    expect(new TextDecoder().decode(row!.fields[1]!.bytes)).toBe("9007199254740993".padStart(24, " "));
    row!.bytes.fill(0);
    expect((await dataset.attributes(0))!.bytes[0]).toBe(32);
    expect((await dataset.read(2)).xy.length).toBe(0);
  });
  it("keeps absent optional components explicit instead of fabricating a complete component set", async () => {
    const bytes = components(), dataset = await openShapefile({ shp: createByteSource(bytes.shp) }, options);
    expect(dataset.scope).toBe("geometry");
    expect(dataset.index).toBe("absent");
    expect(dataset.fields).toEqual([]);
    expect(await dataset.attributes(0)).toBeUndefined();
  });
  it("decodes complete multipart lines and preserves polygon ring order without topology conversion", async () => {
    const xy = [0, 0, 2, 2, 3, -1, 4, 0, 5, 1], line = await open(components(3, [geometry(3, xy, [0, 2])]));
    expect(Array.from((await line.read(0)).xy)).toEqual(xy);
    expect(Array.from((await line.read(0)).parts)).toEqual([0, 2]);
    const rings = [0, 0, 0, 10, 10, 10, 10, 0, 0, 0, 2, 2, 8, 2, 8, 8, 2, 8, 2, 2],
      polygon = await open(components(5, [geometry(5, rings, [0, 5])]));
    expect(Array.from((await polygon.read(0)).xy)).toEqual(rings);
    expect(Array.from((await polygon.read(0)).parts)).toEqual([0, 5]);
    const multi = await open(components(8, [geometry(8, [-1, 3, 5, -2])]));
    expect(Array.from((await multi.read(0)).xy)).toEqual([-1, 3, 5, -2]);
    expect((await multi.read(0)).parts.length).toBe(0);
  });
  it("does not compact deleted rows or shift a later feature association", async () => {
    const bytes = components();
    bytes.dbf[97 + 33] = 42;
    const dataset = await open(bytes);
    expect((await dataset.attributes(1))!.deleted).toBe(true);
    expect(new TextDecoder().decode((await dataset.attributes(2))!.fields[0]!.bytes)).toBe("row2    ");
    expect(dataset.features().features[2]!.recordNumber).toBe(3);
  });
  it("cross-checks every supplied SHX offset and length against authoritative physical SHP records", async () => {
    const wrong = components();
    new DataView(wrong.shx.buffer).setInt32(100, 51, false);
    await expect(open(wrong)).rejects.toThrow("index tuple");
    const missing = components();
    new DataView(missing.shx.buffer).setInt32(24, (missing.shx.length - 8) / 2, false);
    missing.shx = missing.shx.slice(0, -8);
    await expect(open(missing)).rejects.toThrow("entry count");
    const headerMismatch = components();
    new DataView(headerMismatch.shx.buffer).setFloat64(36, -20, true);
    await expect(open(headerMismatch)).rejects.toThrow("header differs");
  });
  it("requires DBF physical count and fixed field widths to match without parsing field values", async () => {
    const count = components();
    new DataView(count.dbf.buffer).setUint32(4, 2, true);
    await expect(open(count)).rejects.toThrow("row count");
    const width = components();
    width.dbf[48] = 7;
    await expect(open(width)).rejects.toThrow("widths");
    const version = components();
    version.dbf[0] = 0x83;
    await expect(open(version)).rejects.toThrow("version");
    const duplicate = components();
    duplicate.dbf.fill(0, 64, 75);
    duplicate.dbf.set(encoder.encode("label"), 64);
    await expect(open(duplicate)).rejects.toThrow("Duplicate");
  });
  it("checks the selected deletion flag while retaining opaque blank/numeric field representations", async () => {
    const bytes = components();
    bytes.dbf[97] = 0;
    const dataset = await open(bytes);
    await expect(dataset.attributes(0)).rejects.toThrow("deletion flag");
    const blank = components();
    blank.dbf.fill(32, 97 + 9, 97 + 33);
    const row = await (await open(blank)).attributes(0);
    expect(row!.fields[1]!.bytes.every((v) => v === 32)).toBe(true);
  });
  it("bounds filtered scans independently of page results and preserves an empty continuing page", async () => {
    const dataset = await open(), page = dataset.features({ kind: "null", limit: 1, maxScanned: 2 });
    expect(page).toEqual({ features: [], scanned: 2, cursor: 2 });
    expect(dataset.features({ cursor: page.cursor!, kind: "null" }).features[0]!.id).toBe(2);
    expect(() => dataset.features({ limit: 0 })).toThrow();
  });
  it("refuses unsupported dimensional profiles and inconsistent record type/ordinal/extents", async () => {
    const unsupported = components();
    new DataView(unsupported.shp.buffer).setInt32(32, 11, true);
    await expect(open(unsupported)).rejects.toThrow("2D");
    const recordType = components();
    new DataView(recordType.shp.buffer).setInt32(108, 8, true);
    await expect(open(recordType)).rejects.toThrow("differs");
    const ordinal = components();
    new DataView(ordinal.shp.buffer).setInt32(100, 2, false);
    await expect(open(ordinal)).rejects.toThrow("record numbers");
    const length = components();
    new DataView(length.shp.buffer).setInt32(104, 0x7fffffff, false);
    await expect(open(length)).rejects.toThrow("extent");
  });
  it("rejects nonfinite coordinates and count/body mismatch before unsafe allocation", async () => {
    const bytes = components();
    new DataView(bytes.shp.buffer).setFloat64(112, NaN, true);
    await expect(open(bytes)).rejects.toThrow("finite");
    const count = components(8, [geometry(8, [1, 2])]);
    new DataView(count.shp.buffer).setInt32(108 + 36, 0x7fffffff, true);
    await expect(open(count)).rejects.toThrow("extent mismatch");
  });
  it("validates complete selected part starts, ring closure and declared feature bounds", async () => {
    const line = components(3, [geometry(3, [0, 0, 1, 1, 2, 2], [0, 1])]);
    const bad = await open(line);
    await expect(bad.read(0)).rejects.toThrow("too few");
    const parts = components(3, [geometry(3, [0, 0, 1, 1, 2, 2, 3, 3], [0, 2])]);
    new DataView(parts.shp.buffer).setInt32(108 + 44 + 4, 0, true);
    await expect((await open(parts)).read(0)).rejects.toThrow("part starts");
    const polygon = components(5, [geometry(5, [0, 0, 1, 1, 2, 0, 3, 0], [0])]);
    await expect((await open(polygon)).read(0)).rejects.toThrow("not closed");
    const bounds = components(8, [geometry(8, [1, 2, 3, 4])]);
    new DataView(bounds.shp.buffer).setFloat64(108 + 4, 0, true);
    await expect((await open(bounds)).read(0)).rejects.toThrow("bounds do not match");
  });
  it("preserves raw source provenance while leaving whole geometry validation explicit", async () => {
    const dataset = await open(), raw = dataset.source(0);
    expect(raw.stability).toBe("immutable");
    expect(JSON.parse(raw.identity!).slice(0, 3)).toEqual(["shapefile", "authored-main", "geometry-record"]);
    expect(await raw.read(0, 4)).toEqual(u32(1));
    await expect(raw.read(raw.size, 1)).rejects.toThrow(RangeError);
  });
  it("refuses exhausted opening and selected decoded/output limits before provider callbacks", async () => {
    let calls = 0;
    const bytes = components(),
      source: ByteSourceType = {
        size: bytes.shp.length,
        stability: "caller",
        async read(o, n) {
          calls++;
          return bytes.shp.slice(o, o + n);
        },
      };
    await expect(openShapefile({ shp: source }, { ...options, maxDecodedBytes: 0 })).rejects.toThrow("decodedBytes");
    expect(calls).toBe(0);
    const dataset = await openShapefile({ shp: source }, options), before = calls;
    await expect(dataset.read(0, { maxOutputBytes: 0 })).rejects.toThrow("outputBytes");
    expect(calls).toBe(before);
    await expect(dataset.read(0, { maxDecodedBytes: 0 })).rejects.toThrow("decodedBytes");
    expect(calls).toBe(before);
    await expect(open(components(), { maxMetadataBytes: 0 })).rejects.toThrow("metadata");
  });
  it("keeps the opening lifetime ledger authoritative and deduplicates it on children", async () => {
    const ledger = createArchiveLedger({ maxSourceBytes: 1 << 20 }), dataset = await open(components(), { ledger });
    const before = ledger.inspect().sourceBytes;
    await dataset.read(0, { ledger });
    expect(ledger.inspect().sourceBytes - before).toBe(20);
    ledger.reserve("sourceBytes", (1 << 20) - ledger.inspect().sourceBytes);
    await expect(dataset.read(0)).rejects.toThrow("sourceBytes");
  });
  it("observes abort from the final foreign request reservation before any source callback, including derived sources", async () => {
    let calls = 0;
    const bytes = components(),
      why = new Error("foreign reservation aborted"),
      controller = new AbortController(),
      ledger = {
        reserve(key: string) {
          if (key === "requests") controller.abort(why);
        },
        inspect() {
          return { sourceBytes: 0, requests: 0, decodedBytes: 0, outputBytes: 0 };
        },
      },
      source: ByteSourceType = {
        size: bytes.shp.length,
        stability: "caller",
        async read(o, n) {
          calls++;
          return bytes.shp.slice(o, o + n);
        },
      };
    await expect(openShapefile({ shp: source }, { ...options, signal: controller.signal, ledger })).rejects.toBe(why);
    expect(calls).toBe(0);
    const dataset = await openShapefile({ shp: source }, options),
      child = new AbortController(),
      raw = dataset.source(0, {
        signal: child.signal,
        ledger: {
          ...ledger,
          reserve(key) {
            if (key === "requests") child.abort(why);
          },
        },
      }),
      before = calls;
    await expect(raw.read(0, 1, { signal: new AbortController().signal })).rejects.toBe(why);
    expect(calls).toBe(before);
  });
  it("preserves opening/view abort authority when a fresh child signal is supplied", async () => {
    const controller = new AbortController(),
      dataset = await open(components(), { signal: controller.signal }),
      raw = dataset.source(0),
      why = new Error("opening aborted");
    controller.abort(why);
    await expect(dataset.read(0, { signal: new AbortController().signal })).rejects.toBe(why);
    await expect(dataset.attributes(0, { signal: new AbortController().signal })).rejects.toBe(why);
    await expect(raw.read(0, 1, { signal: new AbortController().signal })).rejects.toBe(why);
    expect(() => dataset.features()).toThrow(why);
    expect(() => dataset.source(0, { signal: new AbortController().signal })).toThrow(why);
    const other = await open(), child = new AbortController(), view = other.source(0, { signal: child.signal });
    child.abort(why);
    await expect(view.read(0, 1, { signal: new AbortController().signal })).rejects.toBe(why);
  });
  it("captures every component capability and option before the first asynchronous read", async () => {
    const bytes = components(),
      saved = sources(bytes),
      original = saved.shp,
      originalRead = original.read.bind(original),
      config = { ...options };
    let first = true;
    const inputs = {
      ...saved,
      shp: {
        ...original,
        async read(o: number, n: number) {
          if (first) {
            first = false;
            inputs.shx = createByteSource(new Uint8Array());
            inputs.dbf = createByteSource(new Uint8Array());
            config.maxFeatureBytes = 0;
            for (const component of [inputs.shp, saved.shx, saved.dbf]) {
              Object.defineProperties(component, {
                size: { value: 0 },
                identity: { value: "changed-after-capture" },
                read: { value: () => Promise.reject(new Error("replaced capability must not run")) },
              });
            }
          }
          return originalRead(o, n);
        },
      },
    };
    const dataset = await openShapefile(inputs, config);
    expect((await dataset.read(0)).xy[1]).toBe(3.25);
    expect((await dataset.attributes(2))!.bytes[0]).toBe(32);
  });
  it("admits cross-realm native byte views and rejects spoofed byte lengths", async () => {
    const bytes = components();
    const source: ByteSourceType = {
      size: bytes.shp.length,
      stability: "caller",
      async read(o, n) {
        return runInNewContext("Uint8Array.from(values)", {
          values: Array.from(bytes.shp.slice(o, o + n)),
        }) as Uint8Array;
      },
    };
    expect((await openShapefile({ shp: source }, options)).featureCount).toBe(3);
    const bad: ByteSourceType = {
      ...source,
      async read(_o, n) {
        const b = new Uint8Array(1);
        Object.defineProperty(b, "byteLength", { value: n });
        return b;
      },
    };
    await expect(openShapefile({ shp: bad }, options)).rejects.toThrow("incomplete");
  });
  it("copies each borrowed scratch extent before a later read can reuse its storage", async () => {
    const bytes = components(), scratch = new Uint8Array(65536);
    const source: ByteSourceType = {
      size: bytes.shp.length,
      stability: "caller",
      async read(o, n) {
        scratch.fill(0);
        scratch.set(bytes.shp.subarray(o, o + n));
        return scratch.subarray(0, n);
      },
    };
    const dataset = await openShapefile({ shp: source }, options);
    expect(Array.from((await dataset.read(0)).xy)).toEqual([-0, 3.25]);
    expect(Array.from((await dataset.read(1)).xy)).toEqual([-4, -2]);
    expect(dataset.features().features[0]!.bounds).toEqual([-0, 3.25, -0, 3.25]);
  });
  it("bounds identity admission before I/O or derived JSON composition", async () => {
    let calls = 0;
    const b = components().shp,
      source: ByteSourceType = {
        size: b.length,
        stability: "caller",
        identity: "x".repeat(8193),
        async read(o, n) {
          calls++;
          return b.slice(o, o + n);
        },
      };
    await expect(openShapefile({ shp: source }, options)).rejects.toThrow("identity");
    expect(calls).toBe(0);
    const accepted = await openShapefile(
      { shp: { ...source, identity: "x".repeat(8192) } },
      options,
    );
    expect(accepted.source(0).identity!.length).toBeLessThan(65536);
  });
  it("requires explicit stable sources and preserves borrowed provider failure identity", async () => {
    const bytes = components();
    await expect(openShapefile({
      shp: {
        size: bytes.shp.length,
        async read(o, n) {
          return bytes.shp.slice(o, o + n);
        },
      },
    }, options)).rejects.toThrow("stability");
    const failure = new Error("provider failed");
    await expect(openShapefile({
      shp: {
        size: 100,
        stability: "caller",
        async read() {
          throw failure;
        },
      },
    }, options)).rejects.toBe(failure);
  });
});

const decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
describe("genuine PyShp3.1.6 component fixtures", () => {
  for (const f of fixture.fixtures) {
    it(`reads every physical byte/value from ${f.name} without using synthesized native parts as wire data`, async () => {
      const bytes = {
        shp: decode(f.components.shp.data),
        shx: decode(f.components.shx.data),
        dbf: decode(f.components.dbf.data),
      };
      const dataset = await open(bytes);
      expect(dataset.featureCount).toBe(f.originals.length);
      expect(dataset.work.indexChecks).toBe(f.originals.length);
      for (let id = 0; id < f.originals.length; id++) {
        const original = f.originals[id]!,
          read = await dataset.read(id),
          row = await dataset.attributes(id),
          xy = original.xy.flat();
        expect(Array.from(read.xy)).toEqual(xy);
        expect(Array.from(read.parts)).toEqual(original.parts);
        for (let i = 0; i < xy.length; i++) if (Object.is(xy[i], -0)) expect(Object.is(read.xy[i], -0)).toBe(true);
        expect(await dataset.source(id).read(0, f.tuples[id]!.bytes)).toEqual(decode(f.tuples[id]!.bodyBase64));
        expect(row!.bytes).toEqual(decode(f.rawRows[id]!));
        expect(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(row!.fields[0]!.bytes).trimEnd()).toBe(
          f.attributes[id]!.label,
        );
        expect(new TextDecoder().decode(row!.fields[1]!.bytes).trim()).toBe(f.attributes[id]!.integer);
        expect(dataset.features({ cursor: id, limit: 1 }).features[0]!.recordNumber).toBe(id + 1);
      }
      if (f.name === "multipoint") {
        expect(f.originals[0]!.parts).toEqual([]);
        expect(f.nativeParts[0]).toEqual([0]);
        expect((await dataset.read(0)).parts.length).toBe(0);
      }
      if (f.authoredDeletion) {
        const deleted = await open({ ...bytes, dbf: decode(f.authoredDeletion.data) });
        expect((await deleted.attributes(1))!.deleted).toBe(true);
        expect((await deleted.attributes(2))!.id).toBe(2);
        expect(deleted.featureCount).toBe(3);
        expect(f.authoredDeletion.nativeVisibleOrdinals).toEqual([0, 2]);
      }
    });
  }
  it("can index a MultiPoint without reading any of its point-array bytes", async () => {
    const bytes = components(8, [geometry(8, [1, 2, 3, 4])]).shp, calls: { offset: number; length: number }[] = [];
    const source: ByteSourceType = {
      size: bytes.length,
      stability: "caller",
      async read(offset, length) {
        calls.push({ offset, length });
        return bytes.slice(offset, offset + length);
      },
    };
    const dataset = await openShapefile({ shp: source }, options);
    expect(dataset.featureCount).toBe(1);
    expect(calls.every((c) => c.offset + c.length <= 148)).toBe(true);
    expect((await dataset.read(0)).xy.length).toBe(4);
  });
});
