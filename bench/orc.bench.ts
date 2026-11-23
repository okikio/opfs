import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { openOrc } from "../src/dataset/orc.ts";
import type { OrcDatasetType, OrcValuesType } from "../src/dataset/orc.ts";
import type { ByteSourceType } from "../src/source.ts";
import { expectBytes, report } from "./result.ts";
import native from "../tests/fixtures/orc/independent.json" with { type: "json" };

// Question: what do footer indexing and complete selected-stripe decoding cost
// when a preview needs only seven rows crossing a stripe boundary?
// The raw decoded Blob is a copy lower bound, not an equivalent ORC reader.
interface FixtureType {
  readonly source: ByteSourceType;
  readonly bytes: number;
  readonly original: Uint8Array;
  readonly mask: Uint8Array;
  readonly name: string;
  readonly column: string;
}

/** Interpret original little-endian value bytes independently of the reader. */
function expected(name: string, bytes: Uint8Array, row: number): number | bigint {
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
      throw new Error("Unknown native ORC original column.");
  }
}

/** NaNs have value semantics; signed zero and exact bigint remain significant. */
function expectValues(actual: OrcValuesType, name: string, original: Uint8Array, offset: number, count: number): void {
  if (actual.length !== count) throw new Error("ORC benchmark output row count differs.");
  const constructor = name === "b"
    ? Uint8Array
    : name === "y"
    ? Int8Array
    : name === "s"
    ? Int16Array
    : name === "i"
    ? Int32Array
    : name === "q"
    ? BigInt64Array
    : name === "f"
    ? Float32Array
    : Float64Array;
  if (!(actual instanceof constructor)) throw new Error("ORC benchmark typed output differs.");
  for (let row = 0; row < count; row++) {
    if (!Object.is(actual[row], expected(name, original, offset + row))) {
      throw new Error("ORC benchmark original value differs.", { cause: { name, row: offset + row } });
    }
  }
}

// Every native fixture is checked before registration or timing. Modern integer
// DIRECT_V2 columns must refuse; success would silently broaden the benchmark's
// profile. Empty columns require no selected body I/O.
for (const fixture of native.fixtures) {
  const bytes = decodeBase64(fixture.file.base64);
  if (bytes.length !== fixture.file.bytes) throw new Error("ORC benchmark fixture extent differs.");
  const dataset = await openOrc(createBlobSource(new Blob([new Uint8Array(bytes).buffer])));
  if (
    dataset.rows !== fixture.rows || dataset.formatVersion !== fixture.fileVersion ||
    dataset.contentLengthBasis !== fixture.contentLengthBasis
  ) {
    throw new Error("ORC benchmark native metadata differs.");
  }
  for (const column of fixture.columns) {
    const declared = dataset.columns.find((item) => item.name === column.name);
    if (!declared) throw new Error("ORC benchmark original column is absent.");
    if (fixture.rows !== 0 && fixture.fileVersion === "0.12" && ["s", "i", "q"].includes(column.name)) {
      const failures: unknown[] = [];
      try {
        await dataset.read(declared.id);
      } catch (reason) {
        failures.push(reason);
      }
      const failure = failures[0];
      if (
        failures.length !== 1 || failure === null || typeof failure !== "object" || !("code" in failure) ||
        failure.code !== "unsupported-profile"
      ) {
        throw new Error("ORC benchmark DIRECT_V2 control did not refuse with its profile error.");
      }
      continue;
    }
    const original = decodeBase64(column.physicalLittleEndian.base64), mask = decodeBase64(column.validity.base64);
    const full = await dataset.read(declared.id);
    expectValues(full.values, column.name, original, 0, fixture.rows);
    expectBytes(full.validity, mask, `orc/${fixture.name}/${column.name}/full-mask`);
    if (full.integrity !== "none" || full.scope !== "selected-column-stripes") {
      throw new Error("ORC benchmark integrity scope differs.");
    }
    if (fixture.rows === 0 && (full.work.requests !== 0 || full.work.sourceBytes !== 0)) {
      throw new Error("ORC empty selection acquired a body.");
    }
    const offset = fixture.rows > 256 ? 253 : Math.min(fixture.rows, 1), length = Math.min(fixture.rows - offset, 7);
    const selected = await dataset.read(declared.id, { offset, length });
    expectValues(selected.values, column.name, original, offset, length);
    expectBytes(
      selected.validity,
      mask.slice(offset, offset + length),
      `orc/${fixture.name}/${column.name}/selected-mask`,
    );
    if (fixture.rows > 256 && fixture.nulls !== "all" && selected.stripes.length !== 2) {
      throw new Error("ORC preview does not cross two native stripes.");
    }
  }
}

