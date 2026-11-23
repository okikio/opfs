/** Authored FlatBuffers grammar controls, independent of a candidate serializer. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { FlatBuffers } from "../src/dataset/arrow/flatbuffers.ts";
import { ArchiveError } from "../src/archive/record.ts";

/** Fixed physical table grammar: root@0, vtable@8, object@16, scalar fields@20/24. */
function table(): Uint8Array {
  const bytes = new Uint8Array(96), view = new DataView(bytes.buffer);
  view.setUint32(0, 16, true);
  view.setUint16(8, 8, true);
  view.setUint16(10, 16, true);
  view.setUint16(12, 4, true);
  view.setUint16(14, 8, true);
  view.setInt32(16, 8, true);
  view.setInt32(20, -123, true);
  view.setBigInt64(24, -9007199254740993n, true);
  return bytes;
}

function failure(operation: () => unknown, code: "invalid-archive" | "budget-exceeded"): void {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ArchiveError);
  if (!(caught instanceof ArchiveError)) throw new Error("Expected categorized FlatBuffers refusal.");
  expect(caught.code).toBe(code);
}

describe("checked FlatBuffers metadata", () => {
  it("reads authored root, slots, exact int64 and schema-owned absent defaults", () => {
    const reader = new FlatBuffers(table());
    expect(reader.root()).toBe(16);
    expect(reader.field(16, 0, 4)).toBe(20);
    expect(reader.i32(20)).toBe(-123);
    expect(reader.field(16, 1, 8)).toBe(24);
    expect(reader.i64(24)).toBe(-9007199254740993n);
    expect(reader.field(16, 2, 4)).toBeNull();
    const missing = table();
    new DataView(missing.buffer).setUint16(12, 0, true);
    expect(new FlatBuffers(missing).field(16, 0, 4)).toBeNull();
  });

  it("accepts a deduplicated vtable after its object through a negative signed displacement", () => {
    const bytes = new Uint8Array(48), view = new DataView(bytes.buffer);
    view.setUint32(0, 8, true);
    view.setInt32(8, -24, true);
    view.setUint32(12, 42, true);
    view.setUint16(32, 6, true);
    view.setUint16(34, 8, true);
    view.setUint16(36, 4, true);
    const reader = new FlatBuffers(bytes);
    expect(reader.root()).toBe(8);
    expect(reader.field(8, 0, 4)).toBe(12);
    expect(reader.u32(12)).toBe(42);
  });

  it("interprets positions relative to a borrowed subarray rather than its backing buffer", () => {
    const backing = new Uint8Array(120);
    backing.set(table(), 7);
    const reader = new FlatBuffers(backing.subarray(7, 103));
    expect(reader.root()).toBe(16);
    expect(reader.i64(24)).toBe(-9007199254740993n);
  });

  it("rejects malformed roots, signed vtable targets and vtable/object extents", () => {
    for (
      const change of [
        (view: DataView) => view.setUint32(0, 0, true),
        (view: DataView) => view.setUint32(0, 0xffffffff, true),
        (view: DataView) => view.setInt32(16, 0, true),
        (view: DataView) => view.setInt32(16, 100, true),
        (view: DataView) => view.setInt32(16, -0x7fffffff, true),
        (view: DataView) => view.setUint16(8, 3, true),
        (view: DataView) => view.setUint16(8, 7, true),
        (view: DataView) => view.setUint16(8, 100, true),
        (view: DataView) => view.setUint16(10, 3, true),
        (view: DataView) => view.setUint16(10, 100, true),
        (view: DataView) => view.setUint16(8, 10, true),
      ]
    ) {
      const bytes = table();
      change(new DataView(bytes.buffer));
      failure(() => new FlatBuffers(bytes).root(), "invalid-archive");
    }
    failure(() => new FlatBuffers(new Uint8Array(3)).root(), "invalid-archive");
  });

  it("distinguishes missing slots from present fields outside their object", () => {
    for (const relative of [1, 3, 13, 16, 65535]) {
      const bytes = table();
      new DataView(bytes.buffer).setUint16(12, relative, true);
      failure(() => new FlatBuffers(bytes).field(16, 0, 4), "invalid-archive");
    }
    const bytes = table();
    new DataView(bytes.buffer).setUint32(20, 0, true);
    const reader = new FlatBuffers(bytes);
    expect(reader.field(16, 0, 4)).toBe(20);
    failure(() => reader.reference(20), "invalid-archive");
  });

  it("bounds forward references and complete scalar vectors before exposing elements", () => {
    const bytes = table(), view = new DataView(bytes.buffer);
    view.setUint32(20, 12, true);
    view.setUint32(32, 2, true);
    view.setInt32(36, -1, true);
    view.setInt32(40, 123, true);
    const reader = new FlatBuffers(bytes);
    expect(reader.reference(20)).toBe(32);
    expect(reader.vector(32, 4)).toEqual({ offset: 36, length: 2, stride: 4 });
    expect(reader.i32(36)).toBe(-1);
    expect(reader.i32(40)).toBe(123);
    view.setUint32(32, 0, true);
    expect(new FlatBuffers(bytes).vector(32, 24)).toEqual({ offset: 36, length: 0, stride: 24 });
    view.setUint32(32, 0xffffffff, true);
    failure(() => new FlatBuffers(bytes).vector(32, 24), "invalid-archive");
    for (const offset of [1, 3, 76, 0xffffffff]) {
      view.setUint32(20, offset, true);
      failure(() => new FlatBuffers(bytes).reference(20), "invalid-archive");
    }
    expect(() => reader.vector(32, 0)).toThrow(TypeError);
    expect(() => reader.vector(32, Number.MAX_SAFE_INTEGER + 1)).toThrow(TypeError);
  });

  it("requires UTF-8 and a trailing NUL while preserving literal BOM and embedded NUL", () => {
    const bytes = new Uint8Array(32), view = new DataView(bytes.buffer);
    view.setUint32(0, 7, true);
    bytes.set([0xef, 0xbb, 0xbf, 0x61, 0, 0xc3, 0xa9, 0], 4);
    expect(new FlatBuffers(bytes).string(0)).toBe("\uFEFFa\0é");
    bytes[11] = 1;
    failure(() => new FlatBuffers(bytes).string(0), "invalid-archive");
    bytes[11] = 0;
    bytes[9] = 0xff;
    failure(() => new FlatBuffers(bytes).string(0), "invalid-archive");
    view.setUint32(0, 29, true);
    failure(() => new FlatBuffers(bytes).string(0), "invalid-archive");
    view.setUint32(0, 0, true);
    bytes[4] = 0;
    expect(new FlatBuffers(bytes).string(0)).toBe("");
  });

  it("reads signed and unsigned scalars without lossy int64 conversion", () => {
    const bytes = Uint8Array.of(255, 255, 255, 255, 255, 255, 255, 255);
    const reader = new FlatBuffers(bytes);
    expect(reader.i8(0)).toBe(-1);
    expect(reader.u8(0)).toBe(255);
    expect(reader.i16(0)).toBe(-1);
    expect(reader.u16(0)).toBe(65535);
    expect(reader.i32(0)).toBe(-1);
    expect(reader.u32(0)).toBe(4294967295);
    expect(reader.i64(0)).toBe(-1n);
    expect(reader.u64(0)).toBe(18446744073709551615n);
    failure(() => reader.i64(1), "invalid-archive");
  });

  it("admits byte, step, reference, input and string budgets independently before work", () => {
    failure(() => new FlatBuffers(table(), { maxInputBytes: 95 }), "budget-exceeded");
    const bytes = new FlatBuffers(table(), { maxBytes: 4 });
    expect(bytes.u32(0)).toBe(16);
    failure(() => bytes.u8(0), "budget-exceeded");
    expect(bytes.inspect()).toEqual({ bytes: 4, steps: 1, references: 0 });
    const steps = new FlatBuffers(table(), { maxSteps: 1 });
    steps.u8(0);
    failure(() => steps.u8(0), "budget-exceeded");
    failure(() => new FlatBuffers(table(), { maxReferences: 1 }).root(), "budget-exceeded");
    const text = new Uint8Array(8);
    text[0] = 3;
    failure(() => new FlatBuffers(text, { maxStringBytes: 2 }).string(0), "budget-exceeded");
    expect(() => new FlatBuffers(table(), { maxSteps: Infinity })).toThrow(TypeError);
    expect(() => new FlatBuffers(table(), { maxBytes: -1 })).toThrow(TypeError);
    expect(() => new FlatBuffers(table()).u8(-1)).toThrow(TypeError);
  });
});
