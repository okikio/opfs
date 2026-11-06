/** Genuine pinned Kubo importer and complete native original/range consumers.
 * Retained noise bytes preserve historical originals without emulating CPython's PRNG. @module
 */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { ASSET_SHA256, COMMIT, kubo, read, save, sha } from "./native.ts";
const { values } = parseArgs({ options: { archive: { type: "string" }, output: { type: "string" } } });
ok(values.archive && values.output, "Supply --archive PINNED_KUBO_TGZ --output NEW_JSON.");
const originals = new Map([
  ["hello.txt", Buffer.from("Independent UnixFS original bytes.\n")],
  ["repeat.bin", Buffer.from("abcdefgh".repeat(2048))],
  ["duplicate.bin", Buffer.from("abcdefgh".repeat(2048))],
  ["empty", Buffer.alloc(0)],
  ["unicode/café.txt", Buffer.from("Literal UTF-8 café.\n")],
  ["space name.txt", Buffer.from("spaces are literal metadata\n")],
  ["Links", Buffer.from("a directory child named Links\n")],
]);
const historicalBytes = read(new URL("./independent.json", import.meta.url));
const historical: { profiles: { files: { path: string; base64: string; sha256: string }[] }[] } = JSON.parse(
  historicalBytes.toString("utf8"),
);
const oldFiles = historical.profiles[0]?.files;
ok(oldFiles);
const noise = oldFiles.find((file) => file.path === "nested/data.bin");
ok(noise);
const bytes = Buffer.from(noise.base64, "base64");
equal(bytes.length, 20000);
equal(sha(bytes), noise.sha256);
originals.set("nested/data.bin", bytes);
equal(oldFiles.length, originals.size);
for (const file of oldFiles) deepStrictEqual(Buffer.from(file.base64, "base64"), originals.get(file.path));
const root = mkdtempSync(join(tmpdir(), "opfs-unixfs-native-")), failures: unknown[] = [];
try {
  const native = kubo(values.archive, root), run = (args: string[]) => native.run(args).stdout;
  const directory = join(root, "originals");
  mkdirSync(directory);
  for (const [name, body] of originals) {
    const path = join(directory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, { flag: "wx" });
  }
  symlinkSync("nested/data.bin", join(directory, "shortcut"));
  const results = [];
  const plans = [
    ["cidv1-raw-leaves", ["--cid-version=1", "--raw-leaves=true"]],
    ["cidv0-pb-leaves", ["--cid-version=0", "--raw-leaves=false"]],
    ["metadata", ["--cid-version=1", "--raw-leaves=false", "--mode=416", "--mtime=-12345", "--mtime-nsecs=123456789"]],
  ] as const;
  for (const [profile, flags] of plans) {
    const cid = run(["add", "--recursive", "--quieter", "--pin=false", "--chunker=size-64", ...flags, directory])
      .toString("utf8").trim();
    ok(cid.length <= 128 && /^[A-Za-z0-9]+$/u.test(cid));
    const car = run(["dag", "export", cid]),
      refs = run(["refs", "--recursive", "--unique", cid]).toString("utf8").trim().split("\n");
    ok(refs.length <= 4096);
    const blocks = [];
    for (const blockCid of new Set([cid, ...refs])) {
      ok(blockCid.length <= 128 && /^[A-Za-z0-9]+$/u.test(blockCid));
      const body = run(["block", "get", blockCid]);
      blocks.push({ cid: blockCid, base64: body.toString("base64"), size: body.length, sha256: sha(body) });
    }
    const files = [];
    for (const [path, expected] of originals) {
      const target = cid + "/" + path;
      deepStrictEqual(run(["cat", target]), expected, `${profile}/${path}`);
      const ranges = [];
      if (expected.length) {
        for (const offset of [0, Math.max(0, expected.length - 17)]) {
          const length = Math.min(17, expected.length),
            part = run(["cat", `--offset=${offset}`, `--length=${length}`, target]);
          deepStrictEqual(part, expected.subarray(offset, offset + length));
          ranges.push({ offset, length, base64: part.toString("base64") });
        }
      }
      files.push({ path, base64: expected.toString("base64"), sha256: sha(expected), ranges });
    }
    results.push({ profile, cid, car: car.toString("base64"), carSha256: sha(car), blocks, files });
  }
  const singleRoots = [], hello = originals.get("hello.txt");
  ok(hello);
  for (const raw of [true, false]) {
    const cid = run([
      "add",
      "--quieter",
      "--pin=false",
      "--cid-version=1",
      `--raw-leaves=${raw}`,
      join(directory, "hello.txt"),
    ]).toString("utf8").trim();
    deepStrictEqual(run(["cat", cid]), hello);
    const body = run(["block", "get", cid]);
    singleRoots.push({ raw, cid, base64: body.toString("base64"), original: hello.toString("base64") });
  }
  save(values.output, {
    evidenceProfile: "Genuine Kubo importer; native complete/range comparisons against independent original inputs",
    originalNoiseSource: "Exact retained historical nested/data.bin bytes; no CPython PRNG emulation",
    historicalFixtureSha256: sha(historicalBytes),
    sourceCommit: COMMIT,
    assetSha256: ASSET_SHA256,
    binarySha256: native.binarySha256,
    version: native.version,
    profiles: results,
    singleRoots,
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
if (failures.length) throw new AggregateError(failures, "UnixFS importer and cleanup failed.");
