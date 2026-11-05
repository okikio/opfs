import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import type { ByteSourceType } from "../src/source.ts";
import { createArchiveLedger, openFits } from "../src/dataset/fits.ts";
import fixture from "./fixtures/fits/independent.json" with { type: "json" };

const source = (bytes: Uint8Array) => createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
const card = (key: string, value?: string) =>
  (key.padEnd(8) + (value === undefined ? "" : "= " + value.padStart(20))).padEnd(80);
/** Authored controls are not the independent native interoperability oracle. */
function file(
  options: { bitpix?: number; axes?: number[]; extra?: string[]; body?: Uint8Array; extension?: string } = {},
): Uint8Array {
  const axes = options.axes ?? [4];
  const cards = [
    card(options.extension ? "XTENSION" : "SIMPLE", options.extension ? `'${options.extension}'` : "T"),
    card("BITPIX", String(options.bitpix ?? 16)),
    card("NAXIS", String(axes.length)),
    ...axes.map((axis, index) => card(`NAXIS${index + 1}`, String(axis))),
    ...(options.extension ? [card("PCOUNT", "0"), card("GCOUNT", "1")] : []),
    ...(options.extra ?? []),
    card("END"),
  ];
  const header = cards.join("").padEnd(Math.ceil(cards.length / 36) * 2880);
  const body = options.body ??
    new Uint8Array(axes.reduce((n, axis) => n * axis, axes.length ? 1 : 0) * Math.abs(options.bitpix ?? 16) / 8);
  const bytes = new Uint8Array(header.length + Math.ceil(body.length / 2880) * 2880);
  bytes.set(new TextEncoder().encode(header));
  bytes.set(body, header.length);
  return bytes;
}
function setCard(bytes: Uint8Array, index: number, text: string): void {
  bytes.set(new TextEncoder().encode(text), index * 80);
}
const asBytes = (array: ArrayBufferView) => new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
/** Full numeric fixtures must not turn a mismatch into a megabyte assertion diff. */
function sameBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  for (let index = 0; index < actual.length; index++) {
    if (actual[index] !== expected[index]) {
      throw new Error(`Numeric oracle byte ${index}: ${actual[index]} differs from ${expected[index]}.`);
    }
  }
}

