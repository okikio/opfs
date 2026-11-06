/** Native-only GeoTIFF proof. New receipts never replace the historical tifffile corpus or its provenance. */
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { endianness } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { check, digest, json, output, snapshot } from "../acquire.ts";
import { group } from "../group.ts";
import { authored, blob, layout, original, physical, profiles, values as scalars } from "./raster.ts";
const { values } = parseArgs({
  options: { output: { type: "string" }, compiler: { type: "string", default: "/usr/bin/g++" } },
});
check(
  values.output && values.compiler && process.platform === "linux" && endianness() === "LE",
  "Usage: produce.ts --output FRESH_DIRECTORY [--compiler /usr/bin/g++] on little-endian Linux.",
);
const here = dirname(fileURLToPath(import.meta.url)), compiler = resolve(values.compiler);
/** Bound file allocation before reading; reject a changed extent after the read. */
function read(path: string, maximum = 1024 * 1024): Buffer<ArrayBuffer> {
  check(statSync(path).isFile() && statSync(path).size <= maximum, "Native fixture file extent.");
  const bytes = readFileSync(path);
  check(bytes.length <= maximum, "Native fixture changed beyond extent.");
  return bytes;
}
await output(values.output, async (root) => {
  const work = join(root, "native-output");
  mkdirSync(work);
  for (const profile of profiles) {
    snapshot(work, profile.name + ".page0.original", original(profile));
    if (profile.overview) snapshot(work, profile.name + ".page1.original", original(profile, 1));
    if (profile.authored) snapshot(work, profile.name + ".tif", authored(profile.tiled));
  }
  /** Retain finite diagnostics before deciding whether an owned native command succeeded. */
  async function command(
    name: string,
    command: string,
    args: readonly string[],
    seconds: number,
    bytes: number,
  ): Promise<string> {
    const log = join(root, name + ".log"), outcome = await group({ command, args, log, seconds, bytes });
    json(root, name + ".json", outcome);
    check(
      outcome.exit === 0 && outcome.reason === null && outcome.cleanupFaults.length === 0,
      "Native fixture command failed: " + name,
    );
    return read(log, bytes).toString();
  }
  const version = await command("compiler-version", compiler, ["--version"], 10, 65536);
  // gdal-config is the admitted development package's native build contract.
  // Its output is split into argv, never evaluated as a shell command.
  const flags: string[] = [];
  for (const option of ["--cflags", "--libs"]) {
    const text = await command("gdal-config-" + option.slice(2), "/usr/bin/gdal-config", [option], 10, 65536);
    const tokens = text.trim().split(/\s+/);
    check(
      tokens.length <= 32 &&
        tokens.every((token) => /^-(?:I|L|l)[A-Za-z0-9_./+\-]+$/.test(token) || token === "-pthread"),
      "Reviewed native compiler argv flags.",
    );
    flags.push(...tokens);
  }
  const binary = join(root, "native-geotiff");
  await command(
    "compile",
    "/bin/dash",
    [
      "-c",
      'ulimit -f 131072 || exit; exec "$@"',
      "opfs-geotiff-compile",
      compiler,
      "-std=c++17",
      "-O2",
      "-Wall",
      "-Wextra",
      join(here, "native.cpp"),
      ...flags,
      "-ltiff",
      "-o",
      binary,
    ],
    60,
    1024 * 1024,
  );
  check(existsSync(binary), "Compiled native GeoTIFF executable absent.");
  const nativeVersion = await command(
    "producer",
    "/bin/dash",
    ["-c", 'ulimit -f 2048 || exit; exec "$@"', "opfs-geotiff-native", binary, work],
    90,
    4 * 1024 * 1024,
  );
  let total = 0, pageCount = 0;
  const fixtures = profiles.map((profile) => {
    const raw = read(join(work, profile.name + ".tif")), pages = physical(raw), scalar = layout(profile.kind);
    total += raw.length;
    check(total <= 8 * 1024 * 1024, "Native fixture aggregate ceiling.");
    check(pages.length === (profile.overview ? 2 : 1), "Complete main-chain page inventory.");
    const proof = pages.map((page, index) => {
      const expected = original(profile, index), prefix = profile.name + ".page" + index;
      check(
        page.width === (index ? 10 : 19) && page.height === (index ? 9 : 17) && page.samples === profile.channels &&
          page.bits === scalar.bytes * 8 && page.sampleFormat === scalar.format && page.big === profile.big,
        "Physical scalar/raster profile differs.",
      );
      check(index > 0 || page.tiled === profile.tiled, "Physical base-page tile/strip profile differs.");
      check(
        page.fields["258"]?.values?.every((bits) => bits === scalar.bytes * 8) &&
          (page.fields["339"]?.values?.every((format) => format === scalar.format) ?? scalar.format === 1),
        "Homogeneous complete scalar tags.",
      );
      check(
        page.raster.equals(expected) && read(join(work, prefix + ".gdal")).equals(expected),
        "Independent physical and GDAL complete sample bits differ.",
      );
      const ww = Math.min(3, page.width),
        hh = Math.min(2, page.height),
        crop = Buffer.alloc(ww * hh * profile.channels * scalar.bytes);
      for (let row = 0; row < hh; row++) {
        const start = ((page.height - hh + row) * page.width + page.width - ww) * profile.channels * scalar.bytes;
        expected.copy(
          crop,
          row * ww * profile.channels * scalar.bytes,
          start,
          start + ww * profile.channels * scalar.bytes,
        );
      }
      check(read(join(work, prefix + ".window")).equals(crop), "Independent bottom-right window differs.");
      page.blocks.forEach((block, at) => {
        const native = prefix + ".block" + at;
        check(
          read(join(work, native + ".raw")).equals(Buffer.from(block.raw.base64, "base64")) &&
            read(join(work, native + ".decoded")).equals(block.little),
          "libtiff raw/decoded complete block words differ.",
        );
      });
      pageCount++;
      return {
        page: index,
        width: page.width,
        height: page.height,
        samples: page.samples,
        bits: page.bits,
        sampleFormat: page.sampleFormat,
        tiled: page.tiled,
        blockWidth: page.blockWidth,
        blockHeight: page.blockHeight,
        ifdOffset: page.ifdOffset,
        fields: page.fields,
        blocks: page.blocks.map(({ little: normalized, ...block }) => ({ ...block, normalized: blob(normalized) })),
        original: blob(expected),
        values: scalars(expected, profile.kind),
        nativeWindow: blob(crop),
        fullBits: true,
        nativeGdal: true,
        nativeLibtiffBlocks: true,
      };
    });
    const geo = read(join(work, profile.name + ".geotransform"), 48);
    check(geo.length === 48, "Native geotransform byte extent.");
    const transform = Array.from({ length: 6 }, (_, at) => geo.readDoubleLE(at * 8)),
      area = read(join(work, profile.name + ".area"), 32).toString();
    check(transform.every((value, at) => value === [100, .5, 0, 50, 0, -.5][at]), "Native geotransform differs.");
    check(area === (profile.name === "u16-tiles-be" ? "Point" : "Area"), "Native area/point differs.");
    const keys = pages[0]!.fields["34735"]?.values;
    check(keys && keys.length >= 4 && keys[0] === 1 && keys[3]! * 4 + 4 === keys.length, "Complete GeoKey directory.");
    const key = (id: number): number | undefined => {
      for (let at = 4; at < keys.length; at += 4) {
        if (keys[at] === id) {
          check(keys[at + 1] === 0 && keys[at + 2] === 1, "Inline scalar GeoKey.");
          return keys[at + 3];
        }
      }
      return undefined;
    };
    check(
      key(1024) === (profile.authored ? 1 : 2) && key(1025) === (profile.name === "u16-tiles-be" ? 2 : 1),
      "Native model/raster GeoKeys.",
    );
    check(profile.authored ? key(3072) === 32767 : key(2048) === 4326, "Native CRS GeoKey profile.");
    return {
      name: profile.name,
      writer: profile.authored ? "authored TypeScript classic-TIFF writer" : "native GDAL GTiff",
      data: blob(raw),
      geotransform: transform,
      areaOrPoint: area,
      projection: read(join(work, profile.name + ".projection"), 8192).toString(),
      pages: proof,
    };
  });
  check(fixtures.length === 11 && pageCount === 12, "Complete eleven-file/twelve-page profile inventory.");
  const sources: Record<string, string> = {};
  for (const name of ["native.cpp", "produce.ts", "raster.ts", "../acquire.ts", "../group.ts"]) {
    sources[name] = digest(read(join(here, name), 65536));
  }
  const result = {
    scope:
      "New native GDAL/libtiff proof plus authored TypeScript physical-word checks; two authored writers replace Python tifffile recipe only. Frozen historical tifffile receipts remain independent evidence, not new execution.",
    node: process.version,
    compiler: version,
    nativeVersion,
    sources,
    nativeBinarySha256: digest(read(binary, 64 * 1024 * 1024)),
    totalFileBytes: total,
    files: fixtures.length,
    pages: pageCount,
    fixtures,
  };
  const serialized = Buffer.from(JSON.stringify(result, null, 2) + "\n");
  check(serialized.length <= 16 * 1024 * 1024, "Native proof JSON ceiling.");
  snapshot(root, "independent.json", serialized);
});
