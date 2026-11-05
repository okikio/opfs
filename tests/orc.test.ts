import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import native from "./fixtures/orc/independent.json" with { type: "json" };
import { createArchiveLedger, openOrc } from "../src/dataset/orc.ts";
import type { OrcValuesType } from "../src/dataset/orc.ts";
import type { ByteSourceType } from "../src/source.ts";

function array(values: OrcValuesType): (number | bigint)[] {
  return [...values];
}

// These are authored grammar controls, not independent native interoperability proof.
function cat(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}
function uint(input: number | bigint): Uint8Array {
  let value = BigInt(input);
  const result: number[] = [];
  do {
    result.push(Number(value & 127n) | (value > 127n ? 128 : 0));
    value >>= 7n;
  } while (value);
  return Uint8Array.from(result);
}
function number(id: number, value: number | bigint): Uint8Array {
  return cat(uint(id * 8), uint(value));
}
function binary(id: number, bytes: Uint8Array): Uint8Array {
  return cat(uint(id * 8 + 2), uint(bytes.length), bytes);
}
function text(id: number, value: string): Uint8Array {
  return binary(id, new TextEncoder().encode(value));
}
function signed(value: bigint): Uint8Array {
  return uint(value >= 0n ? value * 2n : -value * 2n - 1n);
}
function bytesLiteral(bytes: Uint8Array): Uint8Array {
  return cat(Uint8Array.of(256 - bytes.length), bytes);
}
function fixture(
  options: {
    omitData?: boolean;
    kind?: number;
    encoding?: number;
    basis?: "body" | "header-and-body";
    compression?: number;
    footerExtra?: Uint8Array;
    stripeExtra?: Uint8Array;
    name?: string;
    data?: Uint8Array;
    present?: Uint8Array;
    rows?: number;
    gap?: number;
  } = {},
) {
  const kind = options.kind ?? 3, rows = options.rows ?? 4;
  const data = options.omitData
    ? new Uint8Array()
    : options.data ?? cat(Uint8Array.of(252), ...[1n, -2n, 3n, 4n].map(signed));
  const present = options.present;
  const stream = (kind: number, length: number) => binary(1, cat(number(1, kind), number(2, 1), number(3, length)));
  const stripeFooter = cat(
    ...(present ? [stream(0, present.length)] : []),
    ...(options.omitData ? [] : [stream(1, data.length)]),
    binary(2, number(1, 0)),
    binary(2, number(1, options.encoding ?? 0)),
    options.stripeExtra ?? new Uint8Array(),
  );
  const gap = new Uint8Array(options.gap ?? 0), body = cat(gap, present ?? new Uint8Array(), data, stripeFooter);
  const stripe = cat(
    number(1, 3 + gap.length),
    number(2, 0),
    number(3, data.length + (present?.length ?? 0)),
    number(4, stripeFooter.length),
    number(5, rows),
  );
  const footer = cat(
    number(1, 3),
    number(2, body.length + (options.basis === "header-and-body" ? 3 : 0)),
    binary(3, stripe),
    binary(4, cat(number(1, 12), binary(2, uint(1)), text(3, options.name ?? "value"))),
    binary(4, number(1, kind)),
    number(6, rows),
    options.footerExtra ?? new Uint8Array(),
  );
  const post = cat(
    number(1, footer.length),
    number(2, options.compression ?? 0),
    binary(4, Uint8Array.of(0, 11)),
    number(5, 0),
    text(8000, "ORC"),
  );
  return cat(new TextEncoder().encode("ORC"), body, footer, post, Uint8Array.of(post.length));
}
function source(bytes: Uint8Array, onRead?: (offset: number, length: number) => void): ByteSourceType {
  return {
    size: bytes.length,
    stability: "caller",
    read(offset, length) {
      onRead?.(offset, length);
      return Promise.resolve(bytes.slice(offset, offset + length));
    },
  };
}

