import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { openHdf5 } from "../src/dataset/hdf5.ts";
import { createByteSource } from "../src/source.ts";
import fixture from "../tests/fixtures/hdf5/independent.json" with { type: "json" };
import { expectBytes, report } from "./result.ts";

// Question: what do cold classic metadata admission and selected typed conversion cost
// over already supplied immutable bytes? No acquisition, fixture decoding or HDF5 SDK
// is timed. Raw copying and converted numeric values are different output contracts.
const native = fixture.files[0]!;
const bytes = decodeBase64(native.bytesBase64);
const source = createByteSource(bytes, { identity: "native-hdf5-benchmark" });
const allowance = {
  maxSourceBytes: 64 * 1024 ** 3,
  maxRequests: 10000000,
  maxDecodedBytes: 64 * 1024 ** 3,
  maxOutputBytes: 64 * 1024 ** 3,
};
const file = await openHdf5(source, { profile: "classic-contiguous", ...allowance });
for (const oracle of native.datasets) {
  const dataset = await file.dataset(oracle.name, allowance);
  expectBytes(
    await dataset.source(allowance).read(0, dataset.byteLength),
    decodeBase64(oracle.originalBase64),
    `hdf5/native/${oracle.name}/physical`,
  );
  const result = await dataset.read();
  for (let i = 0; i < oracle.values.length; i++) {
    const expected = oracle.values[i]!, actual = result.values[i]!;
    let good = false;
    if ("integer" in expected) good = BigInt(actual) === BigInt(expected.integer!);
    else if ("float" in expected) {
      const v = expected.float;
      good = v === "nan"
        ? Number.isNaN(actual)
        : v === "-zero"
        ? Object.is(actual, -0)
        : v === "+infinity"
        ? actual === Infinity
        : v === "-infinity"
        ? actual === -Infinity
        : actual === v;
    }
    if (!good) throw new Error(`HDF5 typed preflight mismatch at ${oracle.name}/${i}.`);
  }
}
const grid = await file.dataset("grid", allowance), packed = grid.source(allowance);
const oracle = native.datasets.find((item) => item.name === "grid")!;
const full = decodeBase64(oracle.originalBase64), offset = 257, count = 128, physical = grid.dataAddress! + offset * 4;
expectBytes(
  await packed.read(offset * 4, count * 4),
  full.subarray(offset * 4, (offset + count) * 4),
  "hdf5/grid/range",
);
const selected = await grid.read({ offset, count }), whole = await grid.read();
for (let i = 0; i < count; i++) {
  if (selected.values[i] !== whole.values[offset + i]) throw new Error("HDF5 selected typed oracle mismatch.");
}
const cold = await openHdf5(source, { profile: "classic-contiguous" }), work = cold.work;
bench(
  `hdf5 borrowed-range lower-bound selected=${count * 4}B validation=none conversion=none`,
  async () => do_not_optimize(await source.read(physical, count * 4)),
);
bench(
  `hdf5 cold-root-index links=${native.rootLinks.length} source=${work.sourceBytes}B requests=${work.requests} metadata=${work.metadataBytes}B integrity=not-provided`,
  async () => do_not_optimize(await openHdf5(source, { profile: "classic-contiguous" })),
);
bench(`hdf5 cold-open-dataset grid=25x40 type=i32le source=metadata-only payload=not-read`, async () => {
  const opened = await openHdf5(source, { profile: "classic-contiguous" });
  do_not_optimize(await opened.dataset("grid"));
});
bench(
  `hdf5 raw-stored-range selected=${count * 4}B source=${count * 4}B conversion=none integrity=not-provided`,
  async () => do_not_optimize(await packed.read(offset * 4, count * 4)),
);
bench(
  `hdf5 typed-grid-range elements=${count} source=${selected.work.sourceBytes}B decoded=${selected.work.decodedBytes}B output=${selected.work.outputBytes}B integrity=not-provided`,
  async () => do_not_optimize(await grid.read({ offset, count })),
);
bench(
  `hdf5 typed-grid-full elements=${grid.elements} source=${whole.work.sourceBytes}B decoded=${whole.work.decodedBytes}B output=${whole.work.outputBytes}B integrity=not-provided`,
  async () => do_not_optimize(await grid.read()),
);
await report();
