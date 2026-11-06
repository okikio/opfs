/** Public acquisition behavior over native IPC images, with original bytes as the value oracle. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openArrow, readArrow } from "../src/dataset/arrow.ts";
import type { ArrowColumnType } from "../src/dataset/arrow.ts";
import { ArchiveError } from "../src/archive/record.ts";
import type { ByteSourceType } from "../src/source.ts";

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
  readonly name: string;
  readonly format: string;
  readonly image: BlobType;
  readonly batches: readonly OriginalType[];
}
function fixtures(): readonly FixtureType[] {
  const bytes = readFileSync(fileURLToPath(new URL("./fixtures/ipc/native/independent.json", import.meta.url)));
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
function equalBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
}
/** Expected masks, offsets and typed values predate the native producer and candidate. */
function original(column: ArrowColumnType, expected: Readonly<Record<string, BlobType>>, key: string): void {
  equalBytes(column.validity, blob(expected[`${key}.validity`]!));
  if (column.physical === "binary") {
    const offsets = blob(expected[`${key}.offsets`]!);
    for (let row = 0; row <= column.rows; row++) expect(column.offsets[row]).toBe(offsets.readInt32LE(row * 4));
    equalBytes(column.values, blob(expected[`${key}.data`]!));
  } else if (column.physical === "utf8") {
    const offsets = blob(expected[`${key}.offsets`]!), data = blob(expected[`${key}.data`]!);
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    for (let row = 0; row < column.rows; row++) {
      expect(column.values[row]).toBe(
        decoder.decode(data.subarray(offsets.readInt32LE(row * 4), offsets.readInt32LE((row + 1) * 4))),
      );
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
const names = ["i", "q", "d", "b", "s", "x"];
/** A borrowed source returns views, so the candidate must own anything retained across reads. */
function observedSource(bytes: Buffer<ArrayBuffer>) {
  const reads: { offset: number; length: number; signal: AbortSignal | undefined }[] = [];
  let closed = 0;
  const control: { onRead?: () => void } = {};
  const source: ByteSourceType & { close(): void } = {
    size: bytes.length,
    stability: "caller",
    read(offset, length, options) {
      reads.push({ offset, length, signal: options?.signal });
      control.onRead?.();
      return Promise.resolve(bytes.subarray(offset, offset + length));
    },
    close() {
      closed++;
    },
  };
  return { source, reads, control, closed: () => closed };
}
/** Literal published slot ordinals locate mutations, never candidate parser output. */
function slot(bytes: Buffer<ArrayBuffer>, table: number, index: number): number | null {
  const vtable = table - bytes.readInt32LE(table);
  if (4 + index * 2 >= bytes.readUInt16LE(vtable)) return null;
  const relative = bytes.readUInt16LE(vtable + 4 + index * 2);
  return relative === 0 ? null : table + relative;
}
function required(value: number | null): number {
  if (value === null) throw new Error("Pinned native slot absent.");
  return value;
}
function pointer(bytes: Buffer<ArrayBuffer>, table: number, index: number): number {
  const at = required(slot(bytes, table, index));
  return at + bytes.readUInt32LE(at);
}
interface FrameType {
  readonly offset: number;
  readonly table: number;
  readonly bodyOffset: number;
  readonly bodyLength: number;
  readonly buffers: readonly { readonly offset: number; readonly length: number }[];
}
/** Independently scan the frozen modern framing and RecordBatch.Buffer vector. */
function recordFrames(bytes: Buffer<ArrayBuffer>, file = true): FrameType[] {
  const end = file ? bytes.length - 10 - bytes.readInt32LE(bytes.length - 10) : bytes.length;
  const records: FrameType[] = [];
  for (let at = file ? 8 : 0; at < end;) {
    expect(bytes.readUInt32LE(at)).toBe(0xffffffff);
    const length = bytes.readInt32LE(at + 4);
    if (length === 0) break;
    const metadata = at + 8, table = metadata + bytes.readUInt32LE(metadata), bodySlot = slot(bytes, table, 3);
    const body = bodySlot === null ? 0n : bytes.readBigInt64LE(bodySlot);
    expect(body >= 0n && body <= BigInt(bytes.length)).toBe(true);
    const bodyLength = Number(body), bodyOffset = metadata + length;
    if (bytes[required(slot(bytes, table, 1))] === 3) {
      const header = pointer(bytes, table, 2), vector = pointer(bytes, header, 2);
      const buffers = Array.from({ length: bytes.readUInt32LE(vector) }, (_, i) => {
        const item = vector + 4 + i * 16;
        return { offset: Number(bytes.readBigInt64LE(item)), length: Number(bytes.readBigInt64LE(item + 8)) };
      });
      records.push({ offset: at, table, bodyOffset, bodyLength, buffers });
    }
    at = bodyOffset + bodyLength;
  }
  return records;
}
async function failure(action: () => Promise<unknown>, code: ArchiveError["code"]): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ArchiveError);
  if (!(caught instanceof ArchiveError)) throw new Error("Expected categorized Arrow refusal.");
  expect(caught.code).toBe(code);
}
function nonemptyFile(): FixtureType {
  const item = fixtures().find((fixture) =>
    fixture.format === "file" && fixture.batches.some((batch) => batch.rows > 0)
  );
  if (!item) throw new Error("Expected native nonempty file.");
  return item;
}

/** Zero queue capacity makes each offered chunk an observable consumer demand. */
function observedStream(bytes: Uint8Array, widths: readonly number[] = [1, 3, 17, 64]) {
  let at = 0, pulls = 0, cancellations = 0, reason: unknown;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const width = widths[pulls++ % widths.length]!;
      if (at === bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.length, at + width);
      controller.enqueue(bytes.subarray(at, end));
      at = end;
    },
    cancel(value) {
      cancellations++;
      reason = value;
    },
  }, { highWaterMark: 0 });
  return { stream, pulls: () => pulls, cancellations: () => cancellations, reason: () => reason };
}
async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
  let count = 0;
  for await (const _batch of readArrow(stream)) count++;
  return count;
}