describe("bounded ORC physical numeric preview", () => {
  it("returns exact signed values, owned ranges, validity and explicit no-checksum evidence", async () => {
    const dataset = await openOrc(source(fixture()));
    const full = await dataset.read(1);
    expect(full.values).toBeInstanceOf(Int32Array);
    expect(array(full.values)).toEqual([1, -2, 3, 4]);
    expect(Array.from(full.validity)).toEqual([1, 1, 1, 1]);
    expect(full.integrity).toBe("none");
    const prefix = await dataset.read(1, { offset: 1, length: 2 });
    expect(array(prefix.values)).toEqual([-2, 3]);
    expect(prefix.stripes[0]?.rows).toBe(4);
    expect(dataset.work).not.toEqual(full.work);
  });
  it("observes the two exact footer content conventions without accepting physical gaps", async () => {
    expect((await openOrc(source(fixture()))).contentLengthBasis).toBe("body");
    expect((await openOrc(source(fixture({ basis: "header-and-body" })))).contentLengthBasis).toBe("header-and-body");
    await expect(openOrc(source(fixture({ gap: 1 })))).rejects.toThrow(/padding/);
  });
  it("decodes PRESENT MSB-first, returning a separate mask and zero null slots", async () => {
    const data = cat(Uint8Array.of(254), signed(7n), signed(-9n));
    const dataset = await openOrc(source(fixture({ data, present: bytesLiteral(Uint8Array.of(0xa0)) })));
    const read = await dataset.read(1);
    expect(array(read.values)).toEqual([7, 0, -9, 0]);
    expect(Array.from(read.validity)).toEqual([1, 0, 1, 0]);
  });
  it("decodes repeated byte runs and integer delta runs using the primary grammar", async () => {
    const byte = await openOrc(source(fixture({ kind: 1, rows: 5, data: Uint8Array.of(2, 0xfe) })));
    expect(array((await byte.read(1)).values)).toEqual([-2, -2, -2, -2, -2]);
    const ints = await openOrc(source(fixture({ rows: 5, data: cat(Uint8Array.of(2, 0xff), signed(9n)) })));
    expect(array((await ints.read(1)).values)).toEqual([9, 8, 7, 6, 5]);
  });
  it("preserves exact LONG and little-endian IEEE values", async () => {
    const large = (1n << 62n) + 17n;
    const longs = await openOrc(source(fixture({ kind: 4, rows: 1, data: cat(Uint8Array.of(255), signed(large)) })));
    expect(array((await longs.read(1)).values)).toEqual([large]);
    const data = new Uint8Array(16), view = new DataView(data.buffer);
    view.setFloat64(0, -0, true);
    view.setFloat64(8, Number.NaN, true);
    const floats = await openOrc(source(fixture({ kind: 6, rows: 2, data })));
    const read = await floats.read(1);
    expect(Object.is(read.values[0], -0)).toBe(true);
    expect(Number.isNaN(read.values[1])).toBe(true);
  });
  it("refuses compression, DIRECT_V2, nested encryption presence and malformed terminals", async () => {
    await expect(openOrc(source(fixture({ compression: 1 })))).rejects.toThrow(/compression/);
    const v2 = await openOrc(source(fixture({ encoding: 2 })));
    await expect(v2.read(1)).rejects.toThrow(/RLEv2/);
    await expect(
      openOrc(source(fixture({ footerExtra: cat(binary(10, Uint8Array.of(8, 1)), binary(10, new Uint8Array())) }))),
    ).rejects.toThrow(/encrypted/);
    const bad = await openOrc(source(fixture({ data: Uint8Array.of(252, 2) })));
    await expect(bad.read(1)).rejects.toThrow(/truncated/);
    const extra = await openOrc(source(fixture({ data: Uint8Array.of(1, 2, 0, 0) })));
    await expect(extra.read(1)).rejects.toThrow(/excess/);
  });
  it("keeps opening and additional ledgers authoritative and deduplicates identical owners", async () => {
    const ledger = createArchiveLedger({ maxOutputBytes: 20 });
    const dataset = await openOrc(source(fixture()), { ledger });
    await dataset.read(1, { ledger });
    expect(ledger.inspect().outputBytes).toBe(20);
    await expect(dataset.read(1, { length: 1 })).rejects.toMatchObject({ code: "budget-exceeded" });
    const other = createArchiveLedger({ maxOutputBytes: 0 });
    await expect((await openOrc(source(fixture()))).read(1, { ledger: other })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
  });
  it("keeps opening abort authority and stops after each foreign reservation", async () => {
    const abort = new AbortController();
    let reads = 0;
    const dataset = await openOrc(source(fixture(), () => reads++), { signal: abort.signal });
    const before = reads;
    abort.abort(new Error("original abort"));
    await expect(dataset.read(1, { signal: new AbortController().signal })).rejects.toThrow("original abort");
    expect(reads).toBe(before);
    const second = new AbortController();
    let effects = 0;
    const backing = createArchiveLedger();
    await expect(openOrc(source(fixture(), () => effects++), {
      signal: second.signal,
      ledger: {
        inspect: backing.inspect,
        reserve() {
          second.abort(new Error("reservation abort"));
        },
      },
    })).rejects.toThrow("reservation abort");
    expect(effects).toBe(0);
  });
  it("captures source and option descriptors before the first await, preserving literal BOM names", async () => {
    const bytes = fixture({ name: "\ufeffvalue" }), input = source(bytes);
    const options = { maxRows: 1 };
    const pending = openOrc(input, options);
    input.read = () => Promise.reject(new Error("replaced source"));
    options.maxRows = 100;
    const dataset = await pending;
    expect(dataset.columns[0]?.name).toBe("\ufeffvalue");
    await expect(dataset.read(1)).rejects.toThrow(/Returned row/);
    expect(array((await dataset.read(1, { length: 1 })).values)).toEqual([1]);
  });
  it("admits output and known row work before acquiring selected bodies", async () => {
    const requests: [number, number][] = [];
    const dataset = await openOrc(source(fixture(), (offset, length) => requests.push([offset, length])));
    requests.length = 0;
    await expect(dataset.read(1, { maxOutputBytes: 0 })).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(requests.length).toBe(1); // Only stripe footer; no selected DATA body.
    expect(requests[0]?.[0]).toBeGreaterThan(3);
    const empty = await dataset.read(1, { offset: 4, length: 0 });
    expect(empty.values.length).toBe(0);
    expect(empty.stripes.length).toBe(0);
  });
  it("copies borrowed scratch ranges before later source calls reuse them", async () => {
    const bytes = fixture(), scratch = new Uint8Array(bytes.length);
    const input: ByteSourceType = {
      size: bytes.length,
      stability: "caller",
      read(offset, length) {
        scratch.fill(0xee);
        scratch.set(bytes.subarray(offset, offset + length));
        return Promise.resolve(scratch.subarray(0, length));
      },
    };
    const dataset = await openOrc(input);
    expect(array((await dataset.read(1)).values)).toEqual([1, -2, 3, 4]);
    const first = await dataset.read(1);
    await dataset.read(1);
    expect(array(first.values)).toEqual([1, -2, 3, 4]);
  });
  it("stops later foreign owners when an opening reservation aborts a read", async () => {
    const abort = new AbortController(), backing = createArchiveLedger();
    let armed = false, later = 0, io = 0;
    const dataset = await openOrc(source(fixture(), () => io++), {
      signal: abort.signal,
      ledger: {
        inspect: backing.inspect,
        reserve(kind, count) {
          if (armed) abort.abort(new Error("owner abort"));
          else backing.reserve(kind, count);
        },
      },
    });
    armed = true;
    const before = io;
    await expect(dataset.read(1, {
      ledger: {
        inspect: backing.inspect,
        reserve() {
          later++;
        },
      },
    })).rejects.toThrow("owner abort");
    expect(later).toBe(0);
    expect(io).toBe(before);
  });
  it("bounds footer metadata, expanded work, and exact source authority separately", async () => {
    await expect(openOrc(source(fixture()), { maxFooterBytes: 1 })).rejects.toThrow(/footer byte/);
    await expect(openOrc(source(fixture()), { maxRetainedMetadataBytes: 0 })).rejects.toThrow(/Retained metadata/);
    const narrow = await openOrc(source(fixture()), { maxSelectedStreamBytes: 1 });
    await expect(narrow.read(1, { length: 1 })).rejects.toThrow(/Selected stream byte/);
    const { stability: _stability, ...unknown } = source(fixture());
    await expect(openOrc(unknown)).rejects.toThrow(/stable replay/);
    expect((await openOrc(unknown, { allowUnverifiedSource: true })).rows).toBe(4);
    await expect(openOrc({ ...source(fixture()), identity: "x".repeat(8193) })).rejects.toThrow(/bounded string/);
  });

  it("uses scalar last-wins while refusing any encrypted message instance", async () => {
    const dataset = await openOrc(source(fixture({ footerExtra: cat(number(6, 99), number(6, 4)) })));
    expect(dataset.rows).toBe(4);
    const encrypted = await openOrc(
      source(fixture({ stripeExtra: cat(binary(4, Uint8Array.of(8, 1)), binary(4, new Uint8Array())) })),
    );
    await expect(encrypted.read(1)).rejects.toThrow(/encrypted stripe/);
    await expect(openOrc(source(fixture({ footerExtra: Uint8Array.of(0) })))).rejects.toThrow(/tag/);
    await expect(openOrc(source(fixture({ footerExtra: Uint8Array.of(0x0a, 1, 0) })))).rejects.toThrow(/wire type/);
  });
  it("handles all-null columns and rejects unused encoded values", async () => {
    const dataset = await openOrc(source(fixture({ data: new Uint8Array(), present: bytesLiteral(Uint8Array.of(0)) })));
    const read = await dataset.read(1);
    expect(array(read.values)).toEqual([0, 0, 0, 0]);
    expect(Array.from(read.validity)).toEqual([0, 0, 0, 0]);
    const excess = await openOrc(
      source(fixture({ data: Uint8Array.of(255, 2), present: bytesLiteral(Uint8Array.of(0)) })),
    );
    await expect(excess.read(1)).rejects.toThrow(/excess/);
  });

  it("accepts absent DATA only when complete PRESENT decoding establishes no values", async () => {
    const allNull = await openOrc(source(fixture({ omitData: true, present: bytesLiteral(Uint8Array.of(0)) })));
    expect(Array.from((await allNull.read(1)).validity)).toEqual([0, 0, 0, 0]);
    const missing = await openOrc(source(fixture({ omitData: true, present: bytesLiteral(Uint8Array.of(0x80)) })));
    await expect(missing.read(1)).rejects.toThrow(/truncated/);
  });
  it("observes late source cancellation before copying the borrowed selected body", async () => {
    const abort = new AbortController(), bytes = fixture();
    let armed = false, bodyCopies = 0;
    class Borrowed extends Uint8Array {
      override slice(start?: number, end?: number): Uint8Array<ArrayBuffer> {
        bodyCopies++;
        return super.slice(start, end);
      }
    }
    const input: ByteSourceType = {
      size: bytes.length,
      stability: "caller",
      read(offset, length) {
        const result = bytes.slice(offset, offset + length);
        if (armed && offset === 3) {
          const borrowed = new Borrowed(result);
          return Promise.resolve().then(() => {
            abort.abort(new Error("late provider abort"));
            return borrowed;
          });
        }
        return Promise.resolve(result);
      },
    };
    const dataset = await openOrc(input, { signal: abort.signal });
    armed = true;
    await expect(dataset.read(1)).rejects.toThrow("late provider abort");
    expect(bodyCopies).toBe(0);
  });
});

/** Read the independent original-value bytes, not a re-encoding of candidate output. */
function expectedValue(name: string, bytes: Uint8Array, row: number): number | bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (name) {
    case "b":
      return view.getUint8(row);
    case "y":
      return view.getInt8(row);
    case "s":
      return view.getInt16(row * 2, true);
    case "i":
      return view.getInt32(row * 4, true);
    case "q":
      return view.getBigInt64(row * 8, true);
    case "f":
      return view.getFloat32(row * 4, true);
    case "d":
      return view.getFloat64(row * 8, true);
    default:
      throw new Error("Unknown native oracle column");
  }
}

