/** Authored wire variants, independently imported and read by pinned native Kubo. */
import { deepStrictEqual, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { kubo, save } from "./native.ts";
import { car, cid, field, uint } from "./wire.ts";
import type { BlockType } from "./wire.ts";
const { values } = parseArgs({ options: { archive: { type: "string" }, output: { type: "string" } } });
ok(values.archive && values.output, "Supply --archive PINNED_KUBO_TGZ --output NEW_JSON.");
const root = mkdtempSync(join(tmpdir(), "opfs-unixfs-adapt-")), failures: unknown[] = [];
try {
  const native = kubo(values.archive, root), run = (args: string[]) => native.run(args).stdout;
  const leaf = [Buffer.from("leaf-data"), Buffer.alloc(0)], first = leaf[0];
  ok(first);
  const leaves: BlockType[] = leaf.map((body) => ({ ...cid(0x55, body), body }));
  const expected = Buffer.concat([first, first]);
  const links = Buffer.concat([0, 0, 1].map((index) => {
    const child = leaves[index];
    ok(child);
    return field(2, Buffer.concat([field(1, child.wire), field(3, 999999)]));
  }));
  const data = Buffer.concat([field(1, 2), field(2, Buffer.alloc(0)), field(3, expected.length)]);
  const plans = [
    [
      "links-first-expanded-no-inline",
      Buffer.concat([data, ...[first.length, first.length, 0].map((size) => field(4, size))]),
      false,
    ],
    [
      "data-first-packed-no-inline",
      Buffer.concat([data, field(4, Buffer.concat([uint(first.length), uint(first.length), uint(0)]))]),
      true,
    ],
    [
      "data-first-mixed-no-inline",
      Buffer.concat([data, field(4, first.length), field(4, Buffer.concat([uint(first.length), uint(0)]))]),
      true,
    ],
  ] as const;
  const variants = [];
  for (const [name, inner, dataFirst] of plans) {
    const outer = field(1, inner), body = Buffer.concat(dataFirst ? [outer, links] : [links, outer]);
    const rootCid = cid(0x70, body),
      blocks: BlockType[] = [{ ...rootCid, body }, ...leaves],
      archive = car(rootCid.wire, blocks),
      path = join(root, name + ".car");
    writeFileSync(path, archive, { flag: "wx" });
    run(["dag", "import", "--pin-roots=false", path]);
    deepStrictEqual(run(["cat", rootCid.text]), expected, name);
    deepStrictEqual(run(["cat", "--offset=5", "--length=13", rootCid.text]), expected.subarray(5, 18), name);
    variants.push({
      name,
      cid: rootCid.text,
      base64: body.toString("base64"),
      car: archive.toString("base64"),
      original: expected.toString("base64"),
      blocks: blocks.map((block) => ({ cid: block.text, base64: block.body.toString("base64") })),
      nativeCompleteExact: true,
      nativeRangeExact: true,
    });
  }
  save(values.output, {
    evidenceProfile:
      "Authored wire variants imported and consumed by native Kubo; not genuine importer-produced topology",
    version: native.version,
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
if (failures.length) throw new AggregateError(failures, "UnixFS adaptation and cleanup failed.");
