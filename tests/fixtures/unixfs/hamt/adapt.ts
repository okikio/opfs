/** Authored depth/padding controls with native Kubo full/range and depth-refusal proof. */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { kubo, read, save, sha } from "../native.ts";
import { car, cid, field } from "../wire.ts";
import type { BlockType } from "../wire.ts";
const { values } = parseArgs({
  options: { archive: { type: "string" }, "hash-reference": { type: "string" }, output: { type: "string" } },
});
ok(
  values.archive && values["hash-reference"] && values.output,
  "Supply --archive KUBO_TGZ --hash-reference NATIVE_JSON --output NEW_JSON.",
);
const referenceBytes = read(values["hash-reference"], 1024 * 1024);
const reference: { sourceCommit: string; vectors: { input: string; digest: string }[] } = JSON.parse(
  referenceBytes.toString("utf8"),
);
equal(reference.sourceCommit, "07bb4de10a63e8cc2e1724865454eba635742383");
ok(reference.vectors.length <= 256);
const name = Buffer.from("file-000.txt"),
  matches = reference.vectors.filter((item) => Buffer.from(item.input, "base64").equals(name));
equal(matches.length, 1);
const item = matches[0];
ok(item && /^[a-f0-9]{16}$/u.test(item.digest));
const route = Buffer.from(item.digest, "hex");
equal(route.length, 8);
const root = mkdtempSync(join(tmpdir(), "opfs-hamt-adapt-")), failures: unknown[] = [];
try {
  const native = kubo(values.archive, root),
    original = Buffer.from("Authored HAMT depth boundary original bytes.\n"),
    variants = [];
  for (
    const [label, levels, padded] of [["depth-eight-trimmed", 8, false], ["depth-eight-padded", 8, true], [
      "depth-nine-refused",
      9,
      false,
    ]] as const
  ) {
    const leaf = cid(0x55, original), blocks: BlockType[] = [{ ...leaf, body: original }];
    let childWire = leaf.wire;
    for (let depth = levels - 1; depth >= 0; depth--) {
      const bucket = depth < 8 ? route[depth] : 0;
      ok(bucket !== undefined);
      let bitmap: Buffer = Buffer.alloc(32);
      bitmap[31 - Math.floor(bucket / 8)] = 1 << (bucket % 8);
      if (!padded) bitmap = bitmap.subarray(bitmap.findIndex((byte) => byte !== 0));
      const linkName = Buffer.concat([
        Buffer.from(bucket.toString(16).toUpperCase().padStart(2, "0")),
        depth === levels - 1 ? name : Buffer.alloc(0),
      ]);
      const link = field(2, Buffer.concat([field(1, childWire), field(2, linkName), field(3, 999999)]));
      const inner = Buffer.concat([field(1, 5), field(2, bitmap), field(5, 0x22), field(6, 256)]),
        body = Buffer.concat([link, field(1, inner)]),
        block = cid(0x70, body);
      blocks.push({ ...block, body });
      childWire = block.wire;
    }
    const last = blocks.at(-1);
    ok(last);
    const archive = car(last.wire, [...blocks].reverse()), path = join(root, label + ".car");
    writeFileSync(path, archive, { flag: "wx" });
    native.run(["dag", "import", "--pin-roots=false", path]);
    const result = native.run(["cat", last.text + "/" + name.toString("utf8")], { optional: levels === 9 });
    if (levels === 9) {
      ok(
        result.status !== 0 && result.stderr.includes(Buffer.from("sharded directory too deep")),
        "Native depth-nine refusal changed.",
      );
    } else {
      deepStrictEqual(result.stdout, original, label);
      deepStrictEqual(
        native.run(["cat", "--offset=5", "--length=13", last.text + "/" + name.toString("utf8")]).stdout,
        original.subarray(5, 18),
      );
    }
    variants.push({
      name: label,
      levels,
      padded,
      rootCid: last.text,
      lookupName: name.toString("utf8"),
      route: route.toString("hex"),
      original: original.toString("base64"),
      car: archive.toString("base64"),
      nativeExitCode: result.status,
      nativeStdout: result.stdout.toString("base64"),
      nativeStderr: result.stderr.toString("utf8"),
      blocks: blocks.map((block) => ({ cid: block.text, base64: block.body.toString("base64") })),
    });
  }
  save(values.output, {
    evidenceProfile:
      "Authored shard topology/bitmap padding; native Kubo complete/range reads and hash-exhaustion refusal; not genuine importer output",
    version: native.version,
    hashReferenceSha256: sha(referenceBytes),
    variants,
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
if (failures.length) throw new AggregateError(failures, "HAMT adaptation and cleanup failed.");
