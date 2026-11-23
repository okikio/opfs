import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { openQcow2 } from "../src/image/qcow2.ts";
import type { Qcow2ImageType } from "../src/image/qcow2.ts";
import { expectBytes, report } from "./result.ts";
import native from "../tests/fixtures/qcow2/independent.json" with { type: "json" };

// Question: what does cold mapping acquisition cost compared with warm selected
// bytes, and do holes/preallocated zeros avoid payload requests? The already-raw
// Blob lane is a lower bound: it performs no QCOW2 indexing or budget admission.
function fixture(name: string) {
  const item = native.fixtures.find((item) => item.case === name);
  if (!item) throw new Error(`QCOW2 benchmark native original is missing: ${name}`);
  const bytes = decodeBase64(item.image.base64), original = decodeBase64(item.original.base64);
  return {
    source: createBlobSource(new Blob([new Uint8Array(bytes).buffer])),
    imageBytes: bytes.length,
    original,
    cluster: item.observed.clusterSize,
  };
}
const small = fixture("compat1.1-cluster512"), large = fixture("compat1.1-cluster65536");
const range = fixture("compat1.1-cluster4096"), zero = fixture("zero-v3");
// Sampling shares finite lifetime authority. These 1-TiB/10-million-request
// allowances belong to this benchmark, not production. Per-read caps stay at
// their ordinary defaults. No full fixture is attached to Mitata context/args.
const allowance = {
  maxSourceBytes: 1024 ** 4,
  maxDecodedBytes: 1024 ** 4,
  maxOutputBytes: 1024 ** 4,
  maxRequests: 10_000_000,
};
const smallIndex = await openQcow2(small.source);
const largeIndex = await openQcow2(large.source);
const warm = await openQcow2(range.source, allowance);
const warmLarge = await openQcow2(large.source, allowance);
const warmZero = await openQcow2(zero.source, allowance);
for (
  const [name, image, original] of [
    ["small", smallIndex, small.original],
    ["large", largeIndex, large.original],
    ["range", warm, range.original],
    ["warm-full", warmLarge, large.original],
    ["zero", warmZero, zero.original],
  ] as const
) expectBytes((await image.read()).bytes, original, `qcow2/${name}/complete-original`);
const offset = 17, length = 37;
const decoded = new Blob([new Uint8Array(range.original).buffer]);
expectBytes(new Uint8Array(await decoded.arrayBuffer()), range.original, "qcow2/native-raw-complete-original");
expectBytes(
  new Uint8Array(await decoded.slice(offset, offset + length).arrayBuffer()),
  range.original.slice(offset, offset + length),
  "qcow2/native-raw-range",
);
bench(
  `qcow2 native already-raw Blob output=${length}B source=${length}B requests=1 integrity=none index=absent`,
  async () => {
    do_not_optimize(await decoded.slice(offset, offset + length).arrayBuffer());
  },
);
for (const [item, image] of [[small, smallIndex], [large, largeIndex]] as const) {
  bench(
    `qcow2 cold index image=${item.imageBytes}B cluster=${item.cluster}B guest=${item.original.length}B source=${image.work.sourceBytes}B requests=${image.work.requests} decoded=${image.work.decodedBytes}B output=0B integrity=none`,
    async () => {
      do_not_optimize(await openQcow2(item.source));
    },
  );
}
async function selected(
  name: string,
  image: Qcow2ImageType,
  original: Uint8Array,
  start: number,
  kind: string,
): Promise<void> {
  const check = await image.read({ offset: start, length });
  expectBytes(check.bytes, original.slice(start, start + length), `qcow2/${name}/selected-original`);
  const mapping = image.map(start, length);
  if (mapping.length !== 1 || mapping[0]!.kind !== kind || check.integrity !== "none") {
    throw new Error("QCOW2 benchmark selected mapping differs from its intended workload.");
  }
  if (kind !== "allocated" && (check.work.sourceBytes !== 0 || check.work.requests !== 0)) {
    throw new Error("QCOW2 zero-region benchmark performed payload I/O.");
  }
  bench(
    `qcow2 warm ${name} guest=${original.length}B offset=${start}B source=${check.work.sourceBytes}B requests=${check.work.requests} decoded=${check.work.decodedBytes}B output=${length}B integrity=none index=prebuilt`,
    async () => {
      do_not_optimize(await image.read({ offset: start, length }));
    },
  );
}
await selected("allocated", warm, range.original, offset, "allocated");
await selected("hole", warm, range.original, 4096, "hole");
await selected("preallocated-zero", warmZero, zero.original, 4096, "zero");
const full = await warmLarge.read();
expectBytes(full.bytes, large.original, "qcow2/warm-full-original");
bench(
  `qcow2 warm full guest=${large.original.length}B image=${large.imageBytes}B source=${full.work.sourceBytes}B requests=${full.work.requests} decoded=${full.work.decodedBytes}B output=${full.bytes.length}B integrity=none index=prebuilt`,
  async () => {
    do_not_optimize(await warmLarge.read());
  },
);
const cold = await openQcow2(range.source), coldRead = await cold.read({ offset, length });
expectBytes((await cold.read()).bytes, range.original, "qcow2/cold-open-plus-read-complete-original");
expectBytes(
  coldRead.bytes,
  range.original.slice(offset, offset + length),
  "qcow2/cold-open-plus-read-selected-original",
);
bench(
  `qcow2 cold open+read image=${range.imageBytes}B cluster=${range.cluster}B output=${length}B source=${
    cold.work.sourceBytes + coldRead.work.sourceBytes
  }B requests=${cold.work.requests + coldRead.work.requests} decoded=${
    cold.work.decodedBytes + coldRead.work.decodedBytes
  }B integrity=none`,
  async () => {
    const image = await openQcow2(range.source);
    do_not_optimize(await image.read({ offset, length }));
  },
);
await report();
