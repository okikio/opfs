/** Full native-produced IPC columns against frozen authored originals, plus adversarial body controls. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ArchiveError } from "../src/archive/record.ts";
import { admitColumns, decodeColumn, decodeColumns } from "../src/dataset/arrow/columns.ts";
import type { ArrowColumnType } from "../src/dataset/arrow/columns.ts";
import { parseMessage } from "../src/dataset/arrow/schema.ts";
import type { ArrowBatchType, ArrowPhysicalType, ArrowSchemaType } from "../src/dataset/arrow/schema.ts";

interface BlobType {
  readonly bytes: number;
  readonly sha256: string;
  readonly base64: string;
}
interface FixtureType {
  readonly name: string;
  readonly format: string;
  readonly image: BlobType;
  readonly batches: readonly { readonly rows: number; readonly originals: Readonly<Record<string, BlobType>> }[];
}
function blob(item: BlobType): Buffer<ArrayBuffer> {
  const bytes = Buffer.from(item.base64, "base64");
  expect(bytes.length).toBe(item.bytes);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(item.sha256);
  return bytes;
}
/** The pinned envelope admits fixture metadata and expectations before parsing JSON. */
function fixtures(): readonly FixtureType[] {
  const path = fileURLToPath(new URL("./fixtures/ipc/native/independent.json", import.meta.url).href);
  const bytes = readFileSync(path);
  expect(bytes.length).toBe(106854);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "09bac9152ccc959f35274cd8f47f3fa170517e6dd0823ea530532b73031d44d1",
  );
  return (JSON.parse(bytes.toString()) as { fixtures: FixtureType[] }).fixtures;
}
/** Read a literal metadata field without asking a candidate decoder for a frame boundary. */
function bodyLength(metadata: Buffer<ArrayBuffer>): number {
  const table = metadata.readUInt32LE(0), vtable = table - metadata.readInt32LE(table);
  const size = metadata.readUInt16LE(vtable);
  const relative = size > 10 ? metadata.readUInt16LE(vtable + 10) : 0;
  const length = relative === 0 ? 0n : metadata.readBigInt64LE(table + relative);
  expect(length >= 0n && length <= 1048576n).toBe(true);
  return Number(length);
}
function bytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
}
/** Authored originals were written before Arrow C++; no candidate output supplies expected values. */
function original(column: ArrowColumnType, expected: Readonly<Record<string, BlobType>>, key: string): void {
  bytes(column.validity, blob(expected[`${key}.validity`]!));
  if (column.physical === "binary") {
    const offsets = blob(expected[`${key}.offsets`]!);
    for (let row = 0; row <= column.rows; row++) expect(column.offsets[row]).toBe(offsets.readInt32LE(row * 4));
    bytes(column.values, blob(expected[`${key}.data`]!));
  } else if (column.physical === "utf8") {
    const offsets = blob(expected[`${key}.offsets`]!), data = blob(expected[`${key}.data`]!);
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    for (let row = 0; row < column.rows; row++) {
      const value = decoder.decode(data.subarray(offsets.readInt32LE(row * 4), offsets.readInt32LE((row + 1) * 4)));
      expect(column.values[row]).toBe(value);
    }
  } else {
    const values = blob(expected[`${key}.bin`]!);
    for (let row = 0; row < column.rows; row++) {
      const value = column.physical === "int32"
        ? values.readInt32LE(row * 4)
        : column.physical === "int64"
        ? values.readBigInt64LE(row * 8)
        : column.physical === "float64"
        ? values.readDoubleLE(row * 8)
        : values[row];
      expect(Object.is(column.values[row], value)).toBe(true);
    }
  }
}
function failure(action: () => unknown, code: ArchiveError["code"]): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ArchiveError);
  if (!(caught instanceof ArchiveError)) throw new Error("Expected categorized column refusal.");
  expect(caught.code).toBe(code);
}
/** Two-row literal buffers; alignment gaps are deliberately separate from declared extents. */
function control(physical: ArrowPhysicalType = "utf8") {
  const schema: ArrowSchemaType = {
    endianness: 0,
    features: [],
    metadata: [],
    fields: [{ ordinal: 0, name: "duplicate", physical, nullable: true, dictionary: false, metadata: [] }],
  };
  const variable = physical === "utf8" || physical === "binary";
  const length = variable ? 12 : physical === "int32" ? 8 : physical === "boolean" ? 1 : 16;
  const body = new Uint8Array(32), view = new DataView(body.buffer);
  body[0] = 3;
  if (variable) {
    view.setInt32(8, 0, true);
    view.setInt32(12, 1, true);
    view.setInt32(16, 4, true);
    body.set([65, 0xef, 0xbb, 0xbf], 24);
  }
  const batch: ArrowBatchType = {
    rows: 2n,
    nodes: [{ length: 2n, nulls: 0n }],
    buffers: [
      { offset: 0n, length: 1n },
      { offset: 8n, length: BigInt(length) },
      ...(variable ? [{ offset: 24n, length: 4n }] : []),
    ],
  };
  return { schema, batch, body, view };
}

