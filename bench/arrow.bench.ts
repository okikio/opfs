/** Compare native-original column copies with bounded IPC preview work; this file is a benchmark entrypoint. */
import { bench, do_not_optimize } from "mitata";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createByteSource } from "../src/source.ts";
import { openArrow, readArrow } from "../src/dataset/arrow.ts";
import type { ArrowColumnType, ArrowReadType, ArrowStreamBatchType } from "../src/dataset/arrow.ts";
import { expectBytes, report } from "./result.ts";

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

// Corpus I/O, hash admission, native-original decoding and correctness checks all
// happen before benchmark registration. This harness never starts a native tool.
const envelope = readFileSync(
  fileURLToPath(new URL("../tests/fixtures/ipc/native/independent.json", import.meta.url).href),
);
if (
  envelope.length !== 106854 ||
  createHash("sha256").update(envelope).digest("hex") !==
    "09bac9152ccc959f35274cd8f47f3fa170517e6dd0823ea530532b73031d44d1"
) {
  throw new Error("Arrow benchmark frozen corpus admission failed.");
}
const corpus = (JSON.parse(envelope.toString("utf8")) as { fixtures: FixtureType[] }).fixtures;
function blob(item: BlobType): Uint8Array<ArrayBuffer> {
  const bytes = Buffer.from(item.base64, "base64");
  if (bytes.length !== item.bytes || createHash("sha256").update(bytes).digest("hex") !== item.sha256) {
    throw new Error("Arrow benchmark native blob admission failed.");
  }
  return new Uint8Array(bytes);
}
function fixture(name: string): FixtureType {
  const found = corpus.find((item) => item.name === name);
  if (found === undefined) throw new Error(`Arrow benchmark native fixture absent: ${name}`);
  return found;
}

/** Decode authored originals independently; native IPC never supplies these expectations. */
function originals(batch: OriginalType): ArrowColumnType[] {
  return ["i", "q", "d", "b", "s", "x"].map((key, ordinal): ArrowColumnType => {
    const validity = blob(batch.originals[`${key}.validity`]!),
      base = { ordinal, name: key, rows: batch.rows, validity, outputBytes: 0 };
    if (key === "s" || key === "x") {
      const offsetBytes = blob(batch.originals[`${key}.offsets`]!),
        view = new DataView(offsetBytes.buffer, offsetBytes.byteOffset, offsetBytes.byteLength);
      const offsets = Int32Array.from({ length: batch.rows + 1 }, (_, row) => view.getInt32(row * 4, true));
      const payload = blob(batch.originals[`${key}.data`]!);
      if (key === "x") return { ...base, physical: "binary", offsets, values: payload };
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      return {
        ...base,
        physical: "utf8",
        values: Array.from(
          { length: batch.rows },
          (_, row) => decoder.decode(payload.subarray(offsets[row]!, offsets[row + 1]!)),
        ),
      };
    }
    const bytes = blob(batch.originals[`${key}.bin`]!),
      view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (key === "i") {
      return {
        ...base,
        physical: "int32",
        values: Int32Array.from({ length: batch.rows }, (_, row) => view.getInt32(row * 4, true)),
      };
    }
    if (key === "q") {
      return {
        ...base,
        physical: "int64",
        values: BigInt64Array.from({ length: batch.rows }, (_, row) => view.getBigInt64(row * 8, true)),
      };
    }
    if (key === "d") {
      return {
        ...base,
        physical: "float64",
        values: Float64Array.from({ length: batch.rows }, (_, row) => view.getFloat64(row * 8, true)),
      };
    }
    return { ...base, physical: "boolean", values: bytes };
  });
}

/** Strings are immutable and their reference array is copied; no UTF-8 validation occurs in this lower bound. */
function copy(column: ArrowColumnType): ArrowColumnType {
  const validity = column.validity.slice();
  switch (column.physical) {
    case "int32":
      return { ...column, validity, values: column.values.slice() };
    case "int64":
      return { ...column, validity, values: column.values.slice() };
    case "float64":
      return { ...column, validity, values: column.values.slice() };
    case "boolean":
      return { ...column, validity, values: column.values.slice() };
    case "utf8":
      return { ...column, validity, values: column.values.slice() };
    case "binary":
      return { ...column, validity, values: column.values.slice(), offsets: column.offsets.slice() };
  }
}

