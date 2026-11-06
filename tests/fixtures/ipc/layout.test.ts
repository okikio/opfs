/** Independent geometry assertions over frozen Arrow C++ images, never a candidate parser. */
import { describe, it } from "node:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { expect } from "@std/expect";

/** Frozen native receipt identities are pinned here so edited expectations cannot hide changed inputs. */
const HASHES = {
  "independent.json": "09bac9152ccc959f35274cd8f47f3fa170517e6dd0823ea530532b73031d44d1",
  "native-state.json": "fa76e29cf2aea19b4987f0d50e6e20c2dfe15025190e93012ce1b5dd16e20ed6",
} as const;
function check(value: boolean, message: string): asserts value {
  if (!value) throw new Error(message);
}
function object(value: unknown): Record<string, unknown> {
  check(typeof value === "object" && value !== null && !Array.isArray(value), "Expected fixture object.");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  check(Array.isArray(value) && value.length <= 1024, "Expected bounded fixture array.");
  return value;
}
function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function read(name: string): Buffer<ArrayBuffer> {
  const path = new URL(`native/${name}`, import.meta.url), info = lstatSync(path);
  check(info.isFile() && info.size <= 1024 * 1024, "Fixture must be a bounded original regular file.");
  const bytes = readFileSync(path);
  expect(bytes.length).toBe(info.size);
  if (name === "independent.json" || name === "native-state.json") expect(sha(bytes)).toBe(HASHES[name]);
  return bytes;
}
function blob(value: unknown): Buffer<ArrayBuffer> {
  const item = object(value);
  check(typeof item.base64 === "string" && item.base64.length <= 2 * 1024 * 1024, "Expected bounded original blob.");
  const bytes = Buffer.from(item.base64, "base64");
  expect(bytes.toString("base64")).toBe(item.base64);
  expect(bytes.length).toBe(item.bytes);
  expect(sha(bytes)).toBe(item.sha256);
  return bytes;
}

/**
 * Fixture-only FlatBuffers reads. Slots below are literal Arrow21 schema ordinals,
 * independent of production accessors. This is not a supported generic parser:
 * every caller reads a hash-pinned native image and still checks its local extent.
 */