function fixture(name: string, column: string): FixtureType {
  const item = native.fixtures.find((item) => item.name === name),
    original = item?.columns.find((item) => item.name === column);
  if (!item || !original) throw new Error("ORC timed fixture is absent.");
  const bytes = decodeBase64(item.file.base64);
  return {
    source: createBlobSource(new Blob([new Uint8Array(bytes).buffer])),
    bytes: bytes.length,
    original: decodeBase64(original.physicalLittleEndian.base64),
    mask: decodeBase64(original.validity.base64),
    name,
    column,
  };
}

// Lifetime aggregate allowances are finite benchmark policy. Per-read admission,
// parser limits and physical selected-stream checks retain their ordinary caps.
const allowance = {
  maxSourceBytes: 1024 ** 4,
  maxDecodedBytes: 1024 ** 4,
  maxOutputBytes: 1024 ** 4,
  maxRequests: 10_000_000,
};
const integer = fixture("0.11-8192-mixed.orc", "i"), ieee = fixture("0.12-8192-mixed.orc", "f");
const offset = 253, length = 7;
const warm: { readonly fixture: FixtureType; readonly dataset: OrcDatasetType; readonly id: number }[] = [];
for (const item of [integer, ieee]) {
  const dataset = await openOrc(item.source, allowance),
    id = dataset.columns.find((column) => column.name === item.column)?.id;
  if (id === undefined) throw new Error("ORC timed column is absent.");
  warm.push({ fixture: item, dataset, id });
  const selected = await dataset.read(id, { offset, length });
  expectValues(selected.values, item.column, item.original, offset, length);
  expectBytes(selected.validity, item.mask.slice(offset, offset + length), `orc/${item.name}/timed-mask`);
  if (selected.stripes.length !== 2) throw new Error("ORC timed selection must cross a stripe boundary.");
  bench(
    `orc cold index ${item.name} file=${item.bytes}B rows=${dataset.rows} source=${dataset.work.sourceBytes}B requests=${dataset.work.requests} decoded=${dataset.work.decodedBytes}B integrity=none`,
    async () => {
      do_not_optimize(await openOrc(item.source));
    },
  );
  bench(
    `orc warm selected ${item.name} column=${item.column} rows=${length} stripes=2 source=${selected.work.sourceBytes}B requests=${selected.work.requests} decoded=${selected.work.decodedBytes}B output=${selected.work.outputBytes}B integrity=none scope=complete-selected-column-stripes`,
    async () => {
      do_not_optimize(await dataset.read(id, { offset, length }));
    },
  );
}
const first = warm[0]!;
const full = await first.dataset.read(first.id);
expectValues(full.values, first.fixture.column, first.fixture.original, 0, first.dataset.rows);
expectBytes(full.validity, first.fixture.mask, "orc/timed-full-mask");
bench(
  `orc warm full ${integer.name} column=i rows=${first.dataset.rows} stripes=${full.stripes.length} source=${full.work.sourceBytes}B requests=${full.work.requests} decoded=${full.work.decodedBytes}B output=${full.work.outputBytes}B integrity=none`,
  async () => {
    do_not_optimize(await first.dataset.read(first.id));
  },
);
const cold = await openOrc(integer.source), selected = await cold.read(first.id, { offset, length });
expectValues(selected.values, "i", integer.original, offset, length);
expectBytes(selected.validity, integer.mask.slice(offset, offset + length), "orc/cold-selected-mask");
bench(
  `orc cold open+selected ${integer.name} column=i rows=${length} source=${
    cold.work.sourceBytes + selected.work.sourceBytes
  }B requests=${cold.work.requests + selected.work.requests} decoded=${
    cold.work.decodedBytes + selected.work.decodedBytes
  }B output=${selected.work.outputBytes}B integrity=none`,
  async () => {
    const dataset = await openOrc(integer.source);
    do_not_optimize(await dataset.read(first.id, { offset, length }));
  },
);
const raw = new Blob([new Uint8Array(integer.original).buffer]);
expectBytes(
  new Uint8Array(await raw.slice(offset * 4, (offset + length) * 4).arrayBuffer()),
  integer.original.slice(offset * 4, (offset + length) * 4),
  "orc/raw-original-copy",
);
bench(
  `orc already-decoded Blob lower-bound rows=${length} source=${length * 4}B output=${
    length * 4
  }B requests=1 mask=absent metadata=absent integrity=none`,
  async () => {
    do_not_optimize(await raw.slice(offset * 4, (offset + length) * 4).arrayBuffer());
  },
);
// ORC datasets acquire no native resources and expose no disposal operation.
// Borrowed immutable Blobs remain local to this harness; all calls are serial.
await report();
