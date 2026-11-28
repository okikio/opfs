/** Installed dataset geometry contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { createByteSource } from "@okikio/opfs/source";
import { openLas } from "@okikio/opfs/dataset/las";
import { openShapefile } from "@okikio/opfs/dataset/shapefile";
import { openGeotiff } from "@okikio/opfs/dataset/geotiff";
import { assertBytes, fromBase64 } from "../../bytes.mjs";
import shapefileInput from "../../data/dataset/shapefile.json" with { type: "json" };
import geotiffInput from "../../data/dataset/geotiff.json" with { type: "json" };
import lasInput from "../../data/dataset/las.json" with { type: "json" };

describe("packed dataset geometry", () => {
  it("Shapefile independent coordinates and rows", async () => {
    // Keep original numeric lexemes: reserializing parsed JSON would turn -0 into 0.
    const shapefileFixtures = JSON.parse(shapefileInput).fixtures;
    for (const fixture of shapefileFixtures) {
      const sources = Object.fromEntries(
        Object.entries(fixture.components).map(([name, value]) => [name, createByteSource(fromBase64(value.data))]),
      );
      const dataset = await openShapefile(sources, { profile: "shp2d-dbf3" });
      if (dataset.featureCount !== fixture.originals.length || dataset.index !== "cross-checked") {
        throw new Error("Packed Shapefile physical enumeration changed");
      }
      for (let id = 0; id < fixture.originals.length; id++) {
        const original = fixture.originals[id],
          result = await dataset.read(id),
          attributes = await dataset.attributes(id);
        const xy = original.xy.flat();
        if (
          result.xy.length !== xy.length || result.xy.some((value, at) => !Object.is(value, xy[at])) ||
          result.parts.length !== original.parts.length || result.parts.some((value, at) =>
            value !== original.parts[at]
          )
        ) throw new Error("Packed Shapefile coordinates or parts changed");
        assertBytes(attributes.bytes, fromBase64(fixture.rawRows[id]));
        assertBytes(
          await dataset.source(id).read(0, fixture.tuples[id].bytes),
          fromBase64(fixture.tuples[id].bodyBase64),
        );
      }
      if (fixture.authoredDeletion) {
        const edited = await openShapefile({
          ...sources,
          dbf: createByteSource(fromBase64(fixture.authoredDeletion.data)),
        }, { profile: "shp2d-dbf3" });
        if (!(await edited.attributes(1)).deleted || (await edited.attributes(2)).id !== 2) {
          throw new Error("Packed Shapefile deleted ordinal alignment changed");
        }
        assertBytes((await edited.attributes(2)).bytes, fromBase64(fixture.rawRows[2]));
      }
    }
  });
  it("GeoTIFF original samples and read budgets", async () => {
    // Parse original fixture JSON text: preserve negative zero and explicit special-float oracles.
    const geotiffFixtures = JSON.parse(geotiffInput).fixtures;
    /** Preserve NaN, signed zero and infinity expectations that ordinary equality cannot distinguish. */
    const geotiffSameSample = (actual, expected) =>
      expected === "nan"
        ? Number.isNaN(actual)
        : expected === "-zero"
        ? Object.is(actual, -0)
        : expected === "+infinity"
        ? actual === Infinity
        : expected === "-infinity"
        ? actual === -Infinity
        : Object.is(actual, expected);
    let geotiffImages = 0;
    for (const fixture of geotiffFixtures) {
      const input = createByteSource(fromBase64(fixture.file.base64));
      let sourceBytes = 0, requests = 0;
      const raster = await openGeotiff({
        ...input,
        async read(offset, length, options) {
          sourceBytes += length;
          requests++;
          return await input.read(offset, length, options);
        },
      }, { profile: "classic-geotiff-raw" });
      if (raster.images.length !== fixture.pages.length || raster.cog !== "not-evaluated") {
        throw new Error("Packed GeoTIFF main-chain or COG scope changed");
      }
      for (let id = 0; id < fixture.pages.length; id++) {
        geotiffImages++;
        const original = fixture.pages[id], image = raster.images[id];
        if (
          image.id !== id || image.width !== original.width || image.height !== original.height ||
          image.samplesPerPixel !== original.samples || image.blocks !== original.blocks.length ||
          image.layout !== (original.tiled ? "tiles" : "strips")
        ) throw new Error("Packed GeoTIFF geometry changed");
        const rectangle = { x: 0, y: 0, width: image.width, height: image.height };
        const beforeBytes = sourceBytes, beforeRequests = requests, plan = raster.plan(id, rectangle);
        if (sourceBytes !== beforeBytes || requests !== beforeRequests) {
          throw new Error("Packed GeoTIFF plan performed source I/O");
        }
        const result = await raster.read(id, rectangle);
        if (
          result.values.length !== original.originalValues.length ||
          result.values.some((value, at) => !geotiffSameSample(value, original.originalValues[at]))
        ) throw new Error("Packed GeoTIFF complete original samples changed");
        if (
          result.integrity !== "not-provided" || result.work.sourceBytes !== plan.sourceBytes ||
          result.work.requests !== plan.requests || sourceBytes - beforeBytes !== plan.sourceBytes ||
          requests - beforeRequests !== plan.requests || result.work.outputBytes !== result.values.byteLength ||
          result.work.decodedBytes !== plan.decodedBytes
        ) throw new Error("Packed GeoTIFF plan or integrity accounting changed");
        for (let block = 0; block < original.blocks.length; block++) {
          const raw = fromBase64(original.blocks[block].raw.base64), source = raster.source(id, block);
          if (source.size !== raw.length || source.stability !== "immutable") {
            throw new Error("Packed GeoTIFF physical block source changed");
          }
          assertBytes(await source.read(0, source.size), raw);
          const offset = Math.min(17, source.size), length = Math.min(37, source.size - offset);
          assertBytes(await source.read(offset, length), raw.slice(offset, offset + length));
        }
        const edge = original.nativeEdgeWindow,
          edgePlan = raster.plan(id, edge),
          selected = await raster.read(id, edge);
        if (
          selected.width !== edge.width || selected.height !== edge.height ||
          selected.work.sourceBytes !== edgePlan.sourceBytes || selected.work.requests !== edgePlan.requests
        ) throw new Error("Packed GeoTIFF selected geometry changed");
        for (let y = 0; y < edge.height; y++) {
          for (let x = 0; x < edge.width; x++) {
            for (let band = 0; band < image.samplesPerPixel; band++) {
              const expected =
                original.originalValues[((edge.y + y) * image.width + edge.x + x) * image.samplesPerPixel + band];
              if (
                !geotiffSameSample(selected.values[(y * edge.width + x) * image.samplesPerPixel + band], expected)
              ) throw new Error("Packed GeoTIFF selected original sample changed");
            }
          }
        }
        const fields = original.fields, directory = fields["34735"]?.values;
        if (directory) {
          if (image.geo.scope !== "unresolved-declarations" || image.geo.keys.length !== directory[3]) {
            throw new Error("Packed GeoTIFF declared GeoKey scope changed");
          }
          for (let key = 0; key < image.geo.keys.length; key++) {
            const actual = image.geo.keys[key], at = 4 + key * 4;
            if (
              actual.id !== directory[at] || actual.location !== directory[at + 1] ||
              actual.count !== directory[at + 2] || actual.offset !== directory[at + 3]
            ) throw new Error("Packed GeoTIFF GeoKey identity changed");
          }
          for (const [name, tag] of [["pixelScale", "33550"], ["tiepoints", "33922"]]) {
            const expected = fields[tag]?.values ?? [];
            if (
              image.geo[name].length !== expected.length ||
              image.geo[name].some((value, at) => !Object.is(value, expected[at]))
            ) throw new Error("Packed GeoTIFF coordinate declaration changed");
          }
          assertBytes(
            new Uint8Array(image.geo.ascii),
            fields["34737"] ? fromBase64(fields["34737"].raw.base64) : new Uint8Array(),
          );
        } else if (image.geo.scope !== "absent-reduced-image") {
          throw new Error("Packed GeoTIFF reduced-image metadata inheritance changed");
        }
      }
    }
    if (geotiffFixtures.length !== 11 || geotiffImages !== 12) {
      throw new Error("Packed GeoTIFF native fixture coverage changed");
    }
  });
  it("LAS exact selected columns and opaque extensions", async () => {
    const lasFixture = lasInput;
    const lasBytes = Uint8Array.from(atob(lasFixture.file.base64), (byte) => byte.charCodeAt(0));
    const las = await openLas(createByteSource(lasBytes));
    const lasRead = await las.read({ offset: 3, count: 7, scale: "physical" });
    /** Select the same row interval directly from the producer column bytes. */
    const lasColumn = (name, width) =>
      Uint8Array.from(atob(lasFixture.columns[name].base64), (byte) => byte.charCodeAt(0)).subarray(
        3 * width,
        10 * width,
      );
    /** Compare exact typed-array storage while respecting its offset and extent. */
    const lasBytesOf = (value) => new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    assertBytes(lasBytesOf(lasRead.X), lasColumn("X", 4));
    assertBytes(lasBytesOf(lasRead.gpsTime), lasColumn("gps_time", 8));
    assertBytes(lasBytesOf(lasRead.red), lasColumn("red", 2));
    assertBytes(lasBytesOf(lasRead.physical.x), lasColumn("x", 8));
    assertBytes(lasRead.extra, new Uint8Array([3, 4, 5, 6, 7, 8, 9]));
    if (lasRead.integrity !== "not-provided" || las.extraBytesPerPoint !== 1 || !las.headerExtension.size) {
      throw new Error("Packed LAS opaque/profile evidence changed");
    }
    assertBytes((await las.readVlr(0, { offset: 3, length: 5 })).bytes, new Uint8Array([3, 4, 5, 6, 7]));
  });
});
