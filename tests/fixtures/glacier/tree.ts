/** Reproduce Glacier tree values with Node's built-in SHA-256.
 *
 * This is an authored comparison implementation, not the historical botocore
 * execution. The unchanged botocore output remains the independent test oracle.
 * Supply a directory created by originals.ts and a new output JSON path. Every
 * complete input must match its recorded size and SHA-256 before tree work.
 * No OPFS implementation or Python source is loaded.
 * @module
 */
import { createHash } from "node:crypto";
import { ok } from "node:assert";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

type VectorType = { id: string; file: string; size: number; sha256: string; partSize?: number };
const mib = 1024 * 1024;
const hash = (bytes: Uint8Array): Buffer => createHash("sha256").update(bytes).digest();
const hex = (bytes: Uint8Array): string => hash(bytes).toString("hex");

/** Pair raw digests, promoting an unpaired final node unchanged at each level.
 * The digest of an empty input is SHA-256 of zero bytes. Hex text is never
 * hashed as a tree node, which would produce a different archive checksum.
 */
function tree(bytes: Uint8Array): string {
  let level: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += mib) level.push(hash(bytes.subarray(at, at + mib)));
  if (level.length === 0) return hex(bytes);
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let at = 0; at < level.length; at += 2) {
      const left = level[at];
      const right = level[at + 1];
      ok(left, "A tree level cannot have a missing admitted leaf");
      next.push(right === undefined ? left : hash(Buffer.concat([left, right])));
    }
    level = next;
  }
  const root = level[0];
  ok(root, "A nonempty tree must retain its root");
  return root.toString("hex");
}
function leaves(bytes: Uint8Array): string[] {
  const result: string[] = [];
  for (let at = 0; at < bytes.length; at += mib) result.push(hex(bytes.subarray(at, at + mib)));
  return result;
}
if (process.argv.length !== 4) throw new Error("Use tree.ts ORIGINAL_DIRECTORY NEW_OUTPUT_JSON");
const input = process.argv[2];
const output = process.argv[3];
ok(input && output, "Input and output paths are required");
const directory = resolve(input);
const manifest = JSON.parse(await readFile(resolve(directory, "originals.json"), "utf8")) as { vectors: VectorType[] };
const records = [];
for (const vector of manifest.vectors) {
  if (
    basename(vector.file) !== vector.file || !/^[a-z0-9-]+\.bin$/u.test(vector.file) ||
    !Number.isSafeInteger(vector.size) || vector.size < 0 || vector.size > 16 * mib
  ) {
    throw new Error("Original vector exceeds filename or 16 MiB admission");
  }
  const bytes = await readFile(resolve(directory, vector.file));
  if (bytes.length !== vector.size || hex(bytes) !== vector.sha256) throw new Error("Original complete bytes changed");
  const parts = [];
  const size = vector.partSize;
  if (size !== undefined) {
    if (!Number.isSafeInteger(size) || size < mib || size > 16 * mib || size % mib || (size & (size - 1))) {
      throw new Error("Multipart fixture requires a power-of-two MiB part size within the fixture budget");
    }
    for (let start = 0; start < bytes.length; start += size) {
      const part = bytes.subarray(start, start + size);
      parts.push({
        start,
        endInclusive: start + part.length - 1,
        size: part.length,
        linearSha256: hex(part),
        leafHashes: leaves(part),
        treeHash: tree(part),
      });
    }
  }
  records.push({
    id: vector.id,
    file: vector.file,
    size: bytes.length,
    linearSha256: vector.sha256,
    leafHashes: leaves(bytes),
    treeHash: tree(bytes),
    ...(size === undefined ? {} : { partSize: size }),
    parts,
  });
}
await writeFile(
  resolve(output),
  JSON.stringify(
    {
      authority: "authored TypeScript comparison using Node SHA-256; not a new botocore oracle execution",
      vectors: records,
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
