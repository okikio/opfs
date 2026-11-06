/** Produce genuine UDF images and independently verify complete allocation profiles.
 *
 * Fixed original noise is retained from the historical fixture instead of
 * pretending Node reproduces CPython Random. No candidate code is imported.
 * @module
 */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { command, read, sha } from "../iso/native.ts";
const { values } = parseArgs({
  options: {
    output: { type: "string" },
    seven: { type: "string", default: "7zz" },
    genisoimage: { type: "string", default: "genisoimage" },
    udfinfo: { type: "string", default: "udfinfo" },
  },
});
ok(values.output && values.seven && values.genisoimage && values.udfinfo, "Supply tools and a new --output path.");
const { seven, genisoimage, udfinfo } = values;
const historicalBytes = read(new URL("./independent.json", import.meta.url));
const historical: { entries: { name: string; body: string; sha256: string }[] } = JSON.parse(
  historicalBytes.toString("utf8"),
);
const bodies = new Map<string, Buffer>([
  ["empty", Buffer.alloc(0)],
  ["folder/first.bin", Buffer.from("Independent UDF bytes\0\xff", "latin1")],
  ["café.bin", Buffer.from("Latin1 name")],
  ["雪.bin", Buffer.from("UCS2 name")],
]);
for (const [name, size] of [["large.bin", 65573], ["unrelated.bin", 1048576]] as const) {
  const original = historical.entries.find((entry) => entry.name === name);
  ok(original, `Missing retained original ${name}`);
  const bytes = Buffer.from(original.body, "base64");
  equal(bytes.length, size);
  equal(sha(bytes), original.sha256);
  bodies.set(name, bytes);
}
for (let index = 0; index < 65; index++) {
  bodies.set(`cross/entry-${String(index).padStart(2, "0")}-long-name.bin`, Buffer.from([index, 0, 255]));
}
const first = bodies.get("folder/first.bin");
ok(first);
bodies.set("alias.bin", first);
equal(historical.entries.length, bodies.size);
for (const entry of historical.entries) deepStrictEqual(Buffer.from(entry.body, "base64"), bodies.get(entry.name));