describe("bounded FITS numeric preview", () => {
  it("reads every native Astropy/CFITSIO HDU as exact typed raw bytes and verifies complete checksum scopes", async () => {
    expect(fixture.byteorder).toBe("little");
    expect(new Uint8Array(new Uint16Array([1]).buffer)[0]).toBe(1);
    for (const original of fixture.fixtures) {
      const dataset = await openFits(source(decodeBase64(original.file.base64)));
      expect(dataset.hdus.length).toBe(original.images.length);
      for (const image of original.images) {
        const hdu = dataset.hdus[image.id]!;
        expect(hdu.bitpix).toBe(image.bitpix);
        expect(hdu.axes).toEqual(image.axes);
        const result = await dataset.read(image.id);
        sameBytes(asBytes(result.values), decodeBase64(image.nativeLittleEndian.base64));
        expect(result.work.sourceBytes).toBe(hdu.dataBytes);
        expect(result.work.outputBytes).toBe(result.values.byteLength + result.undefinedMask.length);
        expect(result.integrity).toBe("pending");
        if (image.physicalLittleEndian) {
          const physical = await dataset.read(image.id, { scale: "physical" });
          sameBytes(asBytes(physical.values), decodeBase64(image.physicalLittleEndian.base64));
        }
        const proof = await dataset.verify(image.id);
        expect(proof.datasum).toBe("verified");
        expect(proof.checksum).toBe("verified");
        expect(proof.work.sourceBytes).toBe(hdu.headerBytes + hdu.paddedDataBytes);
      }
    }
  });
  it("keeps FITS axis order, exact int64, BLANK before scaling, NaN masks, infinities and signed zero", async () => {
    const original = fixture.fixtures.find((item) => item.producer === "astropy")!;
    const dataset = await openFits(source(decodeBase64(original.file.base64)));
    expect(dataset.hdus[0]!.axes).toEqual([4, 3]);
    expect((await dataset.read(0, { offset: 3, count: 3 })).values).toEqual(Uint8Array.of(3, 4, 5));
    const raw = await dataset.read(1), scaled = await dataset.read(1, { scale: "physical" });
    expect(raw.values).toEqual(Int16Array.of(-32768, -2, 0, 32767));
    expect(raw.undefinedMask).toEqual(Uint8Array.of(1, 0, 0, 0));
    expect(scaled.values).toEqual(Float64Array.of(-32768, 32764, 32768, 98302));
    expect(scaled.undefinedMask).toEqual(raw.undefinedMask);
    expect(dataset.hdus[1]!.unit).toBe("adu");
    expect((await dataset.read(3)).values).toEqual(
      BigInt64Array.of(-9007199254740993n, 9007199254740993n, 9223372036854775807n),
    );
    await expect(dataset.read(3, { scale: "physical" })).rejects.toMatchObject({ code: "unsupported-profile" });
    for (const id of [4, 5]) {
      const result = await dataset.read(id);
      expect(result.undefinedMask).toEqual(Uint8Array.of(0, 0, 1, 0, 0, 0));
      expect(Object.is(result.values[1], -0)).toBe(true);
      expect(result.values[3]).toBe(Infinity);
    }
    // Scaling can create NaN/Infinity; only source undefined values set the mask.
    const control = file({
      bitpix: -64,
      axes: [2],
      body: new Uint8Array(new Float64Array([0, 1]).buffer).reverse(),
      extra: [card("BSCALE", "1.0E308"), card("BZERO", "1.0E308")],
    });
    const floats = new DataView(control.buffer, 2880);
    floats.setFloat64(0, 1, false);
    floats.setFloat64(8, 2, false);
    const overflow = await (await openFits(source(control))).read(0, { scale: "physical" });
    expect(overflow.values[0]).toBe(Infinity);
    expect(overflow.undefinedMask).toEqual(Uint8Array.of(0, 0));
    const notMissing = file({ bitpix: -64, axes: [1], extra: [card("BSCALE", "0")] });
    new DataView(notMissing.buffer, 2880).setFloat64(0, Infinity, false);
    const scaledNaN = await (await openFits(source(notMissing))).read(0, { scale: "physical" });
    expect(Number.isNaN(scaledNaN.values[0])).toBe(true);
    expect(scaledNaN.undefinedMask[0]).toBe(0);
  });
  it("reads only the selected element extent and gives no unrelated image checksum authority", async () => {
    const original = fixture.fixtures.find((item) => item.producer === "astropy")!;
    const bytes = decodeBase64(original.file.base64), base = source(bytes), calls: number[][] = [];
    const dataset = await openFits({
      ...base,
      async read(offset, length, options) {
        calls.push([offset, length]);
        return await base.read(offset, length, options);
      },
    });
    calls.length = 0;
    const selected = await dataset.read(7, { offset: 100003, count: 2 });
    expect(calls).toEqual([[dataset.hdus[7]!.dataOffset + 200006, 4]]);
    expect(selected.work.requests).toBe(1);
    expect(selected.integrity).toBe("pending");
    calls.length = 0;
    expect((await dataset.read(7, { offset: 0, count: 0 })).values.length).toBe(0);
    expect(calls).toEqual([]);
  });
  it("detects payload, data padding and header checksum corruption only in explicit full-HDU verification", async () => {
    const original = fixture.fixtures.find((item) => item.producer === "astropy")!;
    const originalBytes = decodeBase64(original.file.base64), index = await openFits(source(originalBytes));
    for (const at of [index.hdus[0]!.dataOffset, index.hdus[0]!.dataOffset + index.hdus[0]!.dataBytes, 40 * 80 + 20]) {
      const bytes = originalBytes.slice();
      bytes[at] = bytes[at]! ^ 1;
      const dataset = await openFits(source(bytes));
      expect((await dataset.read(0, { count: 1 })).integrity).toBe("pending");
      await expect(dataset.verify(0)).rejects.toMatchObject({ code: "checksum-mismatch" });
      expect((await dataset.verify(1)).checksum).toBe("verified");
    }
    const noProof = await openFits(source(file()));
    expect((await noProof.read(0)).integrity).toBe("not-provided");
    expect(await noProof.verify(0)).toMatchObject({ checksum: "not-provided", datasum: "not-provided" });
    const padded = await openFits(source(file({ extra: [card("DATASUM", "' 0000000000000000000000 '")] })));
    expect((await padded.verify(0)).datasum).toBe("verified");
    const blank = await openFits(source(file({ extra: [card("DATASUM", "'   '"), card("CHECKSUM", "' '")] })));
    expect(await blank.verify(0)).toMatchObject({ checksum: "not-provided", datasum: "not-provided" });
  });
  it("rejects malformed framing, mandatory fields, exact arithmetic and unsupported extension semantics", async () => {
    const controls: Uint8Array[] = [];
    const unordered = file();
    setCard(unordered, 1, card("NAXIS", "1"));
    controls.push(unordered);
    const end = file();
    end[5 * 80] = 65;
    controls.push(end);
    const fill = file();
    fill[6 * 80] = 65;
    controls.push(fill);
    controls.push(file({ extra: [card("BITPIX", "16")] }));
    controls.push(file({ extra: [card("BLANK", "32768")] }));
    controls.push(file({ bitpix: -32, extra: [card("BLANK", "0")] }));
    controls.push(file({ extra: [card("DATASUM", "'4294967296'")] }));
    const unsafe = file();
    setCard(unsafe, 3, card("NAXIS1", "9007199254740993"));
    controls.push(unsafe);
    controls.push(file().slice(0, -1));
    for (const bytes of controls) await expect(openFits(source(bytes))).rejects.toBeInstanceOf(Error);
    for (const extra of [[card("GROUPS", "T")], [card("INHERIT", "T")], [card("BUNIT", "'long&'")]]) {
      await expect(openFits(source(file({ extra })))).rejects.toMatchObject({ code: "unsupported-profile" });
    }
    const primary = file({ axes: [] }), table = file({ extension: "BINTABLE" });
    const joined = new Uint8Array(primary.length + table.length);
    joined.set(primary);
    joined.set(table, primary.length);
    await expect(openFits(source(joined))).rejects.toMatchObject({ code: "unsupported-profile" });
  });
  it("retains opening and additional budgets, admits known cost before I/O and does not charge the same external ledger twice", async () => {
    const base = source(file()), calls: number[][] = [];
    const tracked = {
      ...base,
      async read(offset: number, length: number, options?: { signal?: AbortSignal }) {
        calls.push([offset, length]);
        return await base.read(offset, length, options);
      },
    };
    for (const dimension of ["maxSourceBytes", "maxRequests"] as const) {
      const ledger = createArchiveLedger({ [dimension]: dimension === "maxSourceBytes" ? 2880 : 1 });
      const dataset = await openFits(tracked, { ledger });
      calls.length = 0;
      await expect(dataset.read(0, { count: 1 })).rejects.toMatchObject({ code: "budget-exceeded" });
      expect(calls.length).toBe(0);
    }
    const ledger = createArchiveLedger({ maxSourceBytes: 2882, maxRequests: 2 });
    const dataset = await openFits(tracked, { ledger });
    calls.length = 0;
    const result = await dataset.read(0, { count: 1, ledger });
    expect(result.work.sourceBytes).toBe(2);
    expect(ledger.inspect().sourceBytes).toBe(2882);
    const additional = createArchiveLedger({ maxSourceBytes: 0 });
    await expect((await openFits(tracked)).read(0, { count: 1, ledger: additional })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    calls.length = 0;
    await expect((await openFits(tracked)).read(0, { count: 1, maxOutputBytes: 2 })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    expect(calls.length).toBe(1); // Only the preceding open read its header.
    await expect(openFits(base, { maxHdus: 0 })).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect(openFits(base, { maxHeaderBytes: 2879 })).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect(openFits(base, { maxAxes: 0 })).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect((await openFits(base, { maxElements: 1 })).read(0, { count: 2 })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
  });
  it("captures source/options and retains parent abort for ordinary and empty selections", async () => {
    const bytes = file(), base = source(bytes), parent = new AbortController();
    const mutable = { ...base }, opts = { signal: parent.signal, maxElements: 4 };
    const pending = openFits(mutable, opts);
    mutable.read = async () => {
      throw new Error("mutated source must not run");
    };
    mutable.size = 0;
    opts.maxElements = 0;
    const dataset = await pending;
    expect((await dataset.read(0)).values.length).toBe(4);
    const reason = new Error("opening owner aborted");
    parent.abort(reason);
    for (const count of [0, 1]) await expect(dataset.read(0, { count })).rejects.toBe(reason);
    await expect(dataset.verify(0)).rejects.toBe(reason);
    const invalidSource = { ...base, stability: "invented" } as unknown as ByteSourceType;
    await expect(openFits(invalidSource)).rejects.toBeInstanceOf(TypeError);
    const unverified = { size: base.size, read: base.read };
    await expect(openFits(unverified)).rejects.toMatchObject({ code: "unsupported-profile" });
    expect((await openFits(unverified, { allowUnverifiedSource: true })).source.stability).toBe("unverified");
  });
  it("retains provider failures, refuses short extents and observes abort after source or final output admission", async () => {
    const base = source(file()), failure = new Error("provider read failed"), parent = new AbortController();
    let mode: "ok" | "reject" | "short" | "abort" = "ok";
    const dataset = await openFits({
      ...base,
      async read(offset, length, opts) {
        if (mode === "reject") {
          parent.abort(new Error("concurrent abort"));
          throw failure;
        }
        if (mode === "short") return new Uint8Array(length - 1);
        const result = await base.read(offset, length, opts);
        if (mode === "abort") parent.abort(failure);
        return result;
      },
    });
    mode = "short";
    await expect(dataset.read(0, { count: 1 })).rejects.toMatchObject({ code: "invalid-archive" });
    mode = "abort";
    await expect(dataset.read(0, { count: 1, signal: parent.signal })).rejects.toBe(failure);
    const another = new AbortController();
    mode = "reject";
    await expect(dataset.read(0, { count: 1, signal: another.signal })).rejects.toBe(failure);
    const terminal = new AbortController(), ledger = createArchiveLedger();
    const observed = await openFits(base, { signal: terminal.signal });
    const late = {
      inspect: ledger.inspect,
      reserve(kind: Parameters<typeof ledger.reserve>[0], count: number) {
        ledger.reserve(kind, count);
        if (kind === "outputBytes") terminal.abort(failure);
      },
    };
    await expect(observed.read(0, { count: 0, ledger: late })).rejects.toBe(failure);
  });
});
