import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { createByteSource } from "../src/source.ts";
import { openShapefile } from "../src/dataset/shapefile.ts";
import fixture from "../tests/fixtures/shapefile/independent.json" with { type: "json" };
import { expectBytes, report } from "./result.ts";

// What do physical indexing, selected typed geometry and raw attributes cost over
// supplied native bytes? Source copying, decoding and correlated metadata are
// distinct contracts. No SDK, fixture acquisition or base64 parsing is timed.
const allowance = {
  maxSourceBytes: 64 * 1024 ** 3,
  maxRequests: 10000000,
  maxDecodedBytes: 64 * 1024 ** 3,
  maxOutputBytes: 64 * 1024 ** 3,
};
function sources(f: typeof fixture.fixtures[number]) {
  return {
    shp: createByteSource(decodeBase64(f.components.shp.data), { identity: `native-${f.name}-shp` }),
    shx: createByteSource(decodeBase64(f.components.shx.data), { identity: `native-${f.name}-shx` }),
    dbf: createByteSource(decodeBase64(f.components.dbf.data), { identity: `native-${f.name}-dbf` }),
  };
}
for (const native of fixture.fixtures) {
  const dataset = await openShapefile(sources(native), { profile: "shp2d-dbf3" });
  for (let id = 0; id < native.originals.length; id++) {
    const geometry = await dataset.read(id), original = native.originals[id]!, xy = original.xy.flat();
    if (geometry.xy.length !== xy.length || geometry.parts.length !== original.parts.length) {
      throw new Error("Shapefile typed preflight extent mismatch.");
    }
    for (let i = 0; i < xy.length; i++) {
      if (!Object.is(geometry.xy[i], xy[i])) {
        throw new Error(`Shapefile coordinate preflight mismatch ${native.name}/${id}/${i}.`);
      }
    }
    for (let i = 0; i < original.parts.length; i++) {
      if (geometry.parts[i] !== original.parts[i]) throw new Error("Shapefile part preflight mismatch.");
    }
    expectBytes(
      await dataset.source(id).read(0, native.tuples[id]!.bytes),
      decodeBase64(native.tuples[id]!.bodyBase64),
      `shapefile/${native.name}/${id}/complete-body`,
    );
    expectBytes(
      (await dataset.attributes(id))!.bytes,
      decodeBase64(native.rawRows[id]!),
      `shapefile/${native.name}/${id}/complete-row`,
    );
  }
}
const native = fixture.fixtures.find((f) => f.name === "polygon")!,
  input = sources(native),
  dataset = await openShapefile(input, { profile: "shp2d-dbf3", ...allowance });
const tuple = native.tuples[0]!, geometry = await dataset.read(0), row = (await dataset.attributes(0))!;
expectBytes(
  await input.shp.read(tuple.offset, tuple.bytes),
  decodeBase64(tuple.bodyBase64),
  "shapefile/direct-borrowed-body",
);
const cold = await openShapefile(input, { profile: "shp2d-dbf3" }),
  geometryOnly = await openShapefile({ shp: input.shp }, { profile: "shp2d-dbf3" });
if (
  cold.index !== "cross-checked" || cold.scope !== "geometry-and-raw-attributes" || geometryOnly.scope !== "geometry" ||
  geometryOnly.index !== "absent"
) throw new Error("Shapefile component scope preflight failed.");
const sparse = dataset.features({ kind: "null", limit: 1, maxScanned: 2 });
if (sparse.features.length !== 0 || sparse.scanned !== 2 || sparse.cursor !== 2) {
  throw new Error("Shapefile sparse-page preflight failed.");
}
bench(
  `shapefile borrowed-record lower-bound ${tuple.bytes} B validation=none conversion=none`,
  async () => do_not_optimize(await input.shp.read(tuple.offset, tuple.bytes)),
);
bench(
  `shapefile cold-geometry-index records=${native.originals.length} source=${geometryOnly.work.sourceBytes} B requests=${geometryOnly.work.requests} metadata=${geometryOnly.work.metadataBytes} B optional-components=absent`,
  async () => do_not_optimize(await openShapefile({ shp: input.shp }, { profile: "shp2d-dbf3" })),
);
bench(
  `shapefile cold-correlated-index records=${native.originals.length} source=${cold.work.sourceBytes} B requests=${cold.work.requests} SHX-checks=${cold.work.indexChecks} fields=${cold.fields.length}`,
  async () => do_not_optimize(await openShapefile(input, { profile: "shp2d-dbf3" })),
);
bench(
  `shapefile complete-polygon points=${geometry.work.points} parts=${geometry.work.parts} source=${geometry.work.sourceBytes} B decoded=${geometry.work.decodedBytes} B output=${geometry.work.outputBytes} B bounds+closure integrity=not-provided`,
  async () => do_not_optimize(await dataset.read(0)),
);
bench(
  `shapefile raw-DBF-row source=${row.work.sourceBytes} B output=${row.work.outputBytes} B fields=${row.fields.length} encoding=unknown numeric-conversion=none`,
  async () => do_not_optimize(await dataset.attributes(0)),
);
bench(
  "shapefile empty-sparse-page limit=1 actual=0 scanned=2 cursor=2 payload-IO=none",
  () => do_not_optimize(dataset.features({ kind: "null", limit: 1, maxScanned: 2 })),
);
await report();
