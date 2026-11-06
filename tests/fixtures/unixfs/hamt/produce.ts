/** Genuine fanout-256 Kubo HAMTs, complete/range originals and literal native listings. */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { ASSET_SHA256, COMMIT, kubo, save, sha } from "../native.ts";
import { fields } from "../wire.ts";
const { values } = parseArgs({ options: { archive: { type: "string" }, output: { type: "string" } } });
ok(values.archive && values.output, "Supply --archive PINNED_KUBO_TGZ --output NEW_JSON.");
const originals = new Map<string, Buffer>();
for (let index = 0; index < 96; index++) {
  originals.set(`file-${String(index).padStart(3, "0")}.txt`, Buffer.from(`Native HAMT original ${index}.\n`));
}
for (
  const [name, text] of [["café.txt", "literal UTF-8 name\n"], ["%2F.txt", "literal percent name\n"], [
    "space name.txt",
    "literal spaces\n",
  ], ["empty", ""]] as const
) originals.set(name, Buffer.from(text));
for (let index = 0; index < 8; index++) originals.set(`nested/child-${index}.bin`, Buffer.alloc(10 + index, index));
const root = mkdtempSync(join(tmpdir(), "opfs-hamt-native-")), failures: unknown[] = [];
try {
  const native = kubo(values.archive, root), run = (args: string[]) => native.run(args).stdout;
  const directory = join(root, "originals");
  mkdirSync(directory);
  for (const [name, body] of originals) {
    const path = join(directory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, { flag: "wx" });
  }
  const cid = run([
    "add",
    "--recursive",
    "--quieter",
    "--pin=false",
    "--cid-version=1",
    "--raw-leaves=true",
    "--max-directory-links=4",
    directory,
  ]).toString("utf8").trim();
  ok(cid.length <= 128 && /^[A-Za-z0-9]+$/u.test(cid));
  const car = run(["dag", "export", cid]),
    refs = run(["refs", "--recursive", "--unique", cid]).toString("utf8").trim().split("\n");
  ok(refs.length <= 4096);
  const blocks = [], shards = [];
  for (const blockCid of new Set([cid, ...refs])) {
    ok(blockCid.length <= 128 && /^[A-Za-z0-9]+$/u.test(blockCid));
    const body = run(["block", "get", blockCid]);
    blocks.push({ cid: blockCid, base64: body.toString("base64"), size: body.length, sha256: sha(body) });
    if (blockCid.startsWith("bafk")) continue;
    const node: unknown = JSON.parse(run(["dag", "get", blockCid]).toString("utf8"));
    ok(node !== null && typeof node === "object" && "Data" in node);
    const data = node.Data;
    ok(data !== null && typeof data === "object" && Object.keys(data).length === 1 && "/" in data);
    const wrapper = data["/"];
    ok(wrapper !== null && typeof wrapper === "object" && Object.keys(wrapper).length === 1 && "bytes" in wrapper);
    const text = wrapper.bytes;
    ok(typeof text === "string" && text.length <= 1024 * 1024 && /^[A-Za-z0-9+/]*$/u.test(text));
    const decoded = Buffer.from(text, "base64");
    equal(decoded.toString("base64").replace(/=+$/u, ""), text);
    const metadata = fields(decoded);
    if (metadata.get(1) !== 5) continue;
    equal(metadata.get(5), 0x22);
    equal(metadata.get(6), 256);
    const bitmap = metadata.get(2) ?? Buffer.alloc(0);
    ok(Buffer.isBuffer(bitmap) && bitmap.length <= 32);
    const links = "Links" in node ? node.Links : [];
    ok(Array.isArray(links) && links.length <= 256);
    const buckets = links.map((link: unknown) => {
      ok(
        link !== null && typeof link === "object" && "Name" in link && typeof link.Name === "string" &&
          /^[0-9A-F]{2}/u.test(link.Name),
      );
      return Number.parseInt(link.Name.slice(0, 2), 16);
    });
    deepStrictEqual(buckets, [...new Set(buckets)].sort((a, b) => a - b));
    let bits = 0;
    for (const byte of bitmap) {
      let value = byte;
      while (value) {
        bits += value & 1;
        value >>>= 1;
      }
    }
    equal(bits, links.length);
    for (const bucket of buckets) {
      const byte: number | undefined = bitmap[bitmap.length - 1 - Math.floor(bucket / 8)];
      ok(byte !== undefined && (byte & 1 << (bucket % 8)) !== 0);
    }
    shards.push({ cid: blockCid, bitmap: bitmap.toString("base64"), bitmapBytes: bitmap.length, links });
  }
  ok(
    shards.some((shard) => shard.cid === cid) && shards.length > 2 && shards.some((shard) => shard.bitmapBytes < 32),
    "Missing native root/collision/shortened-bitmap evidence.",
  );
  const files = [];
  for (const [path, expected] of originals) {
    deepStrictEqual(run(["cat", cid + "/" + path]), expected, path);
    const ranges = [];
    if (expected.length) {
      const offset = Math.max(0, expected.length - 5), length = Math.min(5, expected.length);
      const part = run(["cat", `--offset=${offset}`, `--length=${length}`, cid + "/" + path]);
      deepStrictEqual(part, expected.subarray(offset, offset + length));
      ranges.push({ offset, length, base64: part.toString("base64") });
    }
    files.push({ path, base64: expected.toString("base64"), sha256: sha(expected), ranges });
  }
  const listings = [];
  for (const relative of ["", "nested"]) {
    const target = cid + (relative ? "/" + relative : ""),
      probe = native.run(["ls", "--enc=json", target], { optional: true });
    ok(probe.stdout.length <= 65536 && probe.stderr.length <= 65536);
    const bytes = run(["ls", "--size=false", "--resolve-type=true", target]);
    ok(bytes.length <= 65536);
    const listing = bytes.toString("utf8"),
      expected = [
        ...new Set(
          [...originals.keys()].filter((name) => !relative || name.startsWith(relative + "/")).map((name) =>
            name.slice(relative ? relative.length + 1 : 0).split("/")[0]
          ),
        ),
      ].sort();
    const names = listing.trimEnd().split("\n").map((line) => {
      const match = /^\S+\s+(.+)$/u.exec(line);
      ok(match?.[1]);
      return match[1].replace(/\/$/u, "");
    }).sort();
    deepStrictEqual(names, expected);
    listings.push({
      path: relative,
      encoderProbe: {
        exitCode: probe.status,
        stdout: probe.stdout.toString("utf8"),
        stderr: probe.stderr.toString("utf8"),
      },
      nativeTable: listing,
      expectedNames: expected,
    });
  }
  const probes = [];
  for (const name of ["", "file-000.txt", "café.txt", "a".repeat(17)]) {
    const result = native.run(["block", "put", "--format=raw", "--mhtype=murmur3-x64-64", "--mhlen=8"], {
      data: Buffer.from(name),
      optional: true,
    });
    probes.push({
      name,
      exitCode: result.status,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
    });
  }
  save(values.output, {
    evidenceProfile:
      "Genuine native Kubo HAMT importer; complete/range/path/list comparisons against authored originals; optional hash refusals not counted as hash oracles",
    sourceCommit: COMMIT,
    assetSha256: ASSET_SHA256,
    binarySha256: native.binarySha256,
    version: native.version,
    rootCid: cid,
    car: car.toString("base64"),
    carSha256: sha(car),
    blocks,
    shards,
    files,
    listings,
    hashProbes: probes,
    commands: native.commands,
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
if (failures.length) throw new AggregateError(failures, "HAMT importer and cleanup failed.");