describe("genuine PyArrow ORC wire versus independent original arrays", () => {
  for (const fixture of native.fixtures) {
    it(fixture.name + " full originals and cross-stripe preview", async () => {
      const bytes = decodeBase64(fixture.file.base64), dataset = await openOrc(source(bytes));
      expect(bytes.length).toBe(fixture.file.bytes);
      expect(dataset.rows).toBe(fixture.rows);
      expect(dataset.formatVersion).toBe(fixture.fileVersion);
      expect(dataset.contentLengthBasis).toBe(fixture.contentLengthBasis);
      expect(dataset.stripes.length).toBe(fixture.stripes.length);
      expect(dataset.columns.length).toBe(7);
      for (const column of fixture.columns) {
        const declared = dataset.columns.find((candidate) => candidate.name === column.name);
        if (!declared) throw new Error("Native original column is absent from candidate index");
        const original = decodeBase64(column.physicalLittleEndian.base64);
        const mask = decodeBase64(column.validity.base64);
        if (fixture.rows !== 0 && fixture.fileVersion === "0.12" && ["s", "i", "q"].includes(column.name)) {
          await expect(dataset.read(declared.id)).rejects.toMatchObject({ code: "unsupported-profile" });
          continue;
        }
        const full = await dataset.read(declared.id);
        const constructor = column.name === "b"
          ? Uint8Array
          : column.name === "y"
          ? Int8Array
          : column.name === "s"
          ? Int16Array
          : column.name === "i"
          ? Int32Array
          : column.name === "q"
          ? BigInt64Array
          : column.name === "f"
          ? Float32Array
          : column.name === "d"
          ? Float64Array
          : undefined;
        if (!constructor) throw new Error("Unknown native oracle constructor");
        expect(full.values).toBeInstanceOf(constructor);
        expect(full.values.length).toBe(fixture.rows);
        expect(full.validity).toEqual(mask);
        expect(full.integrity).toBe("none");
        for (let row = 0; row < fixture.rows; row++) {
          expect(Object.is(full.values[row], expectedValue(column.name, original, row))).toBe(true);
        }
        const offset = fixture.rows > 256 ? 253 : Math.min(fixture.rows, 1);
        const length = Math.min(fixture.rows - offset, 7);
        const selected = await dataset.read(declared.id, { offset, length });
        expect(selected.validity).toEqual(mask.slice(offset, offset + length));
        for (let row = 0; row < length; row++) {
          expect(Object.is(selected.values[row], expectedValue(column.name, original, row + offset))).toBe(true);
        }
        if (fixture.rows > 256 && fixture.nulls !== "all") expect(selected.stripes.length).toBe(2);
      }
    });
  }
});