class NativeTable {
  readonly bytes: Buffer<ArrayBuffer>;
  readonly at: number;
  readonly #vtable: number;
  readonly #vlength: number;
  readonly #objectLength: number;
  constructor(bytes: Buffer<ArrayBuffer>, at: number) {
    this.bytes = bytes;
    this.at = at;
    check(at >= 0 && at + 4 <= bytes.length, "Native table extent.");
    this.#vtable = at - bytes.readInt32LE(at);
    check(this.#vtable >= 0 && this.#vtable + 4 <= bytes.length, "Native vtable extent.");
    this.#vlength = bytes.readUInt16LE(this.#vtable);
    this.#objectLength = bytes.readUInt16LE(this.#vtable + 2);
    check(
      this.#vlength >= 4 && this.#vlength % 2 === 0 && this.#vtable + this.#vlength <= bytes.length &&
        this.#objectLength >= 4 && at + this.#objectLength <= bytes.length,
      "Native table dimensions.",
    );
  }
  slot(index: number, width = 4): number | undefined {
    const entry = 4 + index * 2;
    if (entry >= this.#vlength) return undefined;
    const offset = this.bytes.readUInt16LE(this.#vtable + entry);
    if (offset === 0) return undefined;
    check(offset >= 4 && offset + width <= this.#objectLength, "Native field extent.");
    return this.at + offset;
  }
  pointer(index: number): number | undefined {
    const at = this.slot(index);
    if (at === undefined) return undefined;
    const delta = this.bytes.readUInt32LE(at), target = at + delta;
    check(delta >= 4 && target < this.bytes.length, "Native relative reference.");
    return target;
  }
  table(index: number): NativeTable {
    const at = this.pointer(index);
    check(at !== undefined, "Required native table absent.");
    return new NativeTable(this.bytes, at);
  }
  scalar(index: number, width: 1 | 2 | 4, fallback = 0): number {
    const at = this.slot(index, width);
    return at === undefined
      ? fallback
      : width === 1
      ? this.bytes.readUInt8(at)
      : width === 2
      ? this.bytes.readInt16LE(at)
      : this.bytes.readInt32LE(at);
  }
  long(index: number): number {
    const at = this.slot(index, 8), value = at === undefined ? 0n : this.bytes.readBigInt64LE(at);
    check(value >= 0n && value <= 1024n * 1024n, "Native bounded int64 extent.");
    return Number(value);
  }
  vector(index: number, stride: number): number[] {
    const at = this.pointer(index);
    if (at === undefined) return [];
    check(at + 4 <= this.bytes.length, "Native vector prefix.");
    const count = this.bytes.readUInt32LE(at);
    check(count <= 1024 && count * stride <= this.bytes.length - at - 4, "Native vector extent.");
    return Array.from({ length: count }, (_, item) => at + 4 + item * stride);
  }
  string(index: number): string {
    const at = this.pointer(index);
    check(at !== undefined && at + 4 <= this.bytes.length, "Native string prefix.");
    const length = this.bytes.readUInt32LE(at);
    check(
      length <= 1024 && at + 4 + length < this.bytes.length && this.bytes[at + 4 + length] === 0,
      "Native string extent/terminator.",
    );
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      this.bytes.subarray(at + 4, at + 4 + length),
    );
  }
}
function root(bytes: Buffer<ArrayBuffer>): NativeTable {
  check(bytes.length >= 4, "Native FlatBuffer root prefix.");
  return new NativeTable(bytes, bytes.readUInt32LE(0));
}
function indirect(bytes: Buffer<ArrayBuffer>, at: number): NativeTable {
  check(at + 4 <= bytes.length, "Native vector table reference.");
  return new NativeTable(bytes, at + bytes.readUInt32LE(at));
}

/** Footer and stream schemas must agree semantically, rather than by FlatBuffers byte identity. */
function schema(table: NativeTable): unknown {
  expect(table.scalar(0, 2)).toBe(0); // Schema.endianness = Little.
  expect(table.vector(2, 4)).toEqual([]); // No custom schema metadata in this corpus.
  expect(table.vector(3, 8)).toEqual([]); // No required feature flags in this corpus.
  return table.vector(1, 4).map((at) => {
    const field = indirect(table.bytes, at), kind = field.scalar(2, 1), type = field.table(3);
    expect(field.pointer(4)).toBeUndefined(); // No dictionary encoding.
    expect(field.vector(5, 4)).toEqual([]); // No nested children.
    expect(field.vector(6, 4)).toEqual([]);
    const physical = kind === 2
      ? { type: "int", width: type.scalar(0, 4), signed: type.scalar(1, 1) === 1 }
      : kind === 3
      ? { type: "float", precision: type.scalar(0, 2) }
      : { type: kind === 4 ? "binary" : kind === 5 ? "utf8" : kind === 6 ? "boolean" : "unsupported" };
    return { name: field.string(0), nullable: field.scalar(1, 1) === 1, ...physical };
  });
}
const EXPECTED_SCHEMA = [
  { name: "i", nullable: true, type: "int", width: 32, signed: true },
  { name: "q", nullable: true, type: "int", width: 64, signed: true },
  { name: "d", nullable: true, type: "float", precision: 2 },
  { name: "b", nullable: true, type: "boolean" },
  { name: "s", nullable: true, type: "utf8" },
  { name: "x", nullable: true, type: "binary" },
];
interface BlockType {
  offset: number;
  metadata: number;
  body: number;
}
interface MessageType extends BlockType {
  table: NativeTable;
  header: NativeTable;
  kind: number;
}
/** Native modern encapsulation includes eight framing bytes before metadata_size bytes. */
function message(bytes: Buffer<ArrayBuffer>, offset: number, end: number): MessageType | null {
  check(offset >= 0 && offset % 8 === 0 && offset + 8 <= end, "Native message prefix extent/alignment.");
  expect(bytes.readUInt32LE(offset)).toBe(0xffffffff);
  const length = bytes.readInt32LE(offset + 4);
  if (length === 0) return null;
  check(length > 0 && length % 8 === 0 && length <= end - offset - 8, "Native padded metadata extent.");
  const table = root(bytes.subarray(offset + 8, offset + 8 + length));
  expect(table.scalar(0, 2)).toBe(4); // MetadataVersion.V5.
  expect(table.vector(4, 4)).toEqual([]); // No Message custom metadata.
  const body = table.long(3);
  check(body % 8 === 0 && body <= end - offset - 8 - length, "Native padded body extent.");
  return { offset, metadata: length + 8, body, table, header: table.table(2), kind: table.scalar(1, 1) };
}
function blocks(footer: NativeTable): BlockType[] {
  expect(footer.vector(2, 24)).toEqual([]); // No dictionary blocks.
  return footer.vector(3, 24).map((at) => {
    const offset = footer.bytes.readBigInt64LE(at), body = footer.bytes.readBigInt64LE(at + 16);
    check(offset >= 0n && offset <= 1024n * 1024n && body >= 0n && body <= 1024n * 1024n, "Native block int64 extent.");
    return { offset: Number(offset), metadata: footer.bytes.readInt32LE(at + 8), body: Number(body) };
  });
}

/** Nodes are checked against independently authored byte masks, not candidate decoded values. */
function batchMetadata(item: MessageType, original: unknown): void {
  const expected = object(original), rows = expected.rows;
  check(typeof rows === "number" && Number.isInteger(rows) && rows >= 0 && rows <= 64, "Original batch rows.");
  expect(item.header.long(0)).toBe(rows);
  expect(item.header.pointer(3)).toBeUndefined(); // No BodyCompression, even an all-raw one.
  expect(item.header.vector(4, 8)).toEqual([]);
  const nodes = item.header.vector(1, 16), buffers = item.header.vector(2, 16);
  expect(nodes.length).toBe(6);
  expect(buffers.length).toBe(14);
  const originals = object(expected.originals), keys = ["i", "q", "d", "b", "s", "x"];
  for (const [index, at] of nodes.entries()) {
    expect(item.header.bytes.readBigInt64LE(at)).toBe(BigInt(rows));
    const mask = blob(originals[`${keys[index]}.validity`]);
    expect(mask.length).toBe(rows);
    expect([...mask].every((value) => value === 0 || value === 1)).toBe(true);
    expect(item.header.bytes.readBigInt64LE(at + 8)).toBe(BigInt([...mask].filter((value) => value === 0).length));
  }
  let previousEnd = 0;
  for (const at of buffers) {
    const offset = item.header.bytes.readBigInt64LE(at), length = item.header.bytes.readBigInt64LE(at + 8);
    check(offset >= 0n && length >= 0n && offset + length <= BigInt(item.body), "Native buffer exceeds padded body.");
    expect(Number(offset)).toBe(Math.ceil(previousEnd / 8) * 8);
    previousEnd = Number(offset + length);
  }
  expect(Math.ceil(previousEnd / 8) * 8).toBe(item.body);
}

describe("independent Arrow20 IPC native geometry", () => {
  it("retains exact receipt, terminal, image and authored-original identities", () => {
    const receipt = object(JSON.parse(read("receipt.json").toString()));
    expect(receipt.validationReceipt).toBe("b08cc08f-c149-47dc-a3ae-7fe1f6d00547");
    expect(receipt.oomKilled).toBe(false);
    expect(receipt.containerRemoved).toBe(true);
    const files = array(receipt.files).map(object);
    for (const [name, expected] of Object.entries(HASHES)) {
      const bytes = read(name), entry = files.find((item) => item.file === name);
      expect(sha(bytes)).toBe(expected);
      expect(entry?.sha256).toBe(expected);
      expect(entry?.bytes).toBe(bytes.length);
    }
    expect(object(JSON.parse(read("native-state.json").toString()))).toEqual({
      code: 0,
      signal: null,
      failure: null,
      cleanupFaults: [],
      bytes: 0,
    });
    const corpus = object(JSON.parse(read("independent.json").toString())), fixtures = array(corpus.fixtures);
    expect(fixtures.length).toBe(10);
    for (const fixture of fixtures.map(object)) {
      blob(fixture.image);
      for (const batch of array(fixture.batches).map(object)) {
        for (const bytes of Object.values(object(batch.originals))) blob(bytes);
      }
    }
  });
  it("matches file Block descriptors to exact encapsulated messages and independent original row masks", () => {
    const fixtures = array(object(JSON.parse(read("independent.json").toString())).fixtures).map(object);
    for (const fixture of fixtures) {
      const bytes = blob(fixture.image), file = fixture.format === "file", originals = array(fixture.batches);
      let at = file ? 8 : 0, end = bytes.length;
      let footer: NativeTable | undefined;
      if (file) {
        expect(bytes.subarray(0, 8)).toEqual(Buffer.from([65, 82, 82, 79, 87, 49, 0, 0]));
        expect(bytes.subarray(-6).toString()).toBe("ARROW1");
        const length = bytes.readInt32LE(bytes.length - 10);
        check(length > 0 && length <= bytes.length - 26, "Native footer length.");
        end = bytes.length - 10 - length;
        expect(end % 8).toBe(0);
        footer = root(bytes.subarray(end, bytes.length - 10));
        expect(footer.scalar(0, 2)).toBe(4);
        expect(footer.vector(4, 4)).toEqual([]);
        expect(schema(footer.table(1))).toEqual(EXPECTED_SCHEMA);
      }
      const first = message(bytes, at, end);
      check(first !== null, "Native image must begin with a schema.");
      expect(first.kind).toBe(1);
      expect(first.body).toBe(0);
      expect(schema(first.header)).toEqual(EXPECTED_SCHEMA);
      if (footer) expect(schema(first.header)).toEqual(schema(footer.table(1)));
      at += first.metadata;
      const observed: BlockType[] = [];
      let eos = false;
      while (at < end) {
        const item = message(bytes, at, end);
        if (item === null) {
          at += 8;
          eos = true;
          break;
        }
        expect(item.kind).toBe(3); // No dictionaries or other message kinds in this corpus.
        check(observed.length < originals.length, "Native message count exceeds original batches.");
        batchMetadata(item, originals[observed.length]);
        observed.push({ offset: item.offset, metadata: item.metadata, body: item.body });
        at += item.metadata + item.body;
      }
      expect(eos).toBe(true); // This native writer profile emits explicit EOS in both envelopes.
      expect(at).toBe(end); // Exact EOS consumption; footer cannot be interpreted as message padding.
      expect(observed.length).toBe(originals.length);
      if (footer) expect(blocks(footer)).toEqual(observed);
    }
  });
});
