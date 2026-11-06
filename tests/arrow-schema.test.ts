/** Frozen native IPC metadata and authored refusal controls; no candidate serializer. */
import { describe, it } from "node:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect } from "@std/expect";
import { ArchiveError } from "../src/archive/record.ts";
import { parseFooter, parseMessage, requireEligibleSchema, validateBatch } from "../src/dataset/arrow/schema.ts";

interface BlobType {
  readonly bytes: number;
  readonly sha256: string;
  readonly base64: string;
}
interface OriginalType {
  readonly rows: number;
  readonly originals: Readonly<Record<string, BlobType>>;
}
interface FixtureType {
  readonly format: string;
  readonly image: BlobType;
  readonly batches: readonly OriginalType[];
}
/** A trusted frozen envelope, pinned before JSON parsing or expectation admission. */
function fixtures(): readonly FixtureType[] {
  const bytes = readFileSync(new URL("./fixtures/ipc/native/independent.json", import.meta.url));
  expect(bytes.length).toBe(106854);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "09bac9152ccc959f35274cd8f47f3fa170517e6dd0823ea530532b73031d44d1",
  );
  return (JSON.parse(bytes.toString()) as { fixtures: FixtureType[] }).fixtures;
}
function blob(item: BlobType): Buffer<ArrayBuffer> {
  const bytes = Buffer.from(item.base64, "base64");
  expect(bytes.length).toBe(item.bytes);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(item.sha256);
  return bytes;
}
/** Literal schema-slot locator for mutation setup, independent of the candidate accessor. */
function slot(bytes: Buffer<ArrayBuffer>, table: number, index: number): number | null {
  const vtable = table - bytes.readInt32LE(table), size = bytes.readUInt16LE(vtable);
  if (4 + index * 2 >= size) return null;
  const relative = bytes.readUInt16LE(vtable + 4 + index * 2);
  return relative === 0 ? null : table + relative;
}
function required(value: number | null): number {
  if (value === null) throw new Error("Pinned native field unexpectedly absent.");
  return value;
}
function pointer(bytes: Buffer<ArrayBuffer>, table: number, index: number): number {
  const at = required(slot(bytes, table, index));
  return at + bytes.readUInt32LE(at);
}
function root(bytes: Buffer<ArrayBuffer>): number {
  return bytes.readUInt32LE(0);
}
function schemaFields(bytes: Buffer<ArrayBuffer>): number[] {
  const schema = pointer(bytes, root(bytes), 2), vector = pointer(bytes, schema, 1);
  return Array.from({ length: bytes.readUInt32LE(vector) }, (_, i) => {
    const at = vector + 4 + i * 4;
    return at + bytes.readUInt32LE(at);
  });
}
function frames(fixture: FixtureType): Buffer<ArrayBuffer>[] {
  const bytes = blob(fixture.image),
    end = fixture.format === "file" ? bytes.length - 10 - bytes.readInt32LE(bytes.length - 10) : bytes.length;
  const values: Buffer<ArrayBuffer>[] = [];
  for (let at = fixture.format === "file" ? 8 : 0; at < end;) {
    expect(bytes.readUInt32LE(at)).toBe(0xffffffff);
    const size = bytes.readInt32LE(at + 4);
    if (size === 0) break;
    const metadata = Buffer.from(bytes.subarray(at + 8, at + 8 + size));
    values.push(metadata);
    const bodySlot = slot(metadata, root(metadata), 3),
      body = bodySlot === null ? 0n : metadata.readBigInt64LE(bodySlot);
    expect(body >= 0n && body <= BigInt(bytes.length)).toBe(true);
    at += 8 + size + Number(body);
  }
  return values;
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
const physical = ["int32", "int64", "float64", "boolean", "utf8", "binary"];
const names = ["i", "q", "d", "b", "s", "x"];

/**
 * Authored literal metadata-only Message: empty Schema plus three ordered pairs.
 * Offsets are fixed from the published table slots, not a candidate serializer.
 * The final KeyValue uses a forward vtable and an absent value slot.
 */
function opaqueMetadata(): Buffer<ArrayBuffer> {
  const bytes = Buffer.alloc(216);
  bytes.writeUInt32LE(24, 0);
  [14, 12, 4, 6, 8, 0, 0].forEach((value, i) => bytes.writeUInt16LE(value, 8 + i * 2));
  bytes.writeInt32LE(16, 24);
  bytes.writeInt16LE(4, 28);
  bytes[30] = 1;
  bytes.writeUInt32LE(32, 32);
  [12, 8, 0, 0, 4, 0].forEach((value, i) => bytes.writeUInt16LE(value, 48 + i * 2));
  bytes.writeInt32LE(16, 64);
  bytes.writeUInt32LE(12, 68);
  bytes.writeUInt32LE(3, 80);
  [112, 136, 160].forEach((target, i) => bytes.writeUInt32LE(target - (84 + i * 4), 84 + i * 4));
  [8, 12, 4, 8].forEach((value, i) => bytes.writeUInt16LE(value, 96 + i * 2));
  bytes.writeInt32LE(16, 112);
  bytes.writeInt32LE(40, 136);
  bytes.writeInt32LE(-16, 160);
  [116, 140, 164].forEach((at) => bytes.writeUInt32LE(184 - at, at));
  bytes.writeUInt32LE(196 - 120, 120);
  bytes.writeUInt32LE(208 - 144, 144);
  [8, 8, 4, 0].forEach((value, i) => bytes.writeUInt16LE(value, 176 + i * 2));
  bytes.writeUInt32LE(1, 184);
  bytes[188] = 120;
  bytes.writeUInt32LE(0, 196);
  bytes.writeUInt32LE(1, 208);
  bytes[212] = 121;
  return bytes;
}

/** Literal empty RecordBatch with a present unsupported optional layout field. */
function unsupportedBatch(kind: "compression" | "variadic"): Buffer<ArrayBuffer> {
  const bytes = Buffer.alloc(112);
  bytes.writeUInt32LE(24, 0);
  [14, 12, 4, 6, 8, 0, 0].forEach((value, i) => bytes.writeUInt16LE(value, 8 + i * 2));
  bytes.writeInt32LE(16, 24);
  bytes.writeInt16LE(4, 28);
  bytes[30] = 3;
  bytes.writeUInt32LE(32, 32);
  [14, 8, 0, 0, 0, kind === "compression" ? 4 : 0, kind === "variadic" ? 4 : 0]
    .forEach((value, i) => bytes.writeUInt16LE(value, 48 + i * 2));
  bytes.writeInt32LE(16, 64);
  bytes.writeUInt32LE(28, 68);
  if (kind === "compression") {
    [8, 4, 0, 0].forEach((value, i) => bytes.writeUInt16LE(value, 80 + i * 2));
    bytes.writeInt32LE(16, 96);
  } else bytes.writeUInt32LE(1, 96);
  return bytes;
}

describe("private Arrow V5 metadata grammar", () => {
  it("retains opaque duplicate metadata keys, empty values and absent values in order", () => {
    const bytes = opaqueMetadata(), message = parseMessage(bytes);
    if (message.kind !== "schema") throw new Error("Expected schema.");
    expect(message.schema.metadata).toEqual([{ key: "x", value: "" }, { key: "x", value: "y" }, {
      key: "x",
      value: null,
    }]);
    expect(requireEligibleSchema(message.schema).buffers).toBe(0);
    failure(() => parseMessage(bytes, { maxEntries: 2 }), "budget-exceeded");
    failure(() => parseMessage(bytes, { maxRetainedStringBytes: 3 }), "budget-exceeded");
  });
  it("admits ten pinned native file/stream profiles and checks nodes against original masks", () => {
    const corpus = fixtures();
    expect(corpus.length).toBe(10);
    for (const fixture of corpus) {
      const metadata = frames(fixture), first = parseMessage(metadata[0]!);
      expect(first.kind).toBe("schema");
      if (first.kind !== "schema") throw new Error("Native initial schema absent.");
      expect(first.schema.fields.map((field) => field.name)).toEqual(names);
      expect(first.schema.fields.map((field) => field.physical)).toEqual(physical);
      expect(first.schema.fields.map((field) => field.ordinal)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(first.schema.fields.every((field) => field.nullable && !field.dictionary)).toBe(true);
      const plan = requireEligibleSchema(first.schema);
      expect(plan.buffers).toBe(14);
      expect(plan.fields.map((field) => field.buffer)).toEqual([0, 2, 4, 6, 8, 11]);
      expect(metadata.length - 1).toBe(fixture.batches.length);
      for (let i = 0; i < fixture.batches.length; i++) {
        const original = fixture.batches[i]!, message = parseMessage(metadata[i + 1]!);
        if (message.kind !== "record-batch") throw new Error("Native record batch absent.");
        expect(message.batch.rows).toBe(BigInt(original.rows));
        expect(message.batch.nodes.map((node) => node.nulls)).toEqual(
          names.map((name) =>
            BigInt([...blob(original.originals[`${name}.validity`]!)].filter((value) => value === 0).length)
          ),
        );
        validateBatch(message.batch, plan, message.bodyLength);
      }
      if (fixture.format === "file") {
        const image = blob(fixture.image), length = image.readInt32LE(image.length - 10);
        const footer = parseFooter(image.subarray(image.length - 10 - length, image.length - 10));
        expect(footer.schema).toEqual(first.schema);
        expect(footer.batches.length).toBe(fixture.batches.length);
        for (const [i, block] of footer.batches.entries()) {
          expect(block.metadataLength).toBe(metadata[i + 1]!.length + 8);
        }
      }
    }
  });
  it("preserves duplicate/empty names and applies absent nullable=false without path identity", () => {
    const bytes = frames(fixtures()[0]!)[0]!, fields = schemaFields(bytes);
    const firstName = pointer(bytes, fields[0]!, 0), secondName = pointer(bytes, fields[1]!, 0);
    bytes[firstName + 4] = 113; // i -> q; the other q remains a different ordinal.
    let result = parseMessage(bytes);
    if (result.kind !== "schema") throw new Error("Expected schema.");
    expect(result.schema.fields.slice(0, 2).map((field) => [field.ordinal, field.name])).toEqual([[0, "q"], [1, "q"]]);
    bytes.writeUInt32LE(0, secondName);
    bytes[secondName + 4] = 0;
    const field = fields[1]!, vtable = field - bytes.readInt32LE(field);
    // Removing a FlatBuffers field invokes its declared default, not the old inline byte.
    bytes.writeUInt16LE(0, vtable + 4 + 1 * 2);
    result = parseMessage(bytes);
    if (result.kind !== "schema") throw new Error("Expected schema.");
    expect(result.schema.fields[1]!.name).toBe("");
    expect(result.schema.fields[1]!.nullable).toBe(false);
  });
  it("bounds fields, retained strings, rows, buffers and FlatBuffers traversal before materialization", () => {
    const metadata = frames(fixtures().find((fixture) => fixture.batches.some((batch) => batch.rows > 0))!);
    failure(() => parseMessage(metadata[0]!, { maxFields: 5 }), "budget-exceeded");
    failure(() => parseMessage(metadata[0]!, { maxRetainedStringBytes: 5 }), "budget-exceeded");
    failure(() => parseMessage(metadata[0]!, { maxSteps: 0 }), "budget-exceeded");
    const batch = metadata.find((bytes) => {
      const value = parseMessage(bytes);
      return value.kind === "record-batch" && value.batch.rows > 0n;
    })!;
    failure(() => parseMessage(batch, { maxRows: 0 }), "budget-exceeded");
    failure(() => parseMessage(batch, { maxBuffers: 13 }), "budget-exceeded");
  });
  it("refuses unknown union/version and malformed boolean before assigning layouts", () => {
    const original = frames(fixtures()[0]!)[0]!;
    const version = Buffer.from(original);
    version.writeInt16LE(3, required(slot(version, root(version), 0)));
    failure(() => parseMessage(version), "unsupported-profile");
    const union = Buffer.from(original);
    union[required(slot(union, root(union), 1))] = 2;
    failure(() => parseMessage(union), "unsupported-profile");
    const bad = Buffer.from(original), field = schemaFields(bad)[0]!;
    bad[required(slot(bad, field, 1))] = 2;
    failure(() => parseMessage(bad), "invalid-archive");
    const truncated = original.subarray(0, original.length / 2);
    failure(() => parseMessage(truncated), "invalid-archive");
    failure(() => parseMessage(unsupportedBatch("compression")), "unsupported-profile");
    failure(() => parseMessage(unsupportedBatch("variadic")), "unsupported-profile");
  });
  it("checks the whole batch's shape and extents while making no payload-content claim", () => {
    const fixture = fixtures().find((item) => item.batches.some((batch) => batch.rows > 0))!,
      metadata = frames(fixture);
    const schema = parseMessage(metadata[0]!);
    if (schema.kind !== "schema") throw new Error("Expected schema.");
    const plan = requireEligibleSchema(schema.schema);
    const record = metadata.map((bytes) => parseMessage(bytes)).find((value) =>
      value.kind === "record-batch" && value.batch.rows > 0n
    );
    if (!record || record.kind !== "record-batch") throw new Error("Expected record batch.");
    failure(
      () => validateBatch({ ...record.batch, nodes: record.batch.nodes.slice(1) }, plan, record.bodyLength),
      "invalid-archive",
    );
    const buffers = [...record.batch.buffers];
    buffers[13] = { offset: record.bodyLength, length: 1n };
    failure(() => validateBatch({ ...record.batch, buffers }, plan, record.bodyLength), "invalid-archive");
    failure(() => requireEligibleSchema({ ...schema.schema, endianness: 1 }), "unsupported-profile");
    failure(() => requireEligibleSchema({ ...schema.schema, features: [2n] }), "unsupported-profile");
    failure(
      () =>
        requireEligibleSchema({
          ...schema.schema,
          fields: schema.schema.fields.map((field) => ({ ...field, dictionary: true })),
        }),
      "unsupported-profile",
    );
  });
});