describe("indexed Arrow IPC source reads", () => {
  it("checks all six columns of every batch in five native files against independent originals", async () => {
    const files = fixtures().filter((fixture) => fixture.format === "file");
    expect(files.length).toBe(5);
    for (const fixture of files) {
      const observed = observedSource(blob(fixture.image)), dataset = await openArrow(observed.source);
      expect(dataset.integrity).toBe("none");
      expect(dataset.scope).toBe("footer-and-schema");
      expect(dataset.columns.map((field) => field.name)).toEqual(names);
      expect(dataset.batches.length).toBe(fixture.batches.length);
      for (const [i, batch] of fixture.batches.entries()) {
        const result = await dataset.read(i, [0, 1, 2, 3, 4, 5]);
        expect(result.rows).toBe(batch.rows);
        expect(result.integrity).toBe("none");
        expect(result.scope).toBe("selected-columns");
        expect(result.columns.map((column) => column.ordinal)).toEqual([0, 1, 2, 3, 4, 5]);
        result.columns.forEach((column, ordinal) => original(column, batch.originals, names[ordinal]!));
      }
      expect(observed.closed()).toBe(0);
    }
  });
  it("reads selected buffers only and leaves corrupt excluded payload outside its verification scope", async () => {
    const fixture = nonemptyFile(),
      bytes = blob(fixture.image),
      index = fixture.batches.findIndex((batch) => batch.rows > 0);
    const frame = recordFrames(bytes)[index]!, excluded = frame.buffers[12]!; // Binary offsets, not selected int32.
    bytes.writeInt32LE(-1, frame.bodyOffset + excluded.offset);
    const observed = observedSource(bytes), dataset = await openArrow(observed.source);
    const openingReads = observed.reads.length;
    const result = await dataset.read(index, [0]);
    original(result.columns[0]!, fixture.batches[index]!.originals, "i");
    expect(result.scope).toBe("selected-columns");
    expect(result.integrity).toBe("none");
    const payloadReads = observed.reads.slice(openingReads).filter((read) => read.offset >= frame.bodyOffset);
    expect(payloadReads.map(({ offset, length }) => ({ offset, length }))).toEqual(
      frame.buffers.slice(0, 2).map((buffer) => ({ offset: frame.bodyOffset + buffer.offset, length: buffer.length })),
    );
    const excludedStart = frame.bodyOffset + excluded.offset, excludedEnd = excludedStart + excluded.length;
    expect(
      observed.reads.every((read) =>
        read.length === 0 || read.offset + read.length <= excludedStart || read.offset >= excludedEnd
      ),
    ).toBe(true);
    await failure(() => dataset.read(index, [5]), "invalid-archive");
    expect(observed.closed()).toBe(0);
  });
  it("exposes immutable schema/index data and keeps returned owned columns stable", async () => {
    const fixture = nonemptyFile(),
      observed = observedSource(blob(fixture.image)),
      dataset = await openArrow(observed.source);
    expect(Object.isFrozen(dataset)).toBe(true);
    expect(Object.isFrozen(dataset.columns)).toBe(true);
    expect(Object.isFrozen(dataset.columns[0])).toBe(true);
    expect(Object.isFrozen(dataset.columns[0]!.metadata)).toBe(true);
    expect(Object.isFrozen(dataset.batches)).toBe(true);
    expect(Object.isFrozen(dataset.batches[0])).toBe(true);
    expect(Reflect.set(dataset.columns[0]!, "physical", "binary")).toBe(false);
    const index = fixture.batches.findIndex((batch) => batch.rows > 0),
      first = await dataset.read(index, [0, 1, 2, 3, 4, 5]);
    const later = await dataset.read(index, [0, 1, 2, 3, 4, 5]);
    later.columns.forEach((column) => {
      column.validity.fill(0);
      if (column.physical === "int64") column.values.fill(0n);
      else if (column.physical !== "utf8") column.values.fill(0);
    });
    first.columns.forEach((column, ordinal) => original(column, fixture.batches[index]!.originals, names[ordinal]!));
  });
  it("rejects unknown/duplicate ordinals and shares request allowance across the dataset lifetime", async () => {
    const fixture = nonemptyFile(), bytes = blob(fixture.image), probe = await openArrow(observedSource(bytes).source);
    const observed = observedSource(bytes),
      dataset = await openArrow(observed.source, { maxRequests: probe.work.requests + 2 });
    await dataset.read(0, []); // Two metadata requests consume the remaining lifetime allowance.
    const before = observed.reads.length;
    await failure(() => dataset.read(0, []), "budget-exceeded");
    expect(observed.reads.length).toBe(before);
    const unrestricted = await openArrow(observedSource(bytes).source);
    await expect(unrestricted.read(0, [0, 0])).rejects.toThrow(TypeError);
    await expect(unrestricted.read(0, [6])).rejects.toThrow(TypeError);
    await expect(unrestricted.read(999, [])).rejects.toThrow(RangeError);
    expect(observed.closed()).toBe(0);
  });
  it("rejects footer/schema disagreement and indexed prefix/body length mismatches", async () => {
    const fixture = nonemptyFile(), originalBytes = blob(fixture.image);
    const mismatch = Buffer.from(originalBytes),
      footer = mismatch.length - 10 - mismatch.readInt32LE(mismatch.length - 10);
    const footerTable = footer + mismatch.readUInt32LE(footer),
      schema = pointer(mismatch, footerTable, 1),
      fields = pointer(mismatch, schema, 1);
    const firstField = fields + 4 + mismatch.readUInt32LE(fields + 4), name = pointer(mismatch, firstField, 0);
    mismatch[name + 4] = 90;
    await failure(() => openArrow(observedSource(mismatch).source), "invalid-archive");
    const index = fixture.batches.findIndex((batch) => batch.rows > 0);
    for (const kind of ["prefix", "body"] as const) {
      const bytes = Buffer.from(originalBytes), frame = recordFrames(bytes)[index]!;
      if (kind === "prefix") bytes.writeInt32LE(bytes.readInt32LE(frame.offset + 4) + 8, frame.offset + 4);
      else {
        const at = required(slot(bytes, frame.table, 3));
        bytes.writeBigInt64LE(bytes.readBigInt64LE(at) + 8n, at);
      }
      const observed = observedSource(bytes), dataset = await openArrow(observed.source);
      await failure(() => dataset.read(index, [0]), "invalid-archive");
      expect(observed.closed()).toBe(0);
    }
  });
  it("propagates cancellation into borrowed reads without closing the source", async () => {
    const observed = observedSource(blob(nonemptyFile().image)), dataset = await openArrow(observed.source);
    const controller = new AbortController(), reason = new Error("caller stopped preview");
    observed.control.onRead = () => controller.abort(reason);
    await expect(dataset.read(0, [], { signal: controller.signal })).rejects.toBe(reason);
    expect(observed.reads.at(-1)!.signal).toBe(controller.signal);
    expect(observed.closed()).toBe(0);
    const before = observed.reads.length;
    await expect(openArrow(observed.source, { signal: controller.signal })).rejects.toBe(reason);
    expect(observed.reads.length).toBe(before);
  });
});

