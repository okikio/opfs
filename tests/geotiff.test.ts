import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { runInNewContext } from "node:vm";
import { decodeBase64 } from "@std/encoding/base64";
import native from "./fixtures/geotiff/independent.json" with { type: "json" };
import { createArchiveLedger, openGeotiff } from "../src/dataset/geotiff.ts";
import type { ByteSourceType } from "../src/source.ts";
import type { ArchiveLedgerType } from "../src/archive/record.ts";

/** Authored TIFF6 byte grammar, independent of the candidate reader. No native producer claim. */
function fixture(
  { little = true, tiled = false, bits = 16, format = 1, photo = 1, width = 5, height = 3, shortParameters = 0 }: {
    little?: boolean;
    tiled?: boolean;
    bits?: number;
    format?: number;
    photo?: number;
    width?: number;
    height?: number;
    shortParameters?: number;
  } = {},
) {
  const blockWidth = tiled ? 16 : width,
    blockHeight = tiled ? 16 : 2,
    across = Math.ceil(width / blockWidth),
    down = Math.ceil(height / blockHeight),
    blocks = across * down,
    samples = photo === 2 ? 3 : 1,
    unit = bits / 8;
  const fields: { tag: number; type: number; values: number[]; at?: number }[] = [
    { tag: 256, type: 4, values: [width] },
    { tag: 257, type: 4, values: [height] },
    { tag: 258, type: 3, values: Array<number>(samples).fill(bits) },
    { tag: 259, type: 3, values: [1] },
    { tag: 262, type: 3, values: [photo] },
    { tag: 277, type: 3, values: [samples] },
    { tag: 284, type: 3, values: [1] },
    { tag: 339, type: 3, values: Array<number>(samples).fill(format) },
    { tag: 33550, type: 12, values: [1, 1, 0] },
    { tag: 33922, type: 12, values: [0, 0, 0, 100, 200, 0] },
    { tag: 34735, type: 3, values: [1, 1, 1, 2, 1024, 0, 1, 1, 1025, 0, 1, 1] },
  ];
  if (shortParameters) {
    fields.find((field) => field.tag === 34735)!.values = [
      1,
      1,
      1,
      2,
      65000,
      34735,
      shortParameters,
      12,
      65001,
      34735,
      shortParameters,
      12,
      ...Array<number>(shortParameters).fill(7),
    ];
  }
  fields.push(
    ...(tiled
      ? [{ tag: 322, type: 4, values: [16] }, { tag: 323, type: 4, values: [16] }]
      : [{ tag: 278, type: 4, values: [2] }]),
  );
  const offsets = { tag: tiled ? 324 : 273, type: 4, values: Array<number>(blocks).fill(0) },
    lengths = {
      tag: tiled ? 325 : 279,
      type: 4,
      values: Array.from(
        { length: blocks },
        (_, i) => blockWidth * (tiled ? blockHeight : Math.min(blockHeight, height - i * blockHeight)) * samples * unit,
      ),
    };
  fields.push(offsets, lengths);
  fields.sort((a, b) => a.tag - b.tag);
  let end = 8 + 2 + 12 * fields.length + 4;
  for (const f of fields) {
    const n = f.values.length * (f.type === 3 ? 2 : f.type === 4 ? 4 : 8);
    if (n > 4) {
      if (end % 2) end++;
      f.at = end;
      end += n;
    }
  }
  const dataStart = end;
  for (let i = 0; i < blocks; i++) {
    offsets.values[i] = end;
    end += lengths.values[i]!;
  }
  const bytes = new Uint8Array(end), v = new DataView(bytes.buffer);
  bytes.set(little ? [73, 73] : [77, 77]);
  v.setUint16(2, 42, little);
  v.setUint32(4, 8, little);
  v.setUint16(8, fields.length, little);
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!, at = 10 + i * 12;
    v.setUint16(at, f.tag, little);
    v.setUint16(at + 2, f.type, little);
    v.setUint32(at + 4, f.values.length, little);
    if (f.at !== undefined) v.setUint32(at + 8, f.at, little);
    const base = f.at ?? at + 8;
    for (let j = 0; j < f.values.length; j++) {
      if (f.type === 3) v.setUint16(base + j * 2, f.values[j]!, little);
      else if (f.type === 4) v.setUint32(base + j * 4, f.values[j]!, little);
      else v.setFloat64(base + j * 8, f.values[j]!, little);
    }
  }
  function original(x: number, y: number, s: number): number {
    return y * 100 + x * 3 + s;
  }
  for (let block = 0; block < blocks; block++) {
    const bx = block % across,
      by = Math.floor(block / across),
      rows = tiled ? blockHeight : Math.min(blockHeight, height - by * blockHeight);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < blockWidth; x++) {
        for (let s = 0; s < samples; s++) {
          const n = original(bx * blockWidth + x, by * blockHeight + y, s),
            at = offsets.values[block]! + ((y * blockWidth + x) * samples + s) * unit;
          if (format === 3) {
            if (bits === 32) v.setFloat32(at, n, little);
            else v.setFloat64(at, n, little);
          } else if (bits === 8) v.setUint8(at, n);
          else if (bits === 16) v.setUint16(at, n, little);
          else v.setUint32(at, n, little);
        }
      }
    }
  }
  return {
    bytes,
    v,
    little,
    fields,
    offsets: offsets.values,
    lengths: lengths.values,
    dataStart,
    width,
    height,
    samples,
    original,
    entry(tag: number) {
      return 10 + fields.findIndex((f) => f.tag === tag) * 12;
    },
  };
}
function source(bytes: Uint8Array): ByteSourceType {
  return {
    size: bytes.length,
    identity: "authored-geotiff",
    stability: "caller",
    async read(offset, length) {
      return bytes.slice(offset, offset + length);
    },
  };
}
const options = { profile: "classic-geotiff-raw" as const };
describe("classic GeoTIFF authored grammar", () => {
  for (const little of [true, false]) {
    for (const tiled of [true, false]) {
      it(`reads exact ${little ? "II" : "MM"} ${tiled ? "tile" : "strip"} edge windows`, async () => {
        const f = fixture({ little, tiled, width: tiled ? 19 : 5, height: tiled ? 17 : 3 }),
          requests: { offset: number; length: number }[] = [];
        const input = {
          ...source(f.bytes),
          async read(offset: number, length: number) {
            requests.push({ offset, length });
            return f.bytes.slice(offset, offset + length);
          },
        };
        const raster = await openGeotiff(input, options);
        requests.length = 0;
        const window = { x: f.width - 3, y: f.height - 2, width: 3, height: 2 }, plan = raster.plan(0, window);
        expect(requests.length).toBe(0);
        const result = await raster.read(0, window);
        expect(result.values).toBeInstanceOf(Uint16Array);
        expect(Array.from(result.values)).toEqual(
          Array.from({ length: 6 }, (_, i) => f.original(window.x + i % 3, window.y + Math.floor(i / 3), 0)),
        );
        expect(result.work.sourceBytes).toBe(plan.sourceBytes);
        expect(result.work.requests).toBe(plan.requests);
        expect(requests.length).toBe(plan.requests);
        expect(result.work.spans).toBe(plan.spans);
        expect(result.integrity).toBe("not-provided");
        expect(raster.cog).toBe("not-evaluated");
        const block = raster.source(0, 0);
        expect(Array.from(await block.read(0, block.size))).toEqual(
          Array.from(f.bytes.subarray(f.offsets[0]!, f.offsets[0]! + f.lengths[0]!)),
        );
        expect(block.identity).toContain("physical-block");
      });
    }
  }
  it("retains three raw RGB bands without color conversion", async () => {
    const f = fixture({ bits: 8, photo: 2 }),
      r = await openGeotiff(source(f.bytes), options),
      v = await r.read(0, { x: 1, y: 1, width: 2, height: 1 });
    expect(Array.from(v.values)).toEqual([103, 104, 105, 106, 107, 108]);
  });
  it("retains WhiteIsZero without inversion", async () => {
    const f = fixture({ photo: 0 }), r = await openGeotiff(source(f.bytes), options);
    expect(r.images[0]!.photometric).toBe(0);
    expect((await r.read(0, { x: 0, y: 0, width: 1, height: 1 })).values[0]).toBe(0);
  });
  for (const bits of [32, 64]) {
    it(`preserves f${bits} NaN and negative-zero semantics and raw block bits`, async () => {
      const f = fixture({ bits, format: 3 }), at = f.offsets[0]!;
      if (bits === 32) {
        f.v.setUint32(at, 0x80000000, true);
        f.v.setUint32(at + 4, 0x7fc01234, true);
      } else {
        f.v.setBigUint64(at, 0x8000000000000000n, true);
        f.v.setBigUint64(at + 8, 0x7ff8000000001234n, true);
      }
      const r = await openGeotiff(source(f.bytes), options),
        read = await r.read(0, { x: 0, y: 0, width: 2, height: 1 });
      expect(Object.is(read.values[0], -0)).toBe(true);
      expect(Number.isNaN(read.values[1])).toBe(true);
      expect(Array.from(await r.source(0, 0).read(0, bits / 4))).toEqual(
        Array.from(f.bytes.subarray(at, at + bits / 4)),
      );
    });
  }
  it("freezes public metadata independently of the internal index", async () => {
    const f = fixture(), r = await openGeotiff(source(f.bytes), options);
    expect(() => Object.defineProperty(r.images[0], "width", { value: 999 })).toThrow();
    expect(() => Object.defineProperty(r.images[0]!.geo.pixelScale, 0, { value: 999 })).toThrow();
    expect(() => Object.defineProperty(r.images[0]!.geo.keys[0]!.values, 0, { value: 999 })).toThrow();
    expect((await r.read(0, { x: 0, y: 0, width: 1, height: 1 })).values[0]).toBe(0);
  });
  it("returns zero-work empty windows and refuses rectangles beyond the image", async () => {
    const f = fixture(), r = await openGeotiff(source(f.bytes), options);
    const w = { x: 5, y: 3, width: 0, height: 0 };
    expect(r.plan(0, w).requests).toBe(0);
    expect((await r.read(0, w)).values.length).toBe(0);
    expect(() => r.plan(0, { ...w, width: 1 })).toThrow();
  });
  it("rejects BigTIFF, compression, separate planes and missing geospatial authority", async () => {
    for (const tag of [259, 284, 34735]) {
      const f = fixture();
      f.v.setUint32(f.entry(tag) + 4, tag === 34735 ? 0 : 1, true);
      if (tag !== 34735) f.v.setUint16(f.entry(tag) + 8, 2, true);
      await expect(openGeotiff(source(f.bytes), options)).rejects.toThrow();
    }
    const f = fixture();
    f.v.setUint16(2, 43, true);
    await expect(openGeotiff(source(f.bytes), options)).rejects.toThrow("classic TIFF");
  });
  it("rejects unsorted/duplicate tags, cycles, unsafe field extents and short block tables", async () => {
    for (const mutation of [0, 1, 2, 3]) {
      const f = fixture();
      if (mutation === 0) f.v.setUint16(22, 256, true);
      if (mutation === 1) f.v.setUint32(10 + f.fields.length * 12, 8, true);
      if (mutation === 2) f.v.setUint32(f.entry(33550) + 8, f.bytes.length - 2, true);
      if (mutation === 3) f.v.setUint32(f.entry(273) + 4, 1, true);
      await expect(openGeotiff(source(f.bytes), options)).rejects.toThrow();
    }
  });
  it("rejects payload extents overlapping metadata", async () => {
    const f = fixture(), field = f.fields.find((x) => x.tag === 273)!;
    f.v.setUint32(field.at!, 8, true);
    await expect(openGeotiff(source(f.bytes), options)).rejects.toThrow("overlaps structural");
  });
  it("admits all selected work before provider I/O", async () => {
    const f = fixture();
    let calls = 0;
    const input = {
      ...source(f.bytes),
      async read(o: number, n: number) {
        calls++;
        return f.bytes.slice(o, o + n);
      },
    };
    await expect(openGeotiff(input, { ...options, maxDecodedBytes: 0 })).rejects.toThrow();
    expect(calls).toBe(0);
    const r = await openGeotiff(input, options);
    calls = 0;
    await expect(r.read(0, { x: 0, y: 0, width: 1, height: 1 }, { maxOutputBytes: 0 })).rejects.toThrow();
    expect(calls).toBe(0);
    await expect(r.read(0, { x: 0, y: 0, width: 1, height: 1 }, { maxDecodedBytes: 0 })).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it("retains opening quotas and deduplicates repeated external ledger identity", async () => {
    const f = fixture(),
      ledger = createArchiveLedger({ maxSourceBytes: 65536 }),
      r = await openGeotiff(source(f.bytes), { ...options, ledger });
    const before = ledger.inspect().sourceBytes;
    await r.read(0, { x: 0, y: 0, width: 1, height: 1 }, { ledger });
    expect(ledger.inspect().sourceBytes - before).toBe(2);
    const limited = await openGeotiff(source(f.bytes), { ...options, maxOutputBytes: 0 });
    await expect(limited.read(0, { x: 0, y: 0, width: 1, height: 1 })).rejects.toThrow();
  });
  it("does no I/O when a final foreign reservation aborts, including derived block reads", async () => {
    const f = fixture();
    let calls = 0;
    const input = {
      ...source(f.bytes),
      async read(o: number, n: number) {
        calls++;
        return f.bytes.slice(o, o + n);
      },
    };
    const controller = new AbortController(),
      why = new Error("foreign-abort"),
      base = createArchiveLedger(),
      ledger: ArchiveLedgerType = {
        inspect: base.inspect,
        reserve(kind, n) {
          base.reserve(kind, n);
          if (kind === "requests") controller.abort(why);
        },
      };
    await expect(openGeotiff(input, { ...options, signal: controller.signal, ledger })).rejects.toBe(why);
    expect(calls).toBe(0);
    const r = await openGeotiff(input, options),
      view = r.source(0, 0),
      c = new AbortController(),
      foreign: ArchiveLedgerType = {
        inspect: base.inspect,
        reserve(kind, n) {
          base.reserve(kind, n);
          if (kind === "requests") c.abort(why);
        },
      };
    calls = 0;
    await expect(view.read(0, 2, { signal: c.signal, ...{ ledger: foreign } })).rejects.toBe(why);
    expect(calls).toBe(0);
  });
  it("preserves parent cancellation through fresh child signals and source creation", async () => {
    const f = fixture(),
      c = new AbortController(),
      r = await openGeotiff(source(f.bytes), { ...options, signal: c.signal }),
      b = r.source(0, 0),
      why = new Error("parent");
    c.abort(why);
    await expect(r.read(0, { x: 0, y: 0, width: 1, height: 1 }, { signal: new AbortController().signal })).rejects.toBe(
      why,
    );
    await expect(b.read(0, 1, { signal: new AbortController().signal })).rejects.toBe(why);
    expect(() => r.source(0, 0, { signal: new AbortController().signal })).toThrow(why);
  });
  it("captures source methods and options before asynchronous callbacks", async () => {
    const f = fixture(), config = { ...options }, input = source(f.bytes);
    Object.defineProperty(input, "read", {
      value: async (o: number, n: number) => {
        Object.defineProperties(input, {
          read: { value: () => Promise.reject(new Error("replacement")), configurable: true },
          size: { value: 0, configurable: true },
        });
        config.profile = "changed" as typeof config.profile;
        return f.bytes.slice(o, o + n);
      },
      configurable: true,
    });
    const r = await openGeotiff(input, config);
    expect((await r.read(0, { x: 0, y: 0, width: 1, height: 1 })).values[0]).toBe(0);
  });
  it("copies reused borrowed scratch and admits cross-realm byte views", async () => {
    const f = fixture(),
      scratch = new Uint8Array(f.bytes.length),
      input = {
        ...source(f.bytes),
        async read(o: number, n: number) {
          scratch.set(f.bytes.subarray(o, o + n));
          return scratch.subarray(0, n);
        },
      };
    const r = await openGeotiff(input, options);
    expect(Array.from((await r.read(0, { x: 1, y: 1, width: 2, height: 1 })).values)).toEqual([103, 106]);
    const cross = {
      ...source(f.bytes),
      async read(o: number, n: number) {
        return runInNewContext("Uint8Array.from(values)", {
          values: Array.from(f.bytes.subarray(o, o + n)),
        }) as Uint8Array;
      },
    };
    expect((await openGeotiff(cross, options)).images.length).toBe(1);
  });
  it("rejects spoofed byte extents and overlong identities before provider I/O", async () => {
    const f = fixture(),
      bad = {
        ...source(f.bytes),
        async read(_o: number, n: number) {
          const b = new Uint8Array(1);
          Object.defineProperty(b, "byteLength", { value: n });
          return b;
        },
      };
    await expect(openGeotiff(bad, options)).rejects.toThrow("incomplete");
    await expect(openGeotiff({
      ...source(f.bytes),
      identity: "x".repeat(8193),
      read() {
        throw new Error("must not read");
      },
    }, options)).rejects.toThrow("identity");
  });
  it("bounds composed source identities at source creation without truncation", async () => {
    const f = fixture(), long = await openGeotiff({ ...source(f.bytes), identity: "x".repeat(8192) }, options);
    expect(() => long.source(0, 0)).toThrow("composed block identity");
    const short = await openGeotiff({ ...source(f.bytes), identity: "x".repeat(8000) }, options);
    expect(short.source(0, 0).identity!.length).toBeLessThanOrEqual(8192);
    expect(JSON.parse(short.source(0, 0).identity!)[1]).toBe("x".repeat(8000));
  });
  it("rejects malformed GeoKey references and present empty coordinate authority tags", async () => {
    const f = fixture(), directory = f.fields.find((field) => field.tag === 34735)!;
    f.v.setUint16(directory.at! + 10, 34736, true);
    f.v.setUint16(directory.at! + 14, 999, true);
    await expect(openGeotiff(source(f.bytes), options)).rejects.toThrow("parameters");
    const empty = fixture();
    empty.v.setUint32(empty.entry(33550) + 4, 0, true);
    await expect(openGeotiff(source(empty.bytes), options)).rejects.toThrow("coordinate");
  });
  it("does not return a pure plan after a caller window getter aborts its parent", async () => {
    const f = fixture(), controller = new AbortController(), why = new Error("window getter abort");
    const raster = await openGeotiff(source(f.bytes), { ...options, signal: controller.signal });
    expect(() =>
      raster.plan(0, {
        get x() {
          controller.abort(why);
          return 0;
        },
        y: 0,
        width: 1,
        height: 1,
      })
    ).toThrow(why);
  });
  it("enforces the local output ceiling on raw block ranges before source I/O", async () => {
    const f = fixture();
    let calls = 0;
    const raster = await openGeotiff({
      ...source(f.bytes),
      async read(o: number, n: number) {
        calls++;
        return f.bytes.slice(o, o + n);
      },
    }, { ...options, maxWindowBytes: 0 });
    calls = 0;
    await expect(raster.source(0, 0).read(0, 1)).rejects.toThrow("raw source interval");
    expect(calls).toBe(0);
  });
  it("charges each retained GeoKey parameter copy before metadata amplification", async () => {
    const f = fixture({ shortParameters: 60000 });
    await expect(openGeotiff(source(f.bytes), { ...options, maxMetadataBytes: 700000 })).rejects.toThrow(
      "retained metadata",
    );
  });
});

/** Full-byte native fixture consumers; original semantic values were authored before production. */
describe("genuine GDAL and independent tifffile GeoTIFF profiles", () => {
  for (const f of native.fixtures) {
    it(`reads every native sample and physical block from ${f.name}`, async () => {
      const raw = decodeBase64(f.file.base64), raster = await openGeotiff(source(raw), options);
      expect(raster.images.length).toBe(f.pages.length);
      for (let id = 0; id < f.pages.length; id++) {
        const original = f.pages[id]!, image = raster.images[id]!;
        expect(image.width).toBe(original.width);
        expect(image.height).toBe(original.height);
        expect(image.layout).toBe(original.tiled ? "tiles" : "strips");
        expect(image.blocks).toBe(original.blocks.length);
        const rectangle = { x: 0, y: 0, width: image.width, height: image.height }, plan = raster.plan(id, rectangle);
        const result = await raster.read(id, rectangle);
        expect(result.values.length).toBe(original.originalValues.length);
        for (let i = 0; i < original.originalValues.length; i++) {
          const expected = original.originalValues[i]!, actual = result.values[i];
          if (expected === "nan") expect(Number.isNaN(actual)).toBe(true);
          else if (expected === "-zero") expect(Object.is(actual, -0)).toBe(true);
          else if (expected === "+infinity") expect(actual).toBe(Infinity);
          else if (expected === "-infinity") expect(actual).toBe(-Infinity);
          else expect(actual).toBe(expected);
        }
        expect(result.work.sourceBytes).toBe(plan.sourceBytes);
        expect(result.work.requests).toBe(plan.requests);
        for (let block = 0; block < original.blocks.length; block++) {
          const bytes = decodeBase64(original.blocks[block]!.raw.base64), view = raster.source(id, block);
          expect(Array.from(await view.read(0, view.size))).toEqual(Array.from(bytes));
        }
        const edge = original.nativeEdgeWindow, selected = await raster.read(id, edge);
        for (let y = 0; y < edge.height; y++) {
          for (let x = 0; x < edge.width; x++) {
            for (let band = 0; band < image.samplesPerPixel; band++) {
              const expected = result.values[((edge.y + y) * image.width + edge.x + x) * image.samplesPerPixel + band];
              const actual = selected.values[(y * edge.width + x) * image.samplesPerPixel + band];
              expect(Object.is(actual, expected)).toBe(true);
            }
          }
        }
        const fields: Readonly<Record<string, { values: readonly number[] | null; raw: { base64: string } }>> =
          original.fields;
        const directory = fields["34735"]?.values;
        if (directory) {
          expect(image.geo.scope).toBe("unresolved-declarations");
          expect(image.geo.keys.map((key) => [key.id, key.location, key.count, key.offset])).toEqual(
            Array.from({ length: directory[3]! }, (_, i) => directory.slice(4 + i * 4, 8 + i * 4)),
          );
          expect(image.geo.pixelScale).toEqual(fields["33550"]?.values ?? []);
          expect(image.geo.tiepoints).toEqual(fields["33922"]?.values ?? []);
          expect(image.geo.ascii).toEqual(fields["34737"] ? Array.from(decodeBase64(fields["34737"]!.raw.base64)) : []);
        } else expect(image.geo.scope).toBe("absent-reduced-image");
      }
    });
  }
});
