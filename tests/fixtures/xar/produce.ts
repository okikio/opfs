/** Retain genuine native XAR output and compare every extracted original.
 *
 * Node independently checks the header, TOC zlib length and TOC checksum.
 * Historical Python additionally walked member checksum XML; that proof is not
 * relabelled as a new execution. No candidate parser or XML package is imported.
 * @module
 */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { inflateSync } from "node:zlib";
import { command, read, sha } from "../iso/native.ts";
const { values } = parseArgs({
  options: {
    output: { type: "string" },
    xar: { type: "string", default: "/usr/bin/xar" },
    bsdtar: { type: "string", default: "/usr/bin/bsdtar" },
  },
});
ok(values.output && values.xar && values.bsdtar, "Supply native tools and a new --output path.");
const { xar, bsdtar } = values;
const expected = new Map([["hello.txt", Buffer.from("authored XAR oracle\n")], [
  "nested/data.bin",
  Buffer.from(Array.from({ length: 768 }, (_, index) => index % 256)),
], ["empty", Buffer.alloc(0)]]);

/** Read only the producer's fixed root checksum shape, not arbitrary XML trees. */
function check(data: Buffer) {
  ok(data.length >= 28);
  equal(data.readUInt32BE(0), 0x78617221);
  equal(data.readUInt16BE(4), 28);
  equal(data.readUInt16BE(6), 1);
  const packedBig = data.readBigUInt64BE(8), decodedBig = data.readBigUInt64BE(16);
  ok(packedBig <= 1024n * 1024n && decodedBig <= 1024n * 1024n, "XAR TOC exceeds its byte bound.");
  const packed = Number(packedBig), decoded = Number(decodedBig), code = data.readUInt32BE(24);
  ok(28 + packed <= data.length, "XAR TOC is truncated.");
  const algorithm = code === 1 ? "sha1" : code === 3 ? "sha256" : code === 4 ? "sha512" : undefined;
  ok(algorithm, "Unexpected native TOC checksum code.");
  const compressed = data.subarray(28, 28 + packed), xml = inflateSync(compressed, { maxOutputLength: 1024 * 1024 });
  equal(xml.length, decoded);
  // These are constant native-generated tags. Reject an unexpected shape rather
  // than treating a permissive regex as a general XML parser.
  const text = xml.toString("utf8");
  ok(!text.includes("<!DOCTYPE") && !text.includes("<!ENTITY"));
  const matches = [
    ...text.matchAll(
      /<checksum style="(sha1|sha256|sha512)">\s*<offset>(\d+)<\/offset>\s*<size>(\d+)<\/size>\s*<\/checksum>/gu,
    ),
  ];
  equal(matches.length, 1, "Native root checksum shape changed.");
  const match = matches[0];
  ok(match);
  equal(match[1], algorithm);
  const offset = Number(match[2]), size = Number(match[3]);
  ok(
    Number.isSafeInteger(offset) && Number.isSafeInteger(size) && offset >= 0 && size > 0 &&
      28 + packed + offset + size <= data.length,
  );
  const digest = createHash(algorithm).update(compressed).digest();
  equal(size, digest.length);
  deepStrictEqual(data.subarray(28 + packed + offset, 28 + packed + offset + size), digest);
  return { headerBytes: 28, checksumCode: code, tocBytes: decoded, memberChecksumWalk: false };
}
const root = mkdtempSync(join(tmpdir(), "opfs-xar-controls-")), failures: unknown[] = [];
try {
  for (const [name, bytes] of expected) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes, { flag: "wx" });
  }
  const plans = (["none", "gzip"] as const).flatMap((compression) =>
    (["sha1", "sha256", "sha512"] as const).map((algorithm) => ({ producer: "xar", compression, algorithm }))
  )
    .concat([{ producer: "bsdtar", compression: "gzip", algorithm: "sha1" }]);
  const objects = [];
  for (const { producer, compression, algorithm } of plans) {
    const id = `${producer}-${compression}-${algorithm}`, archive = join(root, id + ".xar");
    if (producer === "xar") {
      command(xar, [
        "-cf",
        archive,
        `--compression=${compression}`,
        `--toc-cksum=${algorithm}`,
        `--file-cksum=${algorithm}`,
        ...expected.keys(),
      ], { cwd: root });
    } else command(bsdtar, ["-cf", archive, "--format=xar", ...expected.keys()], { cwd: root });
    const data = read(archive), oracle = check(data), receipts = [];
    for (const [name, original] of expected) {
      const result = command(bsdtar, ["-xOf", archive, name], { allowFailure: algorithm !== "sha1" });
      const exact = result.status === 0 && result.stdout.equals(original);
      if (algorithm === "sha1") ok(exact, "SHA1 libarchive extraction differs from complete original.");
      receipts.push({ path: name, exitCode: result.status, stderr: result.stderr.toString("utf8"), exact });
    }
    const output = join(root, id + "-native");
    mkdirSync(output);
    command(xar, ["-xf", archive, "-C", output]);
    let count = 0;
    const extracted = new Map<string, Buffer>();
    const walk = (directory: string, prefix = ""): void => {
      for (const name of readdirSync(directory)) {
        ok(++count <= 8, "Unexpected extracted XAR tree size.");
        const path = join(directory, name), info = lstatSync(path);
        ok(!info.isSymbolicLink(), "Unexpected native extraction symlink.");
        if (info.isDirectory()) walk(path, prefix + name + "/");
        else extracted.set(prefix + name, read(path, 1024 * 1024));
      }
    };
    walk(output);
    equal(extracted.size, expected.size);
    for (const [name, original] of expected) deepStrictEqual(extracted.get(name), original, name);
    objects.push({
      producer,
      compression,
      algorithm,
      base64: data.toString("base64"),
      sha256: sha(data),
      oracle,
      bsdtar: receipts,
      nativeExtractExact: true,
    });
  }
  const receipt = JSON.stringify(
    {
      runtime: process.version,
      producer: command(xar, ["--version"]).stdout.toString("utf8"),
      consumer: command(bsdtar, ["--version"]).stdout.toString("utf8"),
      proof:
        "Native xar/libarchive producers and complete native xar extraction; SHA1 libarchive exact bytes; header/TOC Node checks only, no new independent member-checksum XML walk",
      records: [...expected].map(([path, bytes]) => ({ path, base64: bytes.toString("base64") })),
      objects,
    },
    null,
    2,
  ) + "\n";
  ok(Buffer.byteLength(receipt) <= 32 * 1024 * 1024, "XAR receipt exceeds its output bound.");
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
if (failures.length) throw new AggregateError(failures, "XAR production and cleanup failed.");
