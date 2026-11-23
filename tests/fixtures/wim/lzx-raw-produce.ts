/** Authored raw LZX prefix plus native-compressed successor, checked by both native consumers. */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { bridge, integer, read, save, sha, verify } from "./native.ts";
import type { FixtureType } from "./native.ts";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: "string" },
    wim: { type: "string", default: "wimlib-imagex" },
    seven: { type: "string", default: "7zz" },
    compiler: { type: "string", default: "cc" },
  },
});
const input = positionals[0];
ok(
  input && positionals.length === 1 && values.output && values.wim && values.seven && values.compiler,
  "Use INPUT_LZX_JSON --output NEW_JSON and reviewed native tools.",
);
const original = read(input), fixture: FixtureType = JSON.parse(original.toString("utf8"));
ok(fixture.nativeResources.length <= 256 && fixture.images.length === 2);
const matches = fixture.nativeResources.filter((resource) => resource.decoded === 200000);
equal(matches.length, 1);
const resource = matches[0];
ok(resource);
const first = resource.chunks[0];
ok(first);
const expected = Buffer.from(first.decoded, "base64");
deepStrictEqual(expected, Buffer.alloc(32768, 65));
const root = mkdtempSync(join(tmpdir(), "opfs-lzx-adapt-")), failures: unknown[] = [];
try {
  const native = bridge(root, values.compiler), successor = native.codec("compress", 2, Buffer.alloc(32763, 65), 32763);
  ok(successor.length > 0);
  // Type 3, explicit size 5, then zero coding-word alignment and recent offsets.
  const header = Buffer.alloc(4);
  const bits = "0110" + (5).toString(2).padStart(16, "0") + "0".repeat(12);
  header.writeUInt16LE(Number.parseInt(bits.slice(0, 16), 2), 0);
  header.writeUInt16LE(Number.parseInt(bits.slice(16), 2), 2);
  const recent = Buffer.alloc(12);
  for (let offset = 0; offset < 12; offset += 4) recent.writeUInt32LE(1, offset);
  const raw = Buffer.concat([header, recent, Buffer.alloc(5, 65), Buffer.from([0])]),
    combined = Buffer.concat([raw, successor]);
  ok(combined.length < expected.length);
  deepStrictEqual(native.codec("decompress", 2, combined, expected.length), expected);
  resource.chunks[0] = {
    packed: combined.toString("base64"),
    decoded: expected.toString("base64"),
    compressed: true,
    expected: expected.length,
  };
  ok(resource.chunks.length <= 64);
  const chunks = resource.chunks.map((chunk) => Buffer.from(chunk.packed, "base64"));
  const offsets: number[] = [];
  let current = 0;
  for (const chunk of chunks.slice(0, -1)) {
    current += chunk.length;
    offsets.push(current);
  }
  const table = Buffer.alloc(offsets.length * 4);
  for (const [index, offset] of offsets.entries()) table.writeUInt32LE(offset, index * 4);
  const packed = Buffer.concat([table, ...chunks]);
  ok(packed.length <= 2 * 1024 * 1024);
  const previousArchive = Buffer.from(fixture.base64, "base64");
  equal(sha(previousArchive), fixture.sha256);
  ok(previousArchive.length <= 16 * 1024 * 1024);
  const padding = Buffer.alloc((8 - previousArchive.length % 8) % 8),
    offset = previousArchive.length + padding.length,
    archive = Buffer.concat([previousArchive, padding, packed]);
  const tableSize = integer(archive, 48, 7), tableOffset = integer(archive, 56, 8);
  ok(tableSize % 50 === 0 && tableSize / 50 <= 256 && tableOffset + tableSize <= previousArchive.length);
  const records = [];
  for (let at = tableOffset; at < tableOffset + tableSize; at += 50) {
    if (archive.subarray(at + 30, at + 50).toString("hex") === resource.sha1) records.push(at);
  }
  equal(records.length, 1);
  const at = records[0];
  ok(at !== undefined);
  equal(archive[at + 7], 4);
  archive.writeUIntLE(packed.length, at, 6);
  archive[at + 6] = 0;
  archive.writeBigUInt64LE(BigInt(offset), at + 8);
  resource.offset = offset;
  resource.stored = packed.length;
  const path = join(root, "raw-and-verbatim.wim");
  writeFileSync(path, archive, { flag: "wx" });
  const checked = verify(path, fixture.images, root, values.wim, values.seven);
  save(values.output, {
    evidenceProfile:
      "Authored raw prefix and genuine native-compressed verbatim successor; two native complete file consumers",
    originalFixtureSha256: sha(original),
    originalWimSha256: fixture.sha256,
    base64: archive.toString("base64"),
    sha256: sha(archive),
    nativeResources: fixture.nativeResources,
    images: fixture.images,
    rawPrefix: raw.toString("base64"),
    nativeSuccessor: successor.toString("base64"),
    nativeFullChunkExact: true,
    nativeBridge: native.receipt,
    consumers: checked.consumers,
    verify: checked.verification,
  });
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
if (failures.length) throw new AggregateError(failures, "LZX raw adaptation and cleanup failed.");