describe("bounded pure Arrow columns", () => {
  it("compares every batch of all ten pinned native file/stream profiles with original masks and values", () => {
    const corpus = fixtures();
    expect(corpus.length).toBe(10);
    for (const fixture of corpus) {
      const image = blob(fixture.image);
      const end = fixture.format === "file" ? image.length - 10 - image.readInt32LE(image.length - 10) : image.length;
      let schema: ArrowSchemaType | undefined, batchIndex = 0;
      for (let at = fixture.format === "file" ? 8 : 0; at < end;) {
        expect(image.readUInt32LE(at)).toBe(0xffffffff);
        const size = image.readInt32LE(at + 4);
        if (size === 0) break;
        const metadata = image.subarray(at + 8, at + 8 + size), length = bodyLength(metadata);
        const message = parseMessage(metadata);
        if (message.kind === "schema") schema = message.schema;
        else {
          if (schema === undefined) throw new Error("Native record batch preceded schema.");
          const expected = fixture.batches[batchIndex++]!;
          const body = image.subarray(at + 8 + size, at + 8 + size + length);
          const result = decodeColumns(schema, message.batch, body);
          expect(result.rows).toBe(expected.rows);
          expect(result.values.map((column) => column.ordinal)).toEqual([0, 1, 2, 3, 4, 5]);
          expect(result.integrity).toBe("none");
          for (const [index, key] of ["i", "q", "d", "b", "s", "x"].entries()) {
            original(result.values[index]!, expected.originals, key);
          }
          const selected = decodeColumns(schema, message.batch, body, { columns: [5, 1] });
          expect(selected.values.map((column) => column.ordinal)).toEqual([5, 1]);
          original(selected.values[0]!, expected.originals, "x");
          original(selected.values[1]!, expected.originals, "q");
          // Retained results must survive a caller overwriting its borrowed body.
          body.fill(255);
          for (const [index, key] of ["i", "q", "d", "b", "s", "x"].entries()) {
            original(result.values[index]!, expected.originals, key);
          }
        }
        at += 8 + size + length;
      }
      expect(batchIndex).toBe(fixture.batches.length);
    }
  });

  it("decodes exact acquired column buffers without materializing the unselected body", () => {
    const { schema, batch, body } = control();
    const admission = admitColumns(schema, batch, 32n);
    expect(admission.selectedBytes).toBe(17);
    const column = decodeColumn(schema, batch, 32n, 0, [
      body.subarray(0, 1),
      body.subarray(8, 20),
      body.subarray(24, 28),
    ]);
    expect(column.physical).toBe("utf8");
    expect(column.values).toEqual(["A", "\uFEFF"]);
    failure(
      () => decodeColumn(schema, batch, 32n, 0, [body.subarray(0, 1), body.subarray(8, 20), body.subarray(24, 27)]),
      "invalid-archive",
    );
    failure(() => decodeColumn(schema, batch, 32n, 0, []), "invalid-archive");
  });

  it("checks exact bitmap null counts and keeps null distinct from empty variable values", () => {
    const { schema, batch, body, view } = control();
    body[0] = 0xfe; // row0 null, row1 valid; unused high bits are not counted.
    view.setInt32(12, 0, true);
    view.setInt32(16, 0, true);
    const nullBatch = { ...batch, nodes: [{ length: 2n, nulls: 1n }] };
    const result = decodeColumns(schema, nullBatch, body).values[0]!;
    expect(Array.from(result.validity)).toEqual([0, 1]);
    expect(result.values).toEqual(["", ""]);
    failure(() => decodeColumns(schema, batch, body), "invalid-archive");
    const noBitmap = { ...batch, buffers: [{ offset: 0n, length: 0n }, ...batch.buffers.slice(1)] };
    expect(Array.from(decodeColumns(schema, noBitmap, body).values[0]!.validity)).toEqual([1, 1]);
    failure(() => decodeColumns(schema, { ...nullBatch, buffers: noBitmap.buffers }, body), "invalid-archive");
  });

  it("rejects negative, decreasing or out-of-payload offsets before returning values", () => {
    for (const [at, value] of [[8, -1], [12, -1], [12, 5], [16, 0], [16, 5]]) {
      const { schema, batch, body, view } = control();
      view.setInt32(at!, value!, true);
      failure(() => decodeColumns(schema, batch, body), "invalid-archive");
    }
  });

  it("rejects invalid valid-row UTF8 but leaves null-slot bytes uninterpreted", () => {
    const { schema, batch, body } = control();
    body[24] = 255;
    failure(() => decodeColumns(schema, batch, body), "invalid-archive");
    body[0] = 2;
    const result = decodeColumns(schema, { ...batch, nodes: [{ length: 2n, nulls: 1n }] }, body).values[0]!;
    expect(result.values).toEqual(["", "\uFEFF"]);
  });

  it("validates unsupported and unselected metadata before any body result", () => {
    const { schema, batch, body } = control();
    failure(() => decodeColumns({ ...schema, endianness: 1 }, batch, body, { columns: [] }), "unsupported-profile");
    failure(
      () =>
        decodeColumns(
          { ...schema, fields: schema.fields.map((field) => ({ ...field, dictionary: true })) },
          batch,
          body,
        ),
      "unsupported-profile",
    );
    failure(() => decodeColumns(schema, { ...batch, nodes: [] }, body, { columns: [] }), "invalid-archive");
    failure(
      () =>
        decodeColumns(
          schema,
          {
            ...batch,
            buffers: batch.buffers.map((buffer, index) => index === 2 ? { ...buffer, offset: 40n } : buffer),
          },
          body,
          { columns: [] },
        ),
      "invalid-archive",
    );
    expect(decodeColumns(schema, batch, body, { columns: [] }).values).toEqual([]);
    expect(() => decodeColumns(schema, batch, body, { columns: [1] })).toThrow(TypeError);
    failure(() => decodeColumns(schema, batch, body, { columns: [0, 0] }), "invalid-archive");
  });

  it("admits rows, each selected buffer, aggregate input and retained output before allocations", () => {
    const { schema, batch, body } = control();
    failure(() => decodeColumns(schema, batch, body, { maxRows: 1 }), "budget-exceeded");
    failure(() => decodeColumns(schema, batch, body, { maxBufferBytes: 11 }), "budget-exceeded");
    failure(() => decodeColumns(schema, batch, body, { maxSelectedBytes: 16 }), "budget-exceeded");
    failure(() => decodeColumns(schema, batch, body, { maxOutputBytes: 25 }), "budget-exceeded");
    expect(
      admitColumns(schema, batch, 32n, { maxBufferBytes: 12, maxSelectedBytes: 17, maxOutputBytes: 26 }).outputBytes,
    ).toBe(26);
    expect(() => decodeColumns(schema, batch, body, { maxRows: Infinity })).toThrow(TypeError);
  });

  it("shares admission across duplicate-named selected columns and leaves excluded payloads unvalidated", () => {
    const first = control(), body = new Uint8Array(64);
    body.set(first.body);
    body.set(first.body, 32);
    const schema = { ...first.schema, fields: [first.schema.fields[0]!, { ...first.schema.fields[0]!, ordinal: 1 }] };
    const batch = {
      ...first.batch,
      nodes: [...first.batch.nodes, ...first.batch.nodes],
      buffers: [
        ...first.batch.buffers,
        ...first.batch.buffers.map((extent) => ({ ...extent, offset: extent.offset + 32n })),
      ],
    };
    failure(() => decodeColumns(schema, batch, body, { maxSelectedBytes: 33 }), "budget-exceeded");
    failure(() => decodeColumns(schema, batch, body, { maxOutputBytes: 51 }), "budget-exceeded");
    const result = decodeColumns(schema, batch, body, { columns: [1, 0], maxSelectedBytes: 34, maxOutputBytes: 52 });
    expect(result.values.map((column) => [column.ordinal, column.name])).toEqual([[1, "duplicate"], [0, "duplicate"]]);
    expect(() => decodeColumns(schema, batch, body, { columns: [0, 0] })).toThrow(TypeError);
    body[32] = 0; // Invalid second-column bitmap is not a selected-body validation claim.
    expect(decodeColumns(schema, batch, body, { columns: [0] }).values.length).toBe(1);
    failure(() => decodeColumns(schema, batch, body, { columns: [1] }), "invalid-archive");
  });

  it("canonicalizes null binary slots without retaining their arbitrary bytes", () => {
    const { schema, batch, body } = control("binary");
    body[0] = 2;
    const column = decodeColumns(schema, { ...batch, nodes: [{ length: 2n, nulls: 1n }] }, body).values[0]!;
    if (column.physical !== "binary") throw new Error("Expected binary control.");
    expect(Array.from(column.validity)).toEqual([0, 1]);
    expect(Array.from(column.offsets)).toEqual([0, 0, 3]);
    bytes(column.values, Uint8Array.of(239, 187, 191));
    expect(column.outputBytes).toBe(17);
    failure(
      () =>
        decodeColumns({ ...schema, fields: schema.fields.map((field) => ({ ...field, nullable: false })) }, {
          ...batch,
          nodes: [{ length: 2n, nulls: 1n }],
        }, body),
      "invalid-archive",
    );
  });

  it("uses endian-aware unaligned views and owns binary offsets and values", () => {
    const { schema, batch, body } = control("binary");
    const backing = new Uint8Array(35);
    backing.set(body, 3);
    const borrowed = backing.subarray(3), result = decodeColumns(schema, batch, borrowed).values[0]!;
    if (result.physical !== "binary") throw new Error("Expected binary control.");
    bytes(result.values, Uint8Array.of(65, 239, 187, 191));
    expect(Array.from(result.offsets)).toEqual([0, 1, 4]);
    backing.fill(255);
    bytes(result.values, Uint8Array.of(65, 239, 187, 191));
    expect(Array.from(result.offsets)).toEqual([0, 1, 4]);
  });
});