/** Compare complete columns outside timing, including IEEE value semantics and binary offsets. */
function compare(actual: readonly ArrowColumnType[], expected: readonly ArrowColumnType[]): void {
  if (actual.length !== expected.length) throw new Error("Arrow benchmark column cardinality differs.");
  for (let index = 0; index < actual.length; index++) {
    const column = actual[index]!, original = expected[index]!;
    if (
      column.ordinal !== original.ordinal || column.name !== original.name || column.rows !== original.rows ||
      column.physical !== original.physical
    ) throw new Error("Arrow benchmark column identity differs.");
    expectBytes(column.validity, original.validity, "arrow/native-original-mask");
    if (column.physical === "binary" && original.physical === "binary") {
      expectBytes(column.values, original.values, "arrow/native-original-binary");
      if (
        column.offsets.length !== original.offsets.length ||
        column.offsets.some((value, row) => value !== original.offsets[row])
      ) throw new Error("Arrow benchmark binary offsets differ.");
    } else {
      if (column.values.length !== original.values.length) throw new Error("Arrow benchmark value count differs.");
      for (let row = 0; row < column.values.length; row++) {
        if (!Object.is(column.values[row], original.values[row])) {
          throw new Error("Arrow benchmark full original value differs.");
        }
      }
    }
  }
}
function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at === bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.length, at + 65536);
      controller.enqueue(bytes.subarray(at, end));
      at = end;
    },
  }, { highWaterMark: 0 });
}
async function forward(bytes: Uint8Array): Promise<ArrowStreamBatchType[]> {
  const source = stream(bytes), batches: ArrowStreamBatchType[] = [];
  for await (const batch of readArrow(source)) batches.push(batch);
  if (source.locked) throw new Error("Arrow benchmark forward reader retained its lock.");
  return batches;
}

const file = fixture("mixed-multibatch-file"), sequential = fixture("mixed-multibatch-stream");
const fileBytes = blob(file.image), streamBytes = blob(sequential.image), source = createByteSource(fileBytes);
const expected = file.batches.map(originals), ids = [0, 1, 2, 3, 4, 5];
const dataset = await openArrow(source), indexed: ArrowReadType[] = [];
if (dataset.batches.length !== expected.length) throw new Error("Arrow benchmark native batch index differs.");
for (let batch = 0; batch < expected.length; batch++) {
  const result = await dataset.read(batch, ids);
  compare(result.columns, expected[batch]!);
  indexed.push(result);
  compare(expected[batch]!.map(copy), expected[batch]!);
}
const streamed = await forward(streamBytes);
if (streamed.length !== expected.length) throw new Error("Arrow benchmark native stream batch count differs.");
for (let batch = 0; batch < streamed.length; batch++) compare(streamed[batch]!.columns, expected[batch]!);
for (const batch of [...indexed, ...streamed]) {
  if (batch.integrity !== "none" || batch.scope !== "selected-columns") {
    throw new Error("Arrow benchmark validation scope differs.");
  }
}
const rows = file.batches.reduce((total, batch) => total + batch.rows, 0);
const work = indexed.reduce(
  (total, batch) => ({
    sourceBytes: total.sourceBytes + batch.work.sourceBytes,
    requests: total.requests + batch.work.requests,
    outputBytes: total.outputBytes + batch.work.outputBytes,
  }),
  { sourceBytes: dataset.work.sourceBytes, requests: dataset.work.requests, outputBytes: dataset.work.outputBytes },
);
const lastStreamWork = streamed.at(-1)!.work;

// These are three different workloads, not equivalent validators or independent
// engines. Native-original copies omit framing/schema/null/offset/UTF-8 checks.
// Report source/request/output accounting, not heap or allocation measurements.
bench(
  `arrow trusted-native-original six-column copies lower-bound rows=${rows} batches=3 strings=reference-copies IPC-validation=absent`,
  () => {
    do_not_optimize(expected.map((batch) => batch.map(copy)));
  },
);
bench(
  `arrow file open+all-six-selected-column reads rows=${rows} batches=3 file=${fileBytes.length}B source=${work.sourceBytes}B requests=${work.requests} output-allowance=${work.outputBytes}B integrity=none`,
  async () => {
    const opened = await openArrow(source), results: ArrowReadType[] = [];
    for (let batch = 0; batch < opened.batches.length; batch++) results.push(await opened.read(batch, ids));
    do_not_optimize(results);
  },
);
bench(
  `arrow forward all-six-column reads rows=${rows} batches=3 stream=${streamBytes.length}B last-yield-source=${lastStreamWork.sourceBytes}B last-yield-pulls=${lastStreamWork.requests} output-allowance=${lastStreamWork.outputBytes}B chunk=65536B integrity=none`,
  async () => {
    do_not_optimize(await forward(streamBytes));
  },
);
await report();
