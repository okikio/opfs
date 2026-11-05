import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { openZarr } from "../src/dataset/zarr.ts";
import type { ZarrStoreType } from "../src/dataset/zarr.ts";
import { expectBytes, report } from "./result.ts";
import receipt from "../tests/fixtures/zarr/independent.json" with { type: "json" };

const bytesOf = (values: ArrayBufferView) => new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
function snapshot(item: typeof receipt.fixtures[number]): { store: ZarrStoreType; blobs: Map<string, Blob> } {
  const blobs = new Map(
    Object.entries(item.objects).map((
      [key, value],
    ) => [key, new Blob([new Uint8Array(decodeBase64(value.base64)).buffer])]),
  );
  return {
    blobs,
    store: {
      stability: "immutable",
      async open(key) {
        const blob = blobs.get(key);
        return blob === undefined ? undefined : createBlobSource(blob);
      },
    },
  };
}
const fixture = receipt.fixtures.find((item) => item.profile === "large")!;
const { store, blobs } = snapshot(fixture), original = decodeBase64(fixture.original.base64);
// Every sampling allowance is finite; per-read defaults remain independent limits.
const repeated = {
  maxSourceBytes: 64 * 1024 ** 3,
  maxDecodedBytes: 64 * 1024 ** 3,
  maxOutputBytes: 64 * 1024 ** 3,
  maxRequests: 100000000,
  maxObjects: 100000000,
};
const array = await openZarr(store, repeated);
expectBytes(bytesOf((await array.read()).values), original, "zarr/large/complete-original");
const cold = await openZarr(store);
const context = `zarr v2 float32 shape=${fixture.shape.join("x")} chunk=${fixture.chunks.join("x")} order=C`;
bench(
  `${context} cold metadata source=${cold.work.sourceBytes}B requests=${cold.work.requests} objects=${cold.work.objects}`,
  async () => do_not_optimize(await openZarr(store)),
);
for (const [offset, count] of [[1, 16], [60, 16], [0, array.elements]] as const) {
  const selected = await array.read({ offset, count });
  expectBytes(
    bytesOf(selected.values),
    original.subarray(offset * 4, (offset + count) * 4),
    "zarr/C-selection/preflight",
  );
  const label =
    `${context} offset=${offset} count=${count} source=${selected.work.sourceBytes}B requests=${selected.work.requests} objects=${selected.work.objects} output=${selected.work.outputBytes}B integrity=not-provided`;
  bench(`${label} warm numeric+mask`, async () => do_not_optimize(await array.read({ offset, count })));
  if (offset === 1) {
    const native = () => blobs.get("0.0")!.slice(4, 68).arrayBuffer();
    expectBytes(new Uint8Array(await native()), original.subarray(4, 68), "zarr/native-preindexed/preflight");
    bench(
      `${context} native preindexed Blob bytecopy source=64B requests=1 output=64B`,
      async () => do_not_optimize(await native()),
    );
  }
  if (count < 100) {
    bench(
      `${label} cold metadata+read`,
      async () => do_not_optimize(await (await openZarr(store)).read({ offset, count })),
    );
  }
}
for (const profile of ["F", "missing"]) {
  const item = receipt.fixtures.find((item) =>
    profile === "F"
      ? item.profile === "numeric" && item.dtype === "<i2" && item.order === "F"
      : item.profile === profile
  )!;
  const input = snapshot(item).store,
    reader = await openZarr(input, repeated),
    expected = decodeBase64(item.original.base64);
  const result = await reader.read();
  expectBytes(bytesOf(result.values), expected, "zarr/F-or-fill/complete-original");
  bench(
    `zarr v2 profile=${profile} elements=${reader.elements} source=${result.work.sourceBytes}B requests=${result.work.requests} objects=${result.work.objects} output=${result.work.outputBytes}B warm numeric+mask`,
    async () => do_not_optimize(await reader.read()),
  );
}
await report();
