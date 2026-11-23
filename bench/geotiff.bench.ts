import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { createByteSource } from "../src/source.ts";
import { openGeotiff } from "../src/dataset/geotiff.ts";
import fixture from "../tests/fixtures/geotiff/independent.json" with { type: "json" };
import { expectBytes, report } from "./result.ts";

// Distinct contracts: borrowed physical copy, cold metadata, logical windows,
// complete logical raster, raw padded tile and pure planning. No codec/render/SDK comparison.
function equal(actual: number | undefined, expected: number | string): boolean {
  if (expected === "nan") return Number.isNaN(actual);
  if (expected === "-zero") return Object.is(actual, -0);
  if (expected === "+infinity") return actual === Infinity;
  if (expected === "-infinity") return actual === -Infinity;
  return Object.is(actual, expected);
}
const profile = "classic-geotiff-raw" as const;
for (const native of fixture.fixtures) {
  const raster = await openGeotiff(createByteSource(decodeBase64(native.file.base64)), { profile });
  if (raster.images.length !== native.pages.length) throw new Error("GeoTIFF preflight image count mismatch.");
  for (let id = 0; id < native.pages.length; id++) {
    const original = native.pages[id]!, image = raster.images[id]!;
    const rectangle = { x: 0, y: 0, width: image.width, height: image.height };
    const result = await raster.read(id, rectangle), planned = raster.plan(id, rectangle);
    if (result.values.length !== original.originalValues.length) {
      throw new Error("GeoTIFF preflight value count mismatch.");
    }
    for (let i = 0; i < result.values.length; i++) {
      if (!equal(result.values[i], original.originalValues[i]!)) {
        throw new Error(`GeoTIFF preflight sample ${native.name}/${id}/${i}.`);
      }
    }
    if (result.work.sourceBytes !== planned.sourceBytes || result.work.requests !== planned.requests) {
      throw new Error("GeoTIFF preflight planned work mismatch.");
    }
    for (let block = 0; block < original.blocks.length; block++) {
      const source = raster.source(id, block);
      expectBytes(
        await source.read(0, source.size),
        decodeBase64(original.blocks[block]!.raw.base64),
        `geotiff/${native.name}/${id}/${block}/complete-bits`,
      );
    }
  }
}
const native = fixture.fixtures.find((f) => f.name === "f32-tiles")!, page = native.pages[0]!;
const bytes = decodeBase64(native.file.base64), input = createByteSource(bytes, { identity: "native-f32-tiles" });
const allowance = {
  maxSourceBytes: 64 * 1024 ** 3,
  maxDecodedBytes: 64 * 1024 ** 3,
  maxOutputBytes: 64 * 1024 ** 3,
  maxRequests: 10000000,
};
const raster = await openGeotiff(input, { profile, ...allowance });
const early = { x: 0, y: 0, width: 4, height: 4 },
  late = { x: 16, y: 15, width: 3, height: 2 },
  full = { x: 0, y: 0, width: 19, height: 17 };
for (const rectangle of [early, late, full]) {
  const result = await raster.read(0, rectangle), planned = raster.plan(0, rectangle);
  if (
    result.integrity !== "not-provided" || result.work.sourceBytes !== planned.sourceBytes ||
    result.work.requests !== planned.requests
  ) throw new Error("GeoTIFF lane preflight scope/work mismatch.");
  for (let y = 0; y < rectangle.height; y++) {
    for (let x = 0; x < rectangle.width; x++) {
      const expected = page.originalValues[(rectangle.y + y) * 19 + rectangle.x + x]!;
      if (!equal(result.values[y * rectangle.width + x], expected)) {
        throw new Error("GeoTIFF selected lane original sample mismatch.");
      }
    }
  }
}
const block = raster.source(0, 0, allowance), originalBlock = decodeBase64(page.blocks[0]!.raw.base64);
expectBytes(await input.read(page.blocks[0]!.offset, 64), originalBlock.subarray(0, 64), "geotiff/direct64");
expectBytes(await block.read(0, block.size), originalBlock, "geotiff/rawtile");
const label = (rectangle: typeof early) => {
  const p = raster.plan(0, rectangle);
  return `pixels=${p.pixels} source=${p.sourceBytes}B requests=${p.requests} decoded=${p.decodedBytes}B output=${p.outputBytes}B spans=${p.spans} chunks=${p.chunks}`;
};
bench(
  "geotiff borrowed-physical-copy lower-bound 64B validation=none conversion=none",
  async () => do_not_optimize(await input.read(page.blocks[0]!.offset, 64)),
);
bench(
  `geotiff cold-main-chain-metadata images=1 source=${raster.work.sourceBytes}B requests=${raster.work.requests} entries=${raster.work.entries} blocks=4`,
  async () => do_not_optimize(await openGeotiff(input, { profile })),
);
bench(
  `geotiff early-f32-window ${label(early)} NaN+negative-zero integrity=not-provided`,
  async () => do_not_optimize(await raster.read(0, early)),
);
bench(
  `geotiff late-tile-edge-window ${label(late)} padding=excluded integrity=not-provided`,
  async () => do_not_optimize(await raster.read(0, late)),
);
bench(
  `geotiff complete-logical-f32-raster ${label(full)} padding=excluded integrity=not-provided`,
  async () => do_not_optimize(await raster.read(0, full)),
);
bench(
  `geotiff complete-physical-tile raw=${block.size}B numeric-conversion=none integrity=not-provided`,
  async () => do_not_optimize(await block.read(0, block.size)),
);
bench(
  `geotiff pure-window-plan ${label(late)} actual-IO=none reservation=none`,
  () => do_not_optimize(raster.plan(0, late)),
);
await report();
