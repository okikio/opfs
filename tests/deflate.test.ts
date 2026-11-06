/** Native zlib originals and authored framing controls for the private shared RFC1951 core. */
import { describe, it } from "node:test";
import { Buffer } from "node:buffer";
import { constants, deflateRawSync, inflateRawSync } from "node:zlib";
import { expect } from "@std/expect";
import { readDeflate } from "../src/archive/deflate.ts";
import { readMszip } from "../src/archive/mszip.ts";

const empty = new Uint8Array();
/** Authored LSB-first integer fields; Huffman code integers below are explicitly bit-reversed. */
function bits(fields: readonly (readonly [number, number])[]): Uint8Array {
  const length = fields.reduce((total, field) => total + field[1], 0), output = new Uint8Array(Math.ceil(length / 8));
  let at = 0;
  for (const [value, width] of fields) {
    for (let bit = 0; bit < width; bit++, at++) output[at >>> 3]! |= (value >>> bit & 1) << (at & 7);
  }
  return output;
}
/** Undefined and null are real reasons, so failure presence is separate from the captured value. */
function exactFailure(action: () => unknown, reason: unknown): void {
  let failed = false, actual: unknown;
  try {
    action();
  } catch (error) {
    failed = true;
    actual = error;
  }
  expect(failed).toBe(true);
  expect(actual).toBe(reason);
}

describe("bounded shared raw DEFLATE", () => {
  it("matches native zlib complete bytes at zero, 32 KiB and 64 KiB profile boundaries", () => {
    for (const length of [0, 32768, 32769, 65536]) {
      const original = Buffer.from(Array.from({ length }, (_, index) => index % 37));
      for (const strategy of [constants.Z_DEFAULT_STRATEGY, constants.Z_FIXED]) {
        const packed = deflateRawSync(original, { level: 6, strategy });
        expect(inflateRawSync(packed)).toEqual(original);
        const output = readDeflate(packed, length, empty);
        expect(output).toEqual(new Uint8Array(original));
        expect(output.buffer).not.toBe(packed.buffer);
      }
    }
    expect(() => readDeflate(new Uint8Array([3, 0]), 65537, empty)).toThrow();
    expect(() => readDeflate(new Uint8Array(65537), 0, empty)).toThrow();
    expect(() => readDeflate(new Uint8Array([3, 0]), 0, new Uint8Array(32769))).toThrow();
  });

  it("requires exact termination while accepting legal final-byte and stored-header padding", () => {
    const fixed = new Uint8Array([0x73, 0x04, 0x00]);
    const padded = new Uint8Array([0x73, 0x04, 0xfc]);
    const stored = new Uint8Array([0xf9, 1, 0, 254, 255, 65]);
    for (const packed of [fixed, padded, stored]) {
      expect(inflateRawSync(packed)).toEqual(Buffer.from("A"));
      expect(readDeflate(packed, 1, empty)).toEqual(new Uint8Array([65]));
      for (let length = 0; length < packed.length; length++) {
        expect(() => readDeflate(packed.subarray(0, length), 1, empty)).toThrow();
      }
      for (const suffix of [[0], [255], [3, 0], [...fixed]]) {
        expect(() => readDeflate(new Uint8Array([...packed, ...suffix]), 1, empty)).toThrow();
      }
      expect(() => readDeflate(packed, 0, empty)).toThrow();
      expect(() => readDeflate(packed, 2, empty)).toThrow();
    }
    expect(readDeflate(new Uint8Array([3, 0]), 0, empty)).toEqual(empty);
    expect(() => readDeflate(new Uint8Array(), 0, empty)).toThrow();
  });

  it("borrows at most 32 KiB of explicit history and handles overlapping matches beyond 32 KiB output", () => {
    const packed = bits([[1, 1], [1, 2], [64, 7], [23, 5], [8191, 13], [0, 7]]);
    const history = new Uint8Array(32768);
    history.set([12, 34, 56]);
    const before = history.slice();
    expect(readDeflate(packed, 3, history)).toEqual(new Uint8Array([12, 34, 56]));
    // Node's independent dictionary readback is a separate oracle test: Deno's zlib shim rejects this valid distance.
    expect(history).toEqual(before);
    expect(() => readDeflate(packed, 3, empty)).toThrow();
    expect(() => readDeflate(packed, 3, history.subarray(1))).toThrow();
    const original = Buffer.from("A".repeat(65536)), repeated = deflateRawSync(original);
    expect(readDeflate(repeated, original.length, empty)).toEqual(new Uint8Array(original));
  });

  it("admits empty blocks before decoding and preserves exact budget or cancellation reasons", () => {
    // Nonfinal empty stored block, followed by a final stored literal A.
    const packed = new Uint8Array([0, 0, 0, 255, 255, 1, 1, 0, 254, 255, 65]);
    let admitted = 0;
    expect(readDeflate(packed, 1, empty, undefined, () => {
      admitted++;
    })).toEqual(new Uint8Array([65]));
    expect(admitted).toBe(2);
    for (const reason of [undefined, null, new Error("authored block budget")]) {
      let attempts = 0;
      exactFailure(() =>
        readDeflate(packed, 1, empty, undefined, () => {
          attempts++;
          throw reason;
        }), reason);
      expect(attempts).toBe(1);
    }
    const abort = new AbortController(), reason = new Error("authored decode abort");
    abort.abort(reason);
    let entered = false;
    exactFailure(() =>
      readDeflate(packed, 1, empty, abort.signal, () => {
        entered = true;
      }), reason);
    expect(entered).toBe(false);
    const during = new AbortController();
    exactFailure(() =>
      readDeflate(packed, 1, empty, during.signal, () => {
        during.abort(reason);
      }), reason);
  });

  it("keeps the CK wrapper's existing positive-size, compressed-extent and 32 KiB limits", () => {
    const raw = new Uint8Array([3, 0]), ck = new Uint8Array([67, 75, ...raw]);
    expect(readDeflate(raw, 0, empty)).toEqual(empty);
    expect(() => readMszip(ck, 0, empty)).toThrow();
    expect(() => readMszip(new Uint8Array([67, 75]), 1, empty)).toThrow();
    const original = Buffer.from("A".repeat(32769)), packed = deflateRawSync(original);
    expect(readDeflate(packed, original.length, empty)).toEqual(new Uint8Array(original));
    expect(() => readMszip(new Uint8Array([67, 75, ...packed]), original.length, empty)).toThrow();
    expect(() => readMszip(new Uint8Array(32781), 1, empty)).toThrow();
  });
});
