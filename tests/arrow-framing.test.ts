/** Native byte geometry is the oracle; no candidate serializer constructs expected frames. */
import { describe, it } from "node:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect } from "@std/expect";
import { ArchiveError } from "../src/archive/record.ts";
import { inspectBlocks, inspectFileMagic, inspectFileTail, inspectPrefix } from "../src/dataset/arrow/framing.ts";
import type { ArrowBlockType } from "../src/dataset/arrow/schema.ts";

interface BlobType {
  readonly bytes: number;
  readonly sha256: string;
  readonly base64: string;
}
interface FixtureType {
  readonly format: string;
  readonly image: BlobType;
  readonly batches: readonly { readonly rows: number }[];
}
function fixtures(): readonly FixtureType[] {
  const bytes = readFileSync(new URL("./fixtures/ipc/native/independent.json", import.meta.url));
  expect(bytes.length).toBe(106854);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "09bac9152ccc959f35274cd8f47f3fa170517e6dd0823ea530532b73031d44d1",
  );
  return (JSON.parse(bytes.toString()) as { fixtures: FixtureType[] }).fixtures;
}
function blob(value: BlobType): Buffer<ArrayBuffer> {
  const bytes = Buffer.from(value.base64, "base64");
  expect(bytes.length).toBe(value.bytes);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(value.sha256);
  return bytes;
}
/** Literal FlatBuffers field reads over pinned images, independent of both candidate parsers. */
function slot(bytes: Buffer<ArrayBuffer>, table: number, index: number): number | null {
  const vtable = table - bytes.readInt32LE(table);
  if (4 + index * 2 >= bytes.readUInt16LE(vtable)) return null;
  const relative = bytes.readUInt16LE(vtable + 4 + index * 2);
  return relative === 0 ? null : table + relative;
}
function pointer(bytes: Buffer<ArrayBuffer>, table: number, index: number): number {
  const at = slot(bytes, table, index);
  if (at === null) throw new Error("Expected pinned native pointer.");
  return at + bytes.readUInt32LE(at);
}
function footerBlocks(bytes: Buffer<ArrayBuffer>, footer: number): ArrowBlockType[] {
  const table = footer + bytes.readUInt32LE(footer);
  if (slot(bytes, table, 3) === null) return [];
  const vector = pointer(bytes, table, 3);
  return Array.from({ length: bytes.readUInt32LE(vector) }, (_, i) => {
    const at = vector + 4 + i * 24;
    return {
      offset: bytes.readBigInt64LE(at),
      metadataLength: bytes.readInt32LE(at + 8),
      bodyLength: bytes.readBigInt64LE(at + 16),
    };
  });
}
function failure(action: () => unknown, code: ArchiveError["code"]): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveError);
    expect((error as ArchiveError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}.`);
}
function prefix(length: number): Buffer<ArrayBuffer> {
  const bytes = Buffer.alloc(8, 255);
  bytes.writeInt32LE(length, 4);
  return bytes;
}
function tail(length: number): Buffer<ArrayBuffer> {
  const bytes = Buffer.alloc(10);
  bytes.writeInt32LE(length);
  bytes.write("ARROW1", 4);
  return bytes;
}
const bounds = { sourceSize: 1042, footerOffset: 1024, schemaEnd: 64 };
const valid: ArrowBlockType = { offset: 64n, metadataLength: 24, bodyLength: 16n };

describe("private Arrow modern framing", () => {
  it("matches ten native profiles and footer Block descriptors to independently scanned messages", () => {
    const corpus = fixtures();
    expect(corpus.length).toBe(10);
    for (const fixture of corpus) {
      const bytes = blob(fixture.image), file = fixture.format === "file";
      let end = bytes.length, footerOffset: number | undefined;
      if (file) {
        inspectFileMagic(bytes.subarray(0, 8));
        const expectedLength = bytes.readInt32LE(bytes.length - 10);
        const expectedOffset = bytes.length - 10 - expectedLength;
        expect(inspectFileTail(bytes.subarray(-10), bytes.length)).toEqual({
          footerOffset: expectedOffset,
          footerLength: expectedLength,
        });
        footerOffset = expectedOffset;
        end = expectedOffset;
      }
      const scanned: {
        offset: number;
        metadataOffset: number;
        metadataLength: number;
        bodyOffset: number;
        bodyLength: number;
        end: number;
      }[] = [];
      let schemaEnd = 0, eos = false;
      for (let at = file ? 8 : 0; at < end;) {
        const metadataLength = bytes.readInt32LE(at + 4), result = inspectPrefix(bytes.subarray(at, at + 8));
        expect(bytes.readUInt32LE(at)).toBe(0xffffffff);
        if (metadataLength === 0) {
          expect(result).toEqual({ kind: "eos" });
          expect(at + 8).toBe(end);
          eos = true;
          break;
        }
        expect(result).toEqual({ kind: "message", metadataLength });
        const metadataOffset = at + 8, table = metadataOffset + bytes.readUInt32LE(metadataOffset);
        const bodySlot = slot(bytes, table, 3), length = bodySlot === null ? 0n : bytes.readBigInt64LE(bodySlot);
        expect(length >= 0n && length <= BigInt(bytes.length)).toBe(true);
        const bodyLength = Number(length), bodyOffset = metadataOffset + metadataLength, next = bodyOffset + bodyLength;
        const kindSlot = slot(bytes, table, 1);
        if (kindSlot === null) throw new Error("Expected native message union.");
        if (bytes[kindSlot] === 1) schemaEnd = next;
        else {
          expect(bytes[kindSlot]).toBe(3);
          scanned.push({ offset: at, metadataOffset, metadataLength, bodyOffset, bodyLength, end: next });
        }
        at = next;
      }
      expect(eos).toBe(true);
      expect(scanned.length).toBe(fixture.batches.length);
      if (footerOffset !== undefined) {
        const blocks = footerBlocks(bytes, footerOffset);
        expect(inspectBlocks(blocks, { sourceSize: bytes.length, footerOffset, schemaEnd })).toEqual(scanned);
        expect(blocks.map((block) => block.metadataLength)).toEqual(scanned.map((frame) => frame.metadataLength + 8));
      }
    }
  });
  it("requires exact modern prefix width and signed aligned lengths", () => {
    expect(inspectPrefix(prefix(0), { maxMetadataBytes: 0 })).toEqual({ kind: "eos" });
    expect(inspectPrefix(prefix(8))).toEqual({ kind: "message", metadataLength: 8 });
    for (const count of [0, 1, 4, 7, 9]) failure(() => inspectPrefix(Buffer.alloc(count)), "invalid-archive");
    failure(() => inspectPrefix(Buffer.alloc(8)), "unsupported-profile");
    failure(() => inspectPrefix(prefix(-8)), "invalid-archive");
    failure(() => inspectPrefix(prefix(7)), "invalid-archive");
    failure(() => inspectPrefix(prefix(16), { maxMetadataBytes: 8 }), "budget-exceeded");
  });
  it("checks file magic and signed trailer geometry before footer acquisition", () => {
    inspectFileMagic(Buffer.from([65, 82, 82, 79, 87, 49, 123, 234])); // Padding has no required byte value.
    expect(inspectFileTail(tail(8), 26)).toEqual({ footerOffset: 8, footerLength: 8 });
    failure(() => inspectFileMagic(Buffer.from("ARROW1")), "invalid-archive");
    failure(() => inspectFileMagic(Buffer.alloc(8)), "invalid-archive");
    for (const length of [-1, 0, 9, 100]) failure(() => inspectFileTail(tail(length), 26), "invalid-archive");
    failure(() => inspectFileTail(tail(8).subarray(1), 26), "invalid-archive");
    failure(() => inspectFileTail(tail(7), 26), "invalid-archive");
    failure(() => inspectFileTail(Buffer.alloc(10), 26), "invalid-archive");
    failure(() => inspectFileTail(tail(8), 26, { maxMetadataBytes: 7 }), "budget-exceeded");
    expect(() => inspectFileTail(tail(8), Number.MAX_SAFE_INTEGER + 1)).toThrow(TypeError);
  });
  it("admits exact safe ranges and rejects the whole index for any late bad block", () => {
    expect(inspectBlocks([valid], bounds)).toEqual([{
      offset: 64,
      metadataOffset: 72,
      metadataLength: 16,
      bodyOffset: 88,
      bodyLength: 16,
      end: 104,
    }]);
    expect(inspectBlocks([], bounds)).toEqual([]);
    const malformed: ArrowBlockType[] = [
      { ...valid, offset: -8n },
      { ...valid, offset: 56n },
      { ...valid, offset: 65n },
      { ...valid, bodyLength: -8n },
      { ...valid, bodyLength: 7n },
      { ...valid, metadataLength: 8 },
      { ...valid, metadataLength: 17 },
      { ...valid, metadataLength: 0x80000000 },
      { ...valid, metadataLength: Number.NaN },
      { ...valid, offset: 1016n },
      { ...valid, offset: 1n << 63n },
      { ...valid, bodyLength: 1n << 63n },
    ];
    for (const block of malformed) failure(() => inspectBlocks([block], bounds), "invalid-archive");
    failure(() => inspectBlocks([valid, { ...valid, offset: 96n }], bounds), "invalid-archive");
    failure(() => inspectBlocks([valid], { ...bounds, schemaEnd: 72 }), "invalid-archive");
    failure(() => inspectBlocks([valid], { ...bounds, footerOffset: 1040 }), "invalid-archive");
    failure(() => inspectBlocks([valid], bounds, { maxMetadataBytes: 15 }), "budget-exceeded");
    failure(() => inspectBlocks([valid], bounds, { maxBodyBytes: 15 }), "budget-exceeded");
    expect(() => inspectBlocks([], { ...bounds, sourceSize: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => inspectBlocks([], bounds, { maxBodyBytes: -1 })).toThrow(TypeError);
  });
});
