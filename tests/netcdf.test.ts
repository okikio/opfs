import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { createArchiveLedger, openNetcdf } from "../src/dataset/netcdf.ts";
import type { ByteSourceType } from "../src/source.ts";
import fixture from "./fixtures/netcdf/independent.json" with { type: "json" };

const source = (bytes: Uint8Array) => createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
const bytesOf = (values: ArrayBufferView) => new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
function same(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  for (let index = 0; index < actual.length; index++) {
    if (actual[index] !== expected[index]) {
      throw new Error(`netCDF byte ${index} differs: ${actual[index]} vs ${expected[index]}`);
    }
  }
}
function native(profile: string, producer = "SciPy", version = 2): Uint8Array {
  return decodeBase64(
    fixture.fixtures.find((item) => item.profile === profile && item.producer === producer && item.version === version)!
      .file.base64,
  );
}
/** Authored geometry controls are distinct from native independent producer fixtures. */
function uint(value: number): Uint8Array {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, value, false);
  return data;
}
function concat(...arrays: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    result.set(a, at);
    at += a.length;
  }
  return result;
}
function name(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  return concat(uint(bytes.length), bytes, new Uint8Array((4 - bytes.length % 4) % 4));
}
function control(
  options: {
    version?: number;
    type?: number;
    records?: number;
    begin?: bigint;
    vsize?: number;
    dim?: number;
    dimid?: number;
    attributes?: Uint8Array;
    names?: string;
  } = {},
): Uint8Array {
  const version = options.version ?? 2,
    type = options.type ?? 3,
    width = type === 6 ? 8 : type >= 4 ? 4 : type === 3 ? 2 : 1;
  const offset = new Uint8Array(version === 1 ? 4 : 8);
  if (version === 1) new DataView(offset.buffer).setInt32(0, Number(options.begin ?? 512n), false);
  else new DataView(offset.buffer).setBigInt64(0, options.begin ?? 512n, false);
  const header = concat(
    Uint8Array.of(67, 68, 70, version),
    uint(options.records ?? 0),
    uint(10),
    uint(1),
    name("axis"),
    uint(options.dim ?? 3),
    uint(0),
    uint(0),
    uint(11),
    uint(1),
    name(options.names ?? "value"),
    uint(1),
    uint(options.dimid ?? 0),
    options.attributes ?? concat(uint(0), uint(0)),
    uint(type),
    uint(options.vsize ?? Math.ceil(3 * width / 4) * 4),
    offset,
  );
  const result = new Uint8Array(Math.max(524, 512 + Math.ceil(3 * width / 4) * 4));
  result.set(header);
  const data = new DataView(result.buffer);
  data.setInt16(512, 1, false);
  data.setInt16(514, 2, false);
  data.setInt16(516, 3, false);
  return result;
}
function attribute(key: string, type: number, values: readonly number[]): Uint8Array {
  const width = type === 6 ? 8 : type >= 4 ? 4 : type === 3 ? 2 : 1;
  const bytes = new Uint8Array(Math.ceil(values.length * width / 4) * 4), data = new DataView(bytes.buffer);
  for (let index = 0; index < values.length; index++) {
    if (type === 6) data.setFloat64(index * width, values[index]!, false);
    else if (type === 3) data.setInt16(index * width, values[index]!, false);
    else if (type === 4) data.setInt32(index * width, values[index]!, false);
    else bytes[index] = values[index]!;
  }
  return concat(name(key), uint(type), uint(values.length), bytes);
}
describe("netCDF classic selected numeric ranges", () => {
  it("matches every reciprocal SciPy/netCDF-C original and native two-record subset in CDF1 and CDF2", async () => {
    expect(fixture.byteorder).toBe("little");
    for (const original of fixture.fixtures) {
      const bytes = decodeBase64(original.file.base64);
      const deviation = original.producer === "SciPy" &&
        (original.profile.startsWith("single-") || original.profile === "empty");
      if (deviation) await expect(openNetcdf(source(bytes))).rejects.toMatchObject({ code: "invalid-archive" });
      const dataset = await openNetcdf(source(bytes), {
        recordVsize: deviation ? "allow-unpadded" : "validate",
        maxSegments: 100000,
        maxRequests: 1000000,
      });
      expect(dataset.deviations.length).toBe(deviation ? 1 : 0);
      expect(dataset.version).toBe(original.version);
      expect(dataset.variables.length).toBe(original.variables.length);
      for (const variable of original.variables) {
        const indexed = dataset.variables[variable.id]!;
        expect(indexed.name).toBe(variable.name);
        expect(indexed.shape).toEqual(variable.shape);
        const result = await dataset.read(variable.id, { maxRequests: 100000 });
        same(bytesOf(result.values), decodeBase64(variable.nativeLittleEndian.base64));
        expect(result.integrity).toBe("not-provided");
        expect(result.work.sourceBytes).toBe(result.values.byteLength);
        if (variable.subset) {
          same(
            bytesOf(
              (await dataset.read(variable.id, { offset: indexed.recordElements, count: 2 * indexed.recordElements }))
                .values,
            ),
            decodeBase64(variable.subset.base64),
          );
        }
      }
    }
  });
  it("handles sole unpadded BYTE/CHAR/SHORT record strides despite padded vsize", async () => {
    for (const profile of ["single-byte", "single-char", "single-short"]) {
      const dataset = await openNetcdf(source(native(profile, "netCDF-C")));
      const variable = dataset.variables[0]!;
      expect(variable.vsize).toBe(profile === "single-short" ? 8 : 4);
      expect(dataset.recordStride).toBe(profile === "single-short" ? 6 : 3);
      const selected = await dataset.read(0, { offset: 2, count: 5 });
      expect(Array.from(selected.values)).toEqual([2, 3, 4, 5, 6]);
      expect(selected.work.sourceBytes).toBe(profile === "single-short" ? 10 : 5);
      expect(selected.work.requests).toBe(3);
    }
    const empty = await openNetcdf(source(native("empty", "netCDF-C")));
    expect(empty.records).toBe(0);
    expect((await empty.read(0)).values.length).toBe(0);
    expect((await empty.read(0)).work.requests).toBe(0);
  });
  it("reads interleaved records without neighboring variables, and keeps missing candidates separate from scaling", async () => {
    const base = source(native("mixed")), calls: number[][] = [];
    const dataset = await openNetcdf({
      ...base,
      async read(offset, length, options) {
        calls.push([offset, length]);
        return await base.read(offset, length, options);
      },
    });
    const variable = dataset.variables.find((v) => v.name === "record_short")!;
    calls.length = 0;
    const result = await dataset.read(variable.id, { offset: 2, count: 5 });
    expect(Array.from(result.values)).toEqual([2, 3, -777, 5, 6]);
    expect(result.undefinedMask).toEqual(Uint8Array.of(0, 0, 1, 0, 0));
    expect(calls).toEqual([[variable.offset + 4, 2], [variable.offset + dataset.recordStride, 6], [
      variable.offset + 2 * dataset.recordStride,
      2,
    ]]);
    const scaled = await dataset.read(variable.id, { scale: "physical" });
    expect(scaled.values).toEqual(Float64Array.of(-489.5, 10.5, 11, 11.5, -378.5, 12.5, 13, 13.5, -434));
    expect(scaled.undefinedMask).toEqual(Uint8Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1));
    expect((await dataset.read(variable.id, { missing: "none" })).undefinedMask).toEqual(new Uint8Array(9));
    const byte = dataset.variables.find((v) => v.name === "byte")!;
    expect((await dataset.read(byte.id)).undefinedMask[1]).toBe(0);
    expect((await dataset.read(byte.id, { missing: "fill" })).undefinedMask[1]).toBe(1);
    const chars = dataset.variables.find((v) => v.name === "char")!;
    expect((await dataset.read(chars.id)).values).toEqual(Uint8Array.of(0, 1, 65, 127, 128, 255));
    await expect(dataset.read(chars.id, { scale: "physical" })).rejects.toMatchObject({ code: "unsupported-profile" });
    const floats = await dataset.read(dataset.variables.find((v) => v.name === "float")!.id);
    expect(floats.undefinedMask).toEqual(Uint8Array.of(0, 1, 0, 0, 0, 0));
    expect(Object.is(floats.values[0], -0)).toBe(true);
  });
  it("validates exact offsets, tags, dimension references, names and unsupported profiles", async () => {
    for (
      const options of [
        { version: 5 },
        { records: 0xffffffff },
        { vsize: 0xffffffff },
        { vsize: 4 },
        { begin: -4n },
        { begin: 9007199254740992n },
        { begin: 510n },
        { begin: 4n },
        { version: 1, begin: 0x80000100n },
        { dimid: 1 },
        { names: "bad/name" },
        { names: "e\u0301" },
      ]
    ) await expect(openNetcdf(source(control(options)))).rejects.toBeInstanceOf(Error);
    const truncated = control().slice(0, 516);
    await expect(openNetcdf(source(truncated))).rejects.toMatchObject({ code: "invalid-archive" });
    const tag = control();
    new DataView(tag.buffer).setUint32(8, 11, false);
    await expect(openNetcdf(source(tag))).rejects.toMatchObject({ code: "invalid-archive" });
    const padding = control();
    padding[44] = 1;
    await expect(openNetcdf(source(padding))).rejects.toBeInstanceOf(Error);
    const dataset = await openNetcdf(source(control()));
    expect((await dataset.read(0)).values).toEqual(Int16Array.of(1, 2, 3));
  });
  it("uses exact CDF2 high offsets through an explicitly authored segmented source", async () => {
    const offset = 0x80000100n, raw = control({ begin: offset }), calls: number[][] = [];
    const segmented: ByteSourceType = {
      size: Number(offset) + 12,
      stability: "immutable",
      async read(at, length) {
        calls.push([at, length]);
        const result = new Uint8Array(length);
        if (at < raw.length) result.set(raw.subarray(at, Math.min(raw.length, at + length)));
        if (at >= Number(offset)) {
          const values = new Uint8Array(6);
          new DataView(values.buffer).setInt16(0, 1234, false);
          result.set(values.subarray(at - Number(offset), at - Number(offset) + length));
        }
        return result;
      },
    };
    const dataset = await openNetcdf(segmented);
    calls.length = 0;
    expect((await dataset.read(0, { count: 1 })).values).toEqual(Int16Array.of(1234));
    expect(calls).toEqual([[Number(offset), 2]]);
  });
  it("bounds convention interpretation and separates source masks from scaling-produced IEEE values", async () => {
    const wrongFill = concat(uint(12), uint(1), attribute("_FillValue", 4, [1]));
    const dataset = await openNetcdf(source(control({ attributes: wrongFill })));
    await expect(dataset.read(0)).rejects.toMatchObject({ code: "unsupported-profile" });
    expect((await dataset.read(0, { missing: "none" })).values).toEqual(Int16Array.of(1, 2, 3));
    const unsigned = concat(uint(12), uint(1), attribute("_Unsigned", 2, [116, 114, 117, 101]));
    const declared = await openNetcdf(source(control({ attributes: unsigned })));
    expect((await declared.read(0)).values).toEqual(Int16Array.of(1, 2, 3));
    await expect(declared.read(0, { scale: "physical" })).rejects.toMatchObject({ code: "unsupported-profile" });
    const attrs = concat(uint(12), uint(2), attribute("scale_factor", 6, [0]), attribute("valid_max", 3, [-1]));
    const bytes = control({ type: 6, attributes: attrs });
    new DataView(bytes.buffer).setFloat64(512, Infinity, false);
    const scaled = await (await openNetcdf(source(bytes))).read(0, { count: 1, scale: "physical" });
    expect(Number.isNaN(scaled.values[0])).toBe(true);
    expect(scaled.undefinedMask[0]).toBe(0);
    const bounded = await openNetcdf(
      source(control({ attributes: concat(uint(12), uint(1), attribute("missing_value", 3, [1, 2])) })),
      { maxMissingValues: 1 },
    );
    await expect(bounded.read(0)).rejects.toMatchObject({ code: "budget-exceeded" });
    expect((await bounded.read(0, { missing: "none" })).undefinedMask).toEqual(new Uint8Array(3));
    await expect(openNetcdf(source(control({ vsize: 6 })), { recordVsize: "allow-unpadded" })).rejects.toMatchObject({
      code: "invalid-archive",
    });
  });
  it("retains opening and additional ledgers and preadmits known cost before selected I/O", async () => {
    const bytes = control(), base = source(bytes), calls: number[][] = [];
    const tracked = {
      ...base,
      async read(offset: number, length: number, opts?: { signal?: AbortSignal }) {
        calls.push([offset, length]);
        return await base.read(offset, length, opts);
      },
    };
    for (const [dimension, maximum] of [["maxSourceBytes", bytes.length], ["maxRequests", 1]] as const) {
      const ledger = createArchiveLedger({ [dimension]: maximum });
      const dataset = await openNetcdf(tracked, { ledger });
      calls.length = 0;
      await expect(dataset.read(0, { count: 1 })).rejects.toMatchObject({ code: "budget-exceeded" });
      expect(calls).toEqual([]);
    }
    const ledger = createArchiveLedger({ maxSourceBytes: bytes.length + 2, maxRequests: 2 });
    const dataset = await openNetcdf(tracked, { ledger });
    await dataset.read(0, { count: 1, ledger });
    expect(ledger.inspect().sourceBytes).toBe(bytes.length + 2);
    const another = await openNetcdf(tracked);
    calls.length = 0;
    for (
      const options of [{ maxSourceBytes: 0 }, { maxRequests: 0 }, { maxOutputBytes: 2 }, {
        ledger: createArchiveLedger({ maxSourceBytes: 0 }),
      }]
    ) await expect(another.read(0, { count: 1, ...options })).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(calls).toEqual([]);
    for (const options of [{ maxDimensions: 0 }, { maxVariables: 0 }, { maxRank: 0 }, { maxHeaderBytes: 12 }]) {
      await expect(openNetcdf(base, options)).rejects.toMatchObject({ code: "budget-exceeded" });
    }
    const limited = await openNetcdf(source(native("mixed")), { maxSegments: 1, maxMissingValues: 1 });
    await expect(limited.read(limited.variables.find((v) => v.name === "record_short")!.id)).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    const segmentLimit = await openNetcdf(source(native("mixed")), { maxSegments: 1 });
    await expect(
      segmentLimit.read(segmentLimit.variables.find((v) => v.name === "record_short")!.id, { offset: 2, count: 2 }),
    ).rejects.toMatchObject({ code: "budget-exceeded" });
    const elementLimit = await openNetcdf(base, { maxElements: 0 });
    await expect(elementLimit.read(0, { count: 1 })).rejects.toMatchObject({ code: "budget-exceeded" });
  });
  it("captures descriptors/options, composes owner abort, and preserves original provider failures", async () => {
    const base = source(control()),
      parent = new AbortController(),
      mutable = { ...base },
      options = { signal: parent.signal, maxElements: 3 };
    const pending = openNetcdf(mutable, options);
    mutable.size = 0;
    mutable.read = async () => {
      throw new Error("mutated descriptor");
    };
    options.maxElements = 0;
    const dataset = await pending;
    expect((await dataset.read(0)).values.length).toBe(3);
    const error = new Error("parent aborted");
    parent.abort(error);
    await expect(dataset.read(0, { count: 0 })).rejects.toBe(error);
    let fail = false;
    const failing = await openNetcdf({
      ...base,
      async read(at, length, opts) {
        if (fail) throw error;
        return await base.read(at, length, opts);
      },
    });
    fail = true;
    await expect(failing.read(0, { count: 1 })).rejects.toBe(error);
    await expect(openNetcdf({ ...base, stability: "fake" } as unknown as ByteSourceType)).rejects.toBeInstanceOf(
      TypeError,
    );
  });
});
