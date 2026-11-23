import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import native from "./fixtures/parquet/independent.json" with { type: "json" };
import type { ParquetValuesType } from "../src/dataset/parquet.ts";
import { runInNewContext } from "node:vm";
import { ArchiveError, createArchiveLedger, openParquet } from "../src/dataset/parquet.ts";
import type { ByteSourceType } from "../src/source.ts";

// Authored wire controls exercise the pinned grammar. They are not native
// interoperability fixtures and do not serve as the independent value oracle.
function cat(...arrays: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(arrays.reduce((sum, bytes) => sum + bytes.length, 0));
  let offset = 0;
  for (const bytes of arrays) {
    output.set(bytes, offset);
    offset += bytes.length;
  }
  return output;
}
function uint(value: bigint | number): Uint8Array {
  let rest = BigInt(value);
  const bytes: number[] = [];
  do {
    bytes.push(Number(rest & 127n) | (rest > 127n ? 128 : 0));
    rest >>= 7n;
  } while (rest !== 0n);
  return Uint8Array.from(bytes);
}
function signed(value: bigint | number): Uint8Array {
  const number = BigInt(value);
  return uint(number >= 0n ? number * 2n : -number * 2n - 1n);
}
function string(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  return cat(uint(bytes.length), bytes);
}
function list(type: number, values: Uint8Array[]): Uint8Array {
  return cat(
    values.length < 15
      ? Uint8Array.of((values.length << 4) | type)
      : cat(Uint8Array.of(0xf0 | type), uint(values.length)),
    ...values,
  );
}
type FieldType = readonly [number, number, Uint8Array];
function fields(...values: FieldType[]): Uint8Array {
  return cat(...values.map(([id, type, value]) => cat(Uint8Array.of(type), signed(id), value)), Uint8Array.of(0));
}
function crc(bytes: Uint8Array): number {
  // Independent test bit recurrence from the published CRC32 polynomial.
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function fixture(options: {
  empty?: boolean;
  dataOffset?: number;
  metadataValues?: number;
  decodedSize?: number;
  dictionary?: number;
  optional?: boolean;
  version?: 1 | 2;
  checksum?: boolean;
  duplicate?: number;
  absent?: number;
  pageRows?: number;
  trailing?: Uint8Array;
  codec?: number;
  type?: number;
  name?: string;
  unknown?: FieldType[];
  annotations?: FieldType[];
} = {}) {
  const optional = options.optional ?? false, version = options.version ?? 1;
  const pageCount = options.empty ? 0 : 2, pages: Uint8Array[] = [], bodies: { offset: number; length: number }[] = [];
  let position = 4;
  for (let page = 0; page < pageCount; page++) {
    const data = new Uint8Array((optional ? 4 : 8) * 4), view = new DataView(data.buffer);
    for (let row = 0; row < (optional ? 4 : 8); row++) view.setInt32(row * 4, page * 100 + row, true);
    const level = optional ? Uint8Array.of(3, 0b10101010) : new Uint8Array();
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, level.length, true);
    const body = cat(optional && version === 1 ? length : new Uint8Array(), level, data);
    const subheader = version === 1
      ? fields([1, 5, signed(options.pageRows ?? 8)], [2, 5, signed(0)], [3, 5, signed(3)], [4, 5, signed(3)])
      : fields(
        [1, 5, signed(8)],
        [2, 5, signed(optional ? 4 : 0)],
        [3, 5, signed(8)],
        [4, 5, signed(0)],
        [5, 5, signed(level.length)],
        [6, 5, signed(0)],
        [7, 2, new Uint8Array()],
      );
    const checksum: FieldType[] = options.checksum ? [[4, 5, signed(BigInt.asIntN(32, BigInt(crc(body))))]] : [];
    const header = fields(
      [1, 5, signed(version === 1 ? 0 : 3)],
      [2, 5, signed(body.length)],
      [3, 5, signed(body.length)],
      ...checksum,
      [version === 1 ? 5 : 8, 12, subheader],
    );
    bodies.push({ offset: position + header.length, length: body.length });
    pages.push(cat(header, body));
    position += header.length + body.length;
  }
  const allPages = cat(...pages), name = options.name ?? "value";
  const schema = list(12, [
    fields([4, 8, string("root")], [5, 5, signed(1)]),
    fields(
      [1, 5, signed(options.type ?? 1)],
      [3, 5, signed(optional ? 1 : 0)],
      [4, 8, string(name)],
      ...(options.annotations ?? []),
    ),
  ]);
  const metadata = fields(
    [1, 5, signed(options.type ?? 1)],
    [2, 9, list(5, [signed(0), signed(3)])],
    [3, 9, list(8, [string(name)])],
    [4, 5, signed(options.codec ?? 0)],
    [5, 6, signed(options.metadataValues ?? pageCount * 8)],
    [6, 6, signed(options.decodedSize ?? allPages.length)],
    [7, 6, signed(allPages.length)],
    [9, 6, signed(options.dataOffset ?? (options.empty ? 0 : 4))],
    ...(options.dictionary === undefined ? [] : [[11, 6, signed(options.dictionary)] as FieldType]),
  );
  const group = fields([1, 9, list(12, [fields([2, 6, signed(0)], [3, 12, metadata])])], [
    2,
    6,
    signed(options.decodedSize ?? allPages.length),
  ], [3, 6, signed(pageCount * 8)]);
  const footerFields: FieldType[] = [
    [1, 5, signed(1)],
    [2, 9, schema],
    [3, 6, signed(pageCount * 8)],
    [4, 9, list(12, [group])],
    ...(options.unknown ?? []),
  ];
  if (options.duplicate !== undefined) footerFields.push([options.duplicate, 5, signed(1)]);
  const footer = cat(
    fields(...footerFields.filter(([id]) => id !== options.absent)),
    options.trailing ?? new Uint8Array(),
  );
  const tail = new Uint8Array(8);
  new DataView(tail.buffer).setUint32(0, footer.length, true);
  tail.set([80, 65, 82, 49], 4);
  return { bytes: cat(Uint8Array.of(80, 65, 82, 49), allPages, footer, tail), bodies, footer: 4 + allPages.length };
}
function source(bytes: Uint8Array, callback?: (offset: number, length: number) => void): ByteSourceType {
  return {
    size: bytes.length,
    stability: "caller",
    async read(offset, length) {
      callback?.(offset, length);
      return bytes.slice(offset, offset + length);
    },
  };
}
async function refusal(action: () => unknown | Promise<unknown>, code: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveError);
    expect((error as ArchiveError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

/** Decode the retained original little-endian values independently of the candidate reader. */
function originalValues(name: string, bytes: Uint8Array): (number | bigint)[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = name === "b" ? 1 : name === "i" || name === "f" ? 4 : 8;
  return Array.from({ length: bytes.length / width }, (_, index) => {
    const at = index * width;
    return name === "b"
      ? view.getUint8(at)
      : name === "i"
      ? view.getInt32(at, true)
      : name === "q"
      ? view.getBigInt64(at, true)
      : name === "f"
      ? view.getFloat32(at, true)
      : view.getFloat64(at, true);
  });
}
function sameValues(actual: ParquetValuesType, expected: readonly (number | bigint)[]): void {
  expect(actual.length).toBe(expected.length);
  for (let index = 0; index < expected.length; index++) {
    // Object.is distinguishes signed zero and considers NaN value semantics equal.
    if (!Object.is(actual[index], expected[index])) throw new Error(`Original Parquet value differs at row ${index}`);
  }
}

describe("Parquet physical numeric preview", () => {
  it("accepts only truly empty zero-offset column sentinels without payload I/O", async () => {
    let calls = 0;
    const dataset = await openParquet(source(fixture({ empty: true }).bytes, () => calls++));
    const openingCalls = calls;
    const result = await dataset.read(0);
    expect(result.values.length).toBe(0);
    expect(result.validity.length).toBe(0);
    expect(result.pages).toEqual([]);
    expect(result.work.sourceBytes).toBe(0);
    expect(result.work.requests).toBe(0);
    expect(calls).toBe(openingCalls);
    for (
      const options of [{ empty: true, dataOffset: 1 }, { empty: true, metadataValues: 1 }, {
        empty: true,
        dictionary: 0,
      }, { empty: true, decodedSize: 1 }]
    ) {
      await refusal(() => openParquet(source(fixture(options).bytes)), "invalid-archive");
    }
  });
  it("matches all twenty reciprocal native originals across all five physical columns", async () => {
    const positives = native.fixtures.filter((item) => item.supported);
    expect(positives.length).toBe(20);
    for (const item of positives) {
      const dataset = await openParquet(source(decodeBase64(item.file.base64)));
      expect(dataset.rows).toBe(item.rows);
      expect(dataset.rowGroups.length).toBe(item.rowGroups.length);
      expect(dataset.columns.length).toBe(5);
      for (const column of item.columns) {
        const descriptor = dataset.columns.find((field) => field.name === column.name)!;
        expect(descriptor.readable).toBe(true);
        const original = originalValues(column.name, decodeBase64(column.physicalLittleEndian.base64));
        const mask = decodeBase64(column.validity.base64);
        const result = await dataset.read(descriptor.id);
        sameValues(result.values, original);
        expect(result.validity).toEqual(mask);
        expect(result.pages.every((page) => page.selected)).toBe(true);
        const expectedChecksum = item.producer === "PyArrow" && item.case.endsWith("True")
          ? "crc32-verified"
          : "not-provided";
        expect(result.pages.every((page) => page.checksum === expectedChecksum)).toBe(true);
        // This selection crosses the native two-row-group split and multiple small pages
        // in the many-pages fixtures; short files cross their tiny row-group boundaries.
        const offset = item.rows > 100 ? 2000 : item.rows > 8 ? 6 : 0;
        const length = Math.min(item.rows - offset, item.rows > 100 ? 100 : 20);
        const selected = await dataset.read(descriptor.id, { offset, length });
        sameValues(selected.values, original.slice(offset, offset + length));
        expect(selected.validity).toEqual(mask.slice(offset, offset + length));
        for (const page of selected.pages) expect(page.checksum).toBe(page.selected ? expectedChecksum : "not-read");
        if (item.case.includes("many-pages")) {
          expect(new Set(selected.pages.filter((page) => page.selected).map((page) => page.rowGroup)).size).toBe(2);
        }
      }
    }
  });
  it("keeps both genuine dictionary and Snappy files indexed but refuses value decoding", async () => {
    const controls = native.fixtures.filter((item) => !item.supported);
    expect(controls.length).toBe(2);
    for (const item of controls) {
      const dataset = await openParquet(source(decodeBase64(item.file.base64)));
      expect(dataset.columns[0]!.readable).toBe(false);
      await refusal(() => dataset.read(0), "unsupported-profile");
    }
  });
  it("admits only exact signed identity annotations and validates their typed grammar", async () => {
    const integer = (
      width: number,
      signed: boolean,
    ): FieldType => [
      10,
      12,
      fields([10, 12, fields([1, 3, Uint8Array.of(width)], [2, signed ? 1 : 2, new Uint8Array()])]),
    ];
    for (
      const annotations of [[integer(32, true)], [[6, 5, signed(17)] as FieldType], [
        [6, 5, signed(17)] as FieldType,
        integer(32, true),
      ]]
    ) {
      const dataset = await openParquet(source(fixture({ annotations }).bytes));
      expect(dataset.columns[0]!.readable).toBe(true);
      expect((await dataset.read(0, { length: 2 })).values).toEqual(Int32Array.of(0, 1));
    }
    for (
      const annotations of [
        [integer(32, false)],
        [integer(8, true)],
        [integer(64, true)],
        [[6, 5, signed(18)] as FieldType],
        [[6, 5, signed(13)] as FieldType, integer(32, false)],
        [[6, 5, signed(15)] as FieldType, integer(8, true)],
        [integer(32, true), [7, 5, signed(0)] as FieldType],
      ]
    ) {
      const dataset = await openParquet(source(fixture({ annotations }).bytes));
      expect(dataset.columns[0]!.readable).toBe(false);
      await refusal(() => dataset.read(0), "unsupported-profile");
    }
    const malformed: FieldType[][] = [
      [[6, 5, signed(18)], integer(32, true)],
      [[6, 5, signed(13)], integer(32, true)],
      [[6, 5, signed(15)], integer(16, true)],
      [[10, 12, fields()]],
      [[10, 12, fields([10, 12, fields([1, 3, Uint8Array.of(32)])])]],
      [[10, 12, fields([10, 12, fields([2, 1, new Uint8Array()])])]],
      [[10, 12, fields([10, 12, fields([1, 3, Uint8Array.of(31)], [2, 1, new Uint8Array()])])]],
      [[10, 12, fields([10, 12, fields([1, 5, signed(32)], [2, 1, new Uint8Array()])])]],
      [[10, 12, fields([10, 12, fields([1, 3, Uint8Array.of(32)], [2, 3, Uint8Array.of(1)])])]],
      [[
        10,
        12,
        fields([10, 12, fields([1, 3, Uint8Array.of(32)], [1, 3, Uint8Array.of(32)], [2, 1, new Uint8Array()])]),
      ]],
      [[10, 12, fields([1, 12, fields()], [10, 12, fields([1, 3, Uint8Array.of(32)], [2, 1, new Uint8Array()])])]],
    ];
    for (const annotations of malformed) {
      await refusal(() => openParquet(source(fixture({ annotations }).bytes)), "invalid-archive");
    }
    const unknown = await openParquet(source(fixture({ annotations: [[10, 12, fields([127, 12, fields()])]] }).bytes));
    expect(unknown.columns[0]!.readable).toBe(false);
  });
  it("reads required and optional v1/v2 pages with exact null masks and selected page evidence", async () => {
    for (const version of [1, 2] as const) {
      for (const optional of [false, true]) {
        const control = fixture({ version, optional, checksum: true });
        const data = await openParquet(source(control.bytes));
        const selected = await data.read(0, { offset: 6, length: 5 });
        expect([...selected.values]).toEqual(optional ? [0, 3, 0, 100, 0] : [6, 7, 100, 101, 102]);
        expect([...selected.validity]).toEqual(optional ? [0, 1, 0, 1, 0] : [1, 1, 1, 1, 1]);
        expect(selected.pages.map((page) => page.checksum)).toEqual(["crc32-verified", "crc32-verified"]);
      }
    }
  });
  it("keeps unchecked pages and absent checksums observable", async () => {
    const data = await openParquet(source(fixture().bytes));
    const result = await data.read(0, { offset: 0, length: 1 });
    expect(result.pages.map((page) => [page.selected, page.checksum])).toEqual([[true, "not-provided"], [
      false,
      "not-read",
    ]]);
    expect(result.integrity).toBe("selected-pages");
    expect(data.integrity).toBe("metadata-unverified");
  });
  it("refuses selected CRC tampering while an unselected body is not claimed verified", async () => {
    const control = fixture({ checksum: true });
    control.bytes[control.bodies[1]!.offset] = control.bytes[control.bodies[1]!.offset]! ^ 1;
    const data = await openParquet(source(control.bytes));
    expect([...(await data.read(0, { length: 1 })).values]).toEqual([0]);
    await refusal(() => data.read(0, { offset: 8, length: 1 }), "checksum-mismatch");
  });
  it("refuses absent required fields and duplicate known or unknown Compact IDs", async () => {
    for (const absent of [1, 2, 3, 4]) {
      await refusal(() => openParquet(source(fixture({ absent }).bytes)), "invalid-archive");
    }
    await refusal(() => openParquet(source(fixture({ duplicate: 1 }).bytes)), "invalid-archive");
    await refusal(
      () => openParquet(source(fixture({ unknown: [[20, 5, signed(1)]], duplicate: 20 }).bytes)),
      "invalid-archive",
    );
  });
  it("skips bounded unknown containers and refuses malformed typed fields or trailing footer bytes", async () => {
    const unknown: FieldType[] = [[20, 12, fields([1, 11, cat(uint(1), Uint8Array.of(0x55), signed(1), signed(-1))])]];
    expect((await openParquet(source(fixture({ unknown }).bytes))).rows).toBe(16);
    await refusal(() => openParquet(source(fixture({ trailing: Uint8Array.of(0) }).bytes)), "invalid-archive");
    await refusal(
      () => openParquet(source(fixture({ unknown: [[20, 5, Uint8Array.of(255, 255, 255, 255, 127)]] }).bytes)),
      "invalid-archive",
    );
  });
  it("admits signed int16 unknown IDs while refusing duplicates and width overflow", async () => {
    const unknown: FieldType[] = [0, -1, -32768, 32767].map((id) => [id, 5, signed(123)]);
    expect((await openParquet(source(fixture({ unknown }).bytes))).rows).toBe(16);
    for (const id of [0, -1, -32768, 32767]) {
      await refusal(
        () => openParquet(source(fixture({ unknown: [[id, 5, signed(1)]], duplicate: id }).bytes)),
        "invalid-archive",
      );
    }
    for (const id of [-32769, 32768]) {
      await refusal(() => openParquet(source(fixture({ unknown: [[id, 5, signed(1)]] }).bytes)), "invalid-archive");
    }
  });
  it("bounds strings, depth, Compact work, metadata, columns, pages and selected output", async () => {
    const control = fixture();
    for (
      const options of [{ maxFooterBytes: 1 }, { maxStringBytes: 1 }, { maxDepth: 1 }, { maxCompactValues: 2 }, {
        maxRetainedMetadataBytes: 1,
      }, { maxColumns: 0 }]
    ) {
      await refusal(() => openParquet(source(control.bytes), options), "budget-exceeded");
    }
    const data = await openParquet(source(control.bytes), { maxPages: 1 });
    await refusal(() => data.read(0), "budget-exceeded");
    const normal = await openParquet(source(control.bytes));
    await refusal(() => normal.read(0, { length: 1, maxOutputBytes: 4 }), "budget-exceeded");
  });
  it("refuses inconsistent declared rows and preserves indexed unsupported codecs/types", async () => {
    const bad = await openParquet(source(fixture({ pageRows: 9 }).bytes));
    await refusal(() => bad.read(0), "invalid-archive");
    for (const options of [{ codec: 1 }, { type: 3 }]) {
      const indexed = await openParquet(source(fixture(options).bytes));
      expect(indexed.columns[0]!.readable).toBe(false);
      await refusal(() => indexed.read(0), "unsupported-profile");
    }
  });
  it("captures source and options before the first await and returns immutable index descriptors", async () => {
    const control = fixture(), input = source(control.bytes), options = { maxRows: 16 };
    const pending = openParquet(input, options);
    input.read = () => Promise.reject(new Error("mutated method"));
    options.maxRows = 0;
    const data = await pending;
    expect(Object.isFrozen(data.columns[0])).toBe(true);
    expect([...(await data.read(0, { length: 2 })).values]).toEqual([0, 1]);
  });
  it("owns scratch-backed source metadata before subsequent reads reuse it", async () => {
    const bytes = fixture({ checksum: true }).bytes, scratch = new Uint8Array(bytes.length);
    const data = await openParquet({
      size: bytes.length,
      stability: "caller",
      async read(offset, length) {
        scratch.fill(0xee);
        scratch.set(bytes.subarray(offset, offset + length));
        return scratch.subarray(0, length);
      },
    });
    expect([...(await data.read(0, { offset: 7, length: 3 })).values]).toEqual([7, 100, 101]);
  });
  it("accepts genuine cross-realm bytes and refuses incomplete extents", async () => {
    const bytes = fixture().bytes;
    const foreign = await openParquet({
      size: bytes.length,
      stability: "caller",
      async read(offset, length) {
        return runInNewContext("Uint8Array.from(bytes)", { bytes: bytes.slice(offset, offset + length) });
      },
    });
    expect((await foreign.read(0, { length: 1 })).values[0]).toBe(0);
    await refusal(() =>
      openParquet({
        size: bytes.length,
        stability: "caller",
        async read() {
          return new Uint8Array(1);
        },
      }), "invalid-archive");
  });
  it("retains and deduplicates the opening ledger across later reads", async () => {
    const ledger = createArchiveLedger({ maxOutputBytes: 5 });
    const data = await openParquet(source(fixture().bytes), { ledger });
    await data.read(0, { length: 1, ledger });
    expect(ledger.inspect().outputBytes).toBe(5);
    await refusal(() => data.read(0, { length: 1 }), "budget-exceeded");
  });
  it("stops after the first foreign reservation abort and never invokes the next owner or source", async () => {
    const controller = new AbortController(), sentinel = new Error("reserve abort"), bytes = fixture().bytes;
    let calls = 0;
    const next: string[] = [];
    const first = createArchiveLedger(), later = createArchiveLedger();
    const data = await openParquet(source(bytes, () => calls++), {
      signal: controller.signal,
      ledger: {
        reserve(kind, count) {
          first.reserve(kind, count);
          if (kind === "outputBytes") controller.abort(sentinel);
        },
        inspect: () => first.inspect(),
      },
    });
    const before = calls;
    await expect(data.read(0, {
      length: 0,
      ledger: {
        reserve(kind, count) {
          next.push(kind);
          later.reserve(kind, count);
        },
        inspect: () => later.inspect(),
      },
    })).rejects.toBe(sentinel);
    expect(next.length).toBeGreaterThan(0);
    // Earlier dimensions are legitimately admitted; the output callback abort
    // must stop the additional owner's corresponding output reservation.
    expect(later.inspect().outputBytes).toBe(0);
    expect(next).not.toContain("outputBytes");
    expect(calls).toBe(before);
  });
  it("retains original cancellation for empty selections and original provider failure identity", async () => {
    const controller = new AbortController(), reason = new Error("opening abort");
    const data = await openParquet(source(fixture().bytes), { signal: controller.signal });
    controller.abort(reason);
    await expect(data.read(0, { length: 0 })).rejects.toBe(reason);
    const fault = new Error("provider fault");
    await expect(openParquet({ size: 16, stability: "caller", read: () => Promise.reject(fault) })).rejects.toBe(fault);
  });
  it("requires truthful stability and treats literal Unicode/BOM names without normalization", async () => {
    const bytes = fixture({ name: "\ufeffcafé" }).bytes;
    expect((await openParquet(source(bytes))).columns[0]!.name).toBe("\ufeffcafé");
    await refusal(() => openParquet({ size: bytes.length, read: source(bytes).read }), "unsupported-profile");
    await expect(openParquet({ ...source(bytes), stability: "unknown" as "caller" })).rejects.toBeInstanceOf(TypeError);
  });
});
