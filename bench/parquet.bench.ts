import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { openParquet } from "../src/dataset/parquet.ts";
import { expectBytes, report } from "./result.ts";
import native from "../tests/fixtures/parquet/independent.json" with { type: "json" };

// Question: what do cold footer indexing and warm selected-page acquisition cost?
// The already-decoded Blob is a lower bound: it has no null mask, footer, page
// planning, or CRC validation. It is not an equivalent competing Parquet reader.
function fixture(name: string) {
  const item = native.fixtures.find((item) => item.case === name);
  const original = item?.columns.find((column) => column.name === "i");
  if (!item || !original) throw new Error(`Parquet benchmark original missing: ${name}`);
  const bytes = decodeBase64(item.file.base64);
  return {
    source: createBlobSource(new Blob([new Uint8Array(bytes).buffer])),
    size: bytes.length,
    rows: item.rows,
    original: decodeBase64(original.physicalLittleEndian.base64),
    mask: decodeBase64(original.validity.base64),
  };
}
const arrow = fixture("arrow-many-pages-2.0-True"), duck = fixture("duckdb-many-pages");
// Sampling owns finite aggregate lifetime allowances; ordinary per-read caps stay
// unchanged. These are benchmark policies, not production defaults.
const allowance = {
  maxSourceBytes: 1024 ** 4,
  maxDecodedBytes: 1024 ** 4,
  maxOutputBytes: 1024 ** 4,
  maxRequests: 10_000_000,
};
const warmArrow = await openParquet(arrow.source, allowance), warmDuck = await openParquet(duck.source, allowance);
const offset = 2000, length = 100;
function bytes(values: Int32Array): Uint8Array {
  const output = new Uint8Array(values.length * 4), view = new DataView(output.buffer);
  for (let index = 0; index < values.length; index++) view.setInt32(index * 4, values[index]!, true);
  return output;
}
for (const [name, item, dataset] of [["arrow", arrow, warmArrow], ["duck", duck, warmDuck]] as const) {
  const column = dataset.columns.find((column) => column.name === "i");
  if (!column) throw new Error("Parquet benchmark index lacks i column.");
  const full = await dataset.read(column.id);
  if (!(full.values instanceof Int32Array)) throw new Error("Parquet benchmark expected INT32.");
  expectBytes(bytes(full.values), item.original, `parquet/${name}/full-original`);
  expectBytes(full.validity, item.mask, `parquet/${name}/full-mask`);
  const selected = await dataset.read(column.id, { offset, length });
  if (!(selected.values instanceof Int32Array)) throw new Error("Parquet benchmark expected selected INT32.");
  expectBytes(
    bytes(selected.values),
    item.original.slice(offset * 4, (offset + length) * 4),
    `parquet/${name}/selected`,
  );
  expectBytes(selected.validity, item.mask.slice(offset, offset + length), `parquet/${name}/selected-mask`);
  const check = name === "arrow" ? "crc32" : "absent";
  for (const page of selected.pages.filter((page) => page.selected)) {
    if (page.checksum !== (name === "arrow" ? "crc32-verified" : "not-provided")) {
      throw new Error("Parquet benchmark checksum profile differs from its intended lane.");
    }
  }
  bench(
    `parquet cold index ${name} file=${item.size}B rows=${item.rows} source=${dataset.work.sourceBytes}B requests=${dataset.work.requests} decoded=${dataset.work.decodedBytes}B integrity=metadata-unverified`,
    async () => {
      do_not_optimize(await openParquet(item.source));
    },
  );
  bench(
    `parquet warm selected ${name} rows=${length} source=${selected.work.sourceBytes}B requests=${selected.work.requests} decoded=${selected.work.decodedBytes}B output=${selected.work.outputBytes}B checksum=${check} scope=selected-pages`,
    async () => {
      do_not_optimize(await dataset.read(column.id, { offset, length }));
    },
  );
  if (name === "arrow") {
    bench(
      `parquet warm full arrow rows=${item.rows} source=${full.work.sourceBytes}B requests=${full.work.requests} decoded=${full.work.decodedBytes}B output=${full.work.outputBytes}B checksum=crc32 scope=selected-pages`,
      async () => {
        do_not_optimize(await dataset.read(column.id));
      },
    );
  }
}
const raw = new Blob([new Uint8Array(arrow.original).buffer]);
expectBytes(new Uint8Array(await raw.arrayBuffer()), arrow.original, "parquet/native-already-decoded-original");
expectBytes(
  new Uint8Array(await raw.slice(offset * 4, (offset + length) * 4).arrayBuffer()),
  arrow.original.slice(offset * 4, (offset + length) * 4),
  "parquet/native-selected-original",
);
bench(
  `parquet native already-decoded Blob rows=${length} output=${length * 4}B source=${
    length * 4
  }B requests=1 mask=absent integrity=none`,
  async () => {
    do_not_optimize(await raw.slice(offset * 4, (offset + length) * 4).arrayBuffer());
  },
);
const cold = await openParquet(arrow.source), column = cold.columns.find((column) => column.name === "i");
if (!column) throw new Error("Parquet cold benchmark column missing.");
const selected = await cold.read(column.id, { offset, length });
if (!(selected.values instanceof Int32Array)) throw new Error("Parquet cold benchmark expected INT32.");
expectBytes(
  bytes(selected.values),
  arrow.original.slice(offset * 4, (offset + length) * 4),
  "parquet/cold-selected-original",
);
expectBytes(selected.validity, arrow.mask.slice(offset, offset + length), "parquet/cold-selected-mask");
if (!selected.pages.every((page) => page.checksum === (page.selected ? "crc32-verified" : "not-read"))) {
  throw new Error("Parquet cold selected checksum scope differs from expected.");
}
// dataset.work is the frozen opening snapshot; read.work is operation-local.
// Neither label uses the mutable lifetime authority's cumulative counters.

bench(
  `parquet cold open+selected arrow rows=${length} source=${
    cold.work.sourceBytes + selected.work.sourceBytes
  }B requests=${cold.work.requests + selected.work.requests} decoded=${
    cold.work.decodedBytes + selected.work.decodedBytes
  }B output=${selected.work.outputBytes}B checksum=crc32 scope=selected-pages`,
  async () => {
    const dataset = await openParquet(arrow.source);
    do_not_optimize(await dataset.read(column.id, { offset, length }));
  },
);
await report();
