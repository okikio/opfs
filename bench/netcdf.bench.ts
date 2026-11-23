import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { openNetcdf } from "../src/dataset/netcdf.ts";
import { expectBytes, report } from "./result.ts";
import receipt from "../tests/fixtures/netcdf/independent.json" with { type: "json" };

// An exact preindexed Blob copy is a useful native baseline for a single slab.
// It has no metadata parsing, numeric conversion, missing-value mask or integrity check.
const fixture = receipt.fixtures.find((item) => item.profile === "large" && item.version === 2)!;
const raw = decodeBase64(fixture.file.base64),
  blob = new Blob([new Uint8Array(raw).buffer]),
  source = createBlobSource(blob);
// Repeated timing samples need explicit finite lifetime policies. Record-heavy
// full reads also opt into more source segments/requests than the normal default.
const dataset = await openNetcdf(source, {
  maxSegments: 100000,
  maxSourceBytes: 64 * 1024 ** 3,
  maxDecodedBytes: 64 * 1024 ** 3,
  maxOutputBytes: 4 * 1024 ** 3,
  maxRequests: 100000000,
});
for (const original of fixture.variables) {
  const result = await dataset.read(original.id, { maxRequests: 100000 });
  expectBytes(
    new Uint8Array(result.values.buffer),
    decodeBase64(original.nativeLittleEndian.base64),
    `netcdf/${original.name}/complete-original`,
  );
}
const context = `netcdf CDF2 image=${raw.length}B records=${dataset.records} stride=${dataset.recordStride}B`;
const cold = await openNetcdf(source);
bench(
  `${context} cold index source=${cold.work.sourceBytes}B requests=${cold.work.requests} output=0B`,
  async () => do_not_optimize(await openNetcdf(source)),
);
const variable = dataset.variables.find((item) => item.name === "record_double")!;
const original = decodeBase64(fixture.variables.find((item) => item.id === variable.id)!.nativeLittleEndian.base64);
for (const [offset, count] of [[1, 2], [2, 5], [0, variable.elements]] as const) {
  const selected = await dataset.read(variable.id, { offset, count, maxRequests: 100000 });
  expectBytes(
    new Uint8Array(selected.values.buffer),
    original.subarray(offset * 8, (offset + count) * 8),
    "netcdf/selected/preflight",
  );
  const label =
    `${context} offset=${offset} count=${count} source=${selected.work.sourceBytes}B requests=${selected.work.requests} output=${selected.work.outputBytes}B integrity=not-provided`;
  bench(
    `${label} warm raw+mask`,
    async () => do_not_optimize(await dataset.read(variable.id, { offset, count, maxRequests: 100000 })),
  );
  if (count <= variable.recordElements - offset) {
    const native = () => blob.slice(variable.offset + offset * 8, variable.offset + (offset + count) * 8).arrayBuffer();
    expectBytes(
      new Uint8Array(await native()),
      raw.subarray(variable.offset + offset * 8, variable.offset + (offset + count) * 8),
      "netcdf/native-wire/preflight",
    );
    bench(
      `${context} native preindexed single-slab Blob bytecopy count=${count} source=${count * 8}B requests=1 output=${
        count * 8
      }B`,
      async () => do_not_optimize(await native()),
    );
  }
  if (count < 10) {
    bench(
      `${label} cold index+read`,
      async () => do_not_optimize(await (await openNetcdf(source)).read(variable.id, { offset, count })),
    );
  }
}
const packed = dataset.variables.find((item) => item.name === "record_short")!;
const physical = await dataset.read(packed.id, { offset: 2, count: 5, scale: "physical" });
const expected = Float64Array.of(11, 11.5, -378.5, 12.5, 13);
expectBytes(new Uint8Array(physical.values.buffer), new Uint8Array(expected.buffer), "netcdf/physical/preflight");
bench(
  `${context} warm packed physical+mask count=5 source=${physical.work.sourceBytes}B requests=${physical.work.requests} output=${physical.work.outputBytes}B`,
  async () => do_not_optimize(await dataset.read(packed.id, { offset: 2, count: 5, scale: "physical" })),
);
await report();
