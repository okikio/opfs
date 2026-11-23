import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { openUdf } from "../src/archive/udf.ts";
import { expectBytes, report } from "./result.ts";
import fixture from "../tests/fixtures/udf/independent.json" with { type: "json" };

// Question: what do directory indexing and repeated exact-range reads cost on
// one genuine UDF image? Native Blob receives preindexed physical addresses and
// omits directory parsing, metadata checks and ledgers. It is a range-read
// baseline, not a second filesystem implementation or a remote I/O measurement.
const samplingLimits = {
  maxSourceBytes: 64 * 1024 ** 3,
  maxDecodedBytes: 64 * 1024 ** 3,
  maxOutputBytes: 1024 ** 3,
  maxRequests: 10_000_000,
};
const raw = decodeBase64(fixture.archive);
const blob = new Blob([new Uint8Array(raw).buffer]);
const source = createBlobSource(blob);
const archive = await openUdf(source, samplingLimits);
const path = (id: number): string => {
  const entry = archive.entries[id]!;
  return entry.parentId < 0 ? entry.name : `${path(entry.parentId)}/${entry.name}`;
};
for (const entry of archive.entries) {
  if (entry.kind !== "file") continue;
  const original = fixture.entries.find((item) => item.name === path(entry.id));
  if (!original) throw new Error("UDF benchmark original payload oracle is missing.");
  expectBytes(
    (await archive.read(entry.id)).bytes,
    decodeBase64(original.body),
    `udf/${original.name}/complete-oracle`,
  );
}
const label = `udf/image=${raw.length}B entries=${archive.entries.length}`;
bench(
  `${label} cold index source=${archive.work.sourceBytes}B requests=${archive.work.requests} output-accounting=${archive.work.outputBytes}B`,
  async () => {
    do_not_optimize(await openUdf(source));
  },
);
const entry = archive.entries.find((entry) => entry.name === "large.bin")!;
const expected = decodeBase64(fixture.entries.find((item) => item.name === "large.bin")!.body);
if (entry.extents.length !== 1) {
  throw new Error("Native UDF benchmark baseline requires this fixture's single recorded extent.");
}
for (const offset of [0, 2040, entry.size - 37]) {
  const length = 37;
  const native = () =>
    blob.slice(entry.extents[0]!.offset + offset, entry.extents[0]!.offset + offset + length).arrayBuffer();
  const checked = await archive.read(entry.id, { offset, length });
  expectBytes(checked.bytes, expected.subarray(offset, offset + length), `udf/${offset}/selected-oracle`);
  expectBytes(
    new Uint8Array(await native()),
    expected.subarray(offset, offset + length),
    `udf/${offset}/native-oracle`,
  );
  if (checked.work.sourceBytes !== length || checked.work.requests !== 1 || checked.work.outputBytes !== length) {
    throw new Error("UDF exact selected-range accounting changed.");
  }
  const range = `${label} member=${entry.size}B offset=${offset}B output=${length}B`;
  bench(`${range} native preindexed Blob source=${length}B requests=1 integrity=none`, async () => {
    do_not_optimize(await native());
  });
  bench(
    `${range} warm range source=${checked.work.sourceBytes}B requests=${checked.work.requests} integrity=none`,
    async () => {
      do_not_optimize(await archive.read(entry.id, { offset, length }));
    },
  );
  bench(
    `${range} cold index+range source=${archive.work.sourceBytes + length}B requests=${archive.work.requests + 1}`,
    async () => {
      const cold = await openUdf(source);
      do_not_optimize(await cold.read(entry.id, { offset, length }));
    },
  );
}
await report();