/** UDF tag CRC is CRC-16/CCITT with zero initial state. */
function crc(bytes: Buffer): number {
  let value = 0;
  for (const byte of bytes) {
    value ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) value = ((value << 1) ^ (value & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return value;
}
const root = mkdtempSync(join(tmpdir(), "opfs-udf-controls-")), failures: unknown[] = [];
try {
  const tree = join(root, "tree");
  mkdirSync(tree);
  for (const [name, bytes] of bodies) {
    if (name === "alias.bin") continue;
    const path = join(tree, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes, { flag: "wx" });
  }
  linkSync(join(tree, "folder/first.bin"), join(tree, "alias.bin"));
  const image = join(root, "image.udf");
  const producerArgs = ["-quiet", "-udf", "-no-pad", "-input-charset", "utf-8", "-V", "OPFS_UDF102", "-o", image, tree];
  command(genisoimage, producerArgs);
  const verify = (path: string): string => {
    const listing = command(seven, ["l", "-tUdf", "-slt", path]).stdout.toString("utf8");
    ok(listing.includes("Type = Udf"), "Independent consumer did not select UDF.");
    for (const [name, bytes] of bodies) {
      deepStrictEqual(command(seven, ["x", "-tUdf", "-spd", "-so", path, name]).stdout, bytes, name);
    }
    return listing;
  };
  const listing = verify(image), raw = read(image), found: number[] = [];
  for (let offset = 0; offset + 2048 <= raw.length; offset += 2048) {
    if (raw.readUInt16LE(offset) === 261 && raw[offset + 27] === 5 && raw.readBigUInt64LE(offset + 56) === 65573n) {
      found.push(offset);
    }
  }
  equal(found.length, 1, "Expected one ordinary large-file UDF entry.");
  const fe = found[0];
  ok(fe !== undefined);
  const ea = raw.readUInt32LE(fe + 168), ad = fe + 176 + ea;
  equal(raw.readUInt32LE(fe + 172), 8);
  ok(ad + 32 <= fe + 2048, "Adaptation exceeds its descriptor block.");
  const extentLength = raw.readUInt32LE(ad), extentBlock = raw.readUInt32LE(ad + 4);
  equal(extentLength, 65573);
  const adaptations = [];
  for (const profile of ["long", "split-short", "split-long"]) {
    const adapted = Buffer.from(raw), width = profile === "split-short" ? 8 : 16;
    const extents = profile === "long"
      ? [[extentLength, extentBlock] as const]
      : [[2048, extentBlock] as const, [extentLength - 2048, extentBlock + 1] as const];
    adapted.writeUInt16LE((adapted.readUInt16LE(fe + 34) & ~7) | (width === 16 ? 1 : 0), fe + 34);
    adapted.writeUInt32LE(width * extents.length, fe + 172);
    adapted.fill(0, ad, ad + width * extents.length);
    for (const [index, [length, block]] of extents.entries()) {
      adapted.writeUInt32LE(length, ad + width * index);
      adapted.writeUInt32LE(block, ad + width * index + 4);
    }
    const crcLength = 176 + ea + width * extents.length - 16;
    adapted.writeUInt16LE(crcLength, fe + 10);
    adapted.writeUInt16LE(crc(adapted.subarray(fe + 16, fe + 16 + crcLength)), fe + 8);
    let sum = 0;
    for (let index = 0; index < 16; index++) if (index !== 4) sum += adapted[fe + index] ?? 0;
    adapted[fe + 4] = sum & 255;
    const path = join(root, profile + ".udf");
    writeFileSync(path, adapted, { flag: "wx" });
    verify(path);
    adaptations.push({
      name: profile,
      archive: adapted.toString("base64"),
      sha256: sha(adapted),
      changedIcbOffset: fe,
      origin:
        "Authored allocation-vector adaptation of genuine native image; every original independently accepted by forced-UDF 7-Zip",
      udfinfo: command(udfinfo, [path]).stdout.toString("utf8"),
    });
  }
  const help = command(udfinfo, ["--help"], { allowFailure: true, timeout: 10_000 }),
    version = command(udfinfo, ["--version"], { allowFailure: true, timeout: 10_000 });
  const receipt = JSON.stringify(
    {
      runtime: process.version,
      historicalFixtureSha256: sha(historicalBytes),
      originalSource:
        "Fixed original noise from retained historical entry bytes; remaining originals authored and compared completely",
      tools: {
        genisoimage: command(genisoimage, ["--version"]).stdout.toString("utf8"),
        seven: command(seven, ["i"]).stdout.toString("utf8"),
      },
      udfinfoHelp: {
        exitCode: help.status,
        stdout: help.stdout.toString("utf8"),
        stderr: help.stderr.toString("utf8"),
      },
      unsupportedVersionProbe: {
        exitCode: version.status,
        stdout: version.stdout.toString("utf8"),
        stderr: version.stderr.toString("utf8"),
      },
      listing,
      udfinfo: command(udfinfo, [image]).stdout.toString("utf8"),
      archive: raw.toString("base64"),
      sha256: sha(raw),
      adaptations,
      entries: [...bodies].map(([name, bytes]) => ({ name, body: bytes.toString("base64"), sha256: sha(bytes) })),
    },
    null,
    2,
  ) + "\n";
  ok(Buffer.byteLength(receipt) <= 32 * 1024 * 1024, "UDF receipt exceeds its output bound.");
  writeFileSync(values.output, receipt, { flag: "wx" });
} catch (reason) {
  failures.push(reason);
} finally {
  try {
    rmSync(root, { recursive: true });
  } catch (reason) {
    failures.push(reason);
  }
}
if (failures.length === 1) throw failures[0];
if (failures.length) throw new AggregateError(failures, "UDF production and cleanup failed.");
