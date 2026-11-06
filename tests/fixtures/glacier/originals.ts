/** Writes independent deterministic originals without importing candidate code.
 *
 * This TypeScript port has not produced the historical frozen expectations.
 * The exact executed predecessor remains inert in originals.mjs.snapshot.
 */
import process from "node:process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** One bounded original input, independent of any upload or hashing implementation. */
type VectorType = { id: string; size: number; pattern: string; seed: number; partSize?: number };
const directory = process.argv[2];
if (process.argv.length !== 3 || directory === undefined) throw new Error("Use originals.ts NEW_ORIGINAL_DIRECTORY");
const output = resolve(directory);
const specification: { vectors: VectorType[] } = JSON.parse(
  await readFile(new URL("./vectors.json", import.meta.url), "utf8"),
);
await mkdir(output, { recursive: false });
const records = [];
for (const vector of specification.vectors) {
  if (
    !/^[a-z0-9-]+$/.test(vector.id) || !Number.isSafeInteger(vector.size) || vector.size < 0 ||
    vector.size > 16 * 1024 * 1024
  ) throw new Error("Original fixture specification exceeds admission");
  const bytes = new Uint8Array(vector.size);
  if (vector.pattern !== "zero") {
    if (vector.pattern !== "affine-block-v1") throw new Error("Unknown original byte pattern");
    for (let i = 0; i < bytes.length; i++) bytes[i] = (31 * i + 17 * Math.floor(i / 65536) + vector.seed) % 256;
  }
  const file = `${vector.id}.bin`;
  await writeFile(resolve(output, file), bytes, { flag: "wx" });
  records.push({ ...vector, file, sha256: createHash("sha256").update(bytes).digest("hex") });
}
await writeFile(
  resolve(output, "originals.json"),
  JSON.stringify({ authority: "authored complete original bytes; no candidate imports", vectors: records }, null, 2) +
    "\n",
  { flag: "wx" },
);