describe("demand-driven Arrow IPC stream reads", () => {
  it("preserves raw source errors exactly without observing the same failure again as cleanup", async () => {
    for (const reason of [undefined, null, new Error("native source failed")]) {
      let cancellations = 0;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(reason);
        },
        cancel() {
          cancellations++;
        },
      }, { highWaterMark: 0 });
      let rejected = false, actual: unknown;
      try {
        await readArrow(stream).next();
      } catch (error) {
        rejected = true;
        actual = error;
      }
      expect(rejected).toBe(true);
      expect(actual).toBe(reason);
      expect(actual instanceof AggregateError).toBe(false);
      expect(cancellations).toBe(0);
      expect(stream.locked).toBe(false);
    }
  });
  it("retains an independent cancellation failure after the malformed-prefix primary error", async () => {
    for (const cleanup of [undefined, null, new Error("native cancellation failed")]) {
      const prefix = Buffer.alloc(8, 255);
      prefix.writeInt32LE(-8, 4);
      let cancellations = 0, cancellationReason: unknown;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(prefix);
        },
        cancel(reason) {
          cancellations++;
          cancellationReason = reason;
          throw cleanup;
        },
      }, { highWaterMark: 0 });
      let actual: unknown;
      try {
        await readArrow(stream).next();
      } catch (error) {
        actual = error;
      }
      expect(actual).toBeInstanceOf(AggregateError);
      if (!(actual instanceof AggregateError)) throw new Error("Expected primary and cleanup observations.");
      expect(actual.errors.length).toBe(2);
      expect(actual.errors[0]).toBeInstanceOf(ArchiveError);
      expect((actual.errors[0] as ArchiveError).code).toBe("invalid-archive");
      expect(actual.errors[1]).toBe(cleanup);
      expect(actual.cause).toBe(actual.errors[0]);
      expect(cancellationReason).toBe(actual.errors[0]);
      expect(cancellations).toBe(1);
      expect(stream.locked).toBe(false);
    }
  });
  it("refuses oversized chunks and a zero batch allowance before acquiring a record body", async () => {
    const oversized = observedStream(new Uint8Array(9), [9]);
    await failure(() => readArrow(oversized.stream, { maxChunkBytes: 8 }).next(), "budget-exceeded");
    expect(oversized.cancellations()).toBe(1);
    expect(oversized.stream.locked).toBe(false);
    const fixture = fixtures().find((item) => item.format === "stream" && item.batches.length > 0)!;
    const bytes = blob(fixture.image), bodyStart = recordFrames(bytes, false)[0]!.bodyOffset;
    let at = 0, bodyRequests = 0, cancellations = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= bodyStart) {
          bodyRequests++;
          controller.error(new Error("Body acquisition was not admitted."));
          return;
        }
        const end = Math.min(bodyStart, at + 8);
        controller.enqueue(bytes.subarray(at, end));
        at = end;
      },
      cancel() {
        cancellations++;
      },
    }, { highWaterMark: 0 });
    await failure(() => readArrow(stream, { maxBatches: 0 }).next(), "budget-exceeded");
    expect(at).toBe(bodyStart);
    expect(bodyRequests).toBe(0);
    expect(cancellations).toBe(1);
    expect(stream.locked).toBe(false);
  });
  it("checks all five native streams across split prefixes, metadata and bodies against originals", async () => {
    const streams = fixtures().filter((fixture) => fixture.format === "stream");
    expect(streams.length).toBe(5);
    for (const fixture of streams) {
      const observed = observedStream(blob(fixture.image));
      let index = 0;
      for await (const batch of readArrow(observed.stream)) {
        expect(batch.batch).toBe(index);
        expect(batch.rows).toBe(fixture.batches[index]!.rows);
        expect(batch.schema.fields.map((field) => field.name)).toEqual(names);
        expect(Object.isFrozen(batch.schema)).toBe(true);
        expect(batch.integrity).toBe("none");
        expect(batch.scope).toBe("selected-columns");
        batch.columns.forEach((column, ordinal) =>
          original(column, fixture.batches[index]!.originals, names[ordinal]!)
        );
        index++;
      }
      expect(index).toBe(fixture.batches.length);
      expect(observed.stream.locked).toBe(false);
      expect(observed.cancellations()).toBe(0);
    }
  });
  it("accepts explicit EOS and clean message-boundary EOF but rejects trailing bytes and partial frames", async () => {
    const fixture = fixtures().find((item) =>
      item.format === "stream" && item.batches.some((batch) => batch.rows > 0)
    )!;
    const bytes = blob(fixture.image), record = recordFrames(bytes, false).find((frame) => frame.bodyLength > 0)!;
    expect(await drain(observedStream(bytes).stream)).toBe(fixture.batches.length);
    expect(await drain(observedStream(bytes.subarray(0, -8)).stream)).toBe(fixture.batches.length);
    for (
      const truncated of [
        bytes.subarray(0, 4),
        bytes.subarray(0, 20),
        bytes.subarray(0, record.bodyOffset + 1),
        bytes.subarray(0, -1),
      ]
    ) {
      const observed = observedStream(truncated);
      await failure(() => drain(observed.stream), "invalid-archive");
      expect(observed.stream.locked).toBe(false);
    }
    const trailing = observedStream(Buffer.concat([bytes, Buffer.from([0])]));
    await failure(() => drain(trailing.stream), "invalid-archive");
    expect(trailing.stream.locked).toBe(false);
  });
  it("does not acquire a reader before demand and cancels exactly once on early iterator return", async () => {
    const fixture = fixtures().find((item) => item.format === "stream" && item.batches.length > 1)!;
    const observed = observedStream(blob(fixture.image)), iterator = readArrow(observed.stream, { columns: [0] });
    expect(observed.pulls()).toBe(0);
    expect(observed.stream.locked).toBe(false);
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(observed.stream.locked).toBe(true);
    const pulls = observed.pulls();
    await iterator.return(undefined);
    expect(observed.cancellations()).toBe(1);
    expect(observed.stream.locked).toBe(false);
    expect(observed.pulls()).toBe(pulls);
  });
  it("cancels a readable source on malformed metadata and preserves a pending-read abort reason", async () => {
    const fixture = fixtures().find((item) => item.format === "stream" && item.batches.length > 0)!;
    const bytes = blob(fixture.image);
    bytes.writeInt32LE(-8, 4);
    const malformed = observedStream(bytes);
    await failure(() => drain(malformed.stream), "invalid-archive");
    expect(malformed.cancellations()).toBe(1);
    expect(malformed.stream.locked).toBe(false);
    let entered: () => void = () => {
      throw new Error("Read readiness was not installed.");
    };
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let cancellations = 0, canceledReason: unknown;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        entered();
      },
      cancel(reason) {
        cancellations++;
        canceledReason = reason;
      },
    }, { highWaterMark: 0 });
    const controller = new AbortController(), reason = new Error("abort pending Arrow source");
    const iterator = readArrow(stream, { signal: controller.signal }), pending = iterator.next();
    await ready;
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(cancellations).toBe(1);
    expect(canceledReason).toBe(reason);
    expect(stream.locked).toBe(false);
  });
  it("consumes excluded stream bytes without claiming to decode them and enforces aggregate work", async () => {
    const fixture = fixtures().find((item) =>
      item.format === "stream" && item.batches.some((batch) => batch.rows > 0)
    )!;
    const bytes = blob(fixture.image),
      index = fixture.batches.findIndex((batch) => batch.rows > 0),
      frame = recordFrames(bytes, false)[index]!;
    bytes.writeInt32LE(-1, frame.bodyOffset + frame.buffers[12]!.offset);
    const selected = observedStream(bytes);
    let count = 0;
    for await (const batch of readArrow(selected.stream, { columns: [0] })) {
      expect(batch.columns.length).toBe(1);
      expect(batch.scope).toBe("selected-columns");
      original(batch.columns[0]!, fixture.batches[count]!.originals, "i");
      count++;
    }
    expect(count).toBe(fixture.batches.length);
    const rejected = observedStream(bytes);
    await failure(async () => {
      for await (const _batch of readArrow(rejected.stream, { columns: [5] })) { /* Consume each admitted batch. */ }
    }, "invalid-archive");
    expect(rejected.stream.locked).toBe(false);
    expect(rejected.cancellations()).toBe(1);
    const bounded = observedStream(bytes, [8]);
    await failure(async () => {
      for await (
        const _batch of readArrow(bounded.stream, { maxSourceBytes: 8 })
      ) { /* Exhaust the aggregate allowance. */ }
    }, "budget-exceeded");
    expect(bounded.stream.locked).toBe(false);
    expect(bounded.cancellations()).toBe(1);
  });
});
