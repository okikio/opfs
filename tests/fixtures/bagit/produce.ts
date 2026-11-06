/** Author BagIt 1.0 files from fixed originals, without candidate or Python imports.
 *
 * Node digests establish authored manifest contents. No independent bag validator
 * is run, and the pinned bagit-python validation receipt remains unchanged.
 * @module
 */
import { deepStrictEqual, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { output: { type: "string" } } });
ok(values.output, "Supply a new --output JSON path.");
const payloads = new Map([
  ["data/empty.bin", Buffer.alloc(0)],
  ["data/binary.bin", Buffer.from([0, 1, 2, 3, 255])],
  ["data/nested/café with space.txt", Buffer.from("Preserved content\n")],
  ["data/actual\nnewline.txt", Buffer.from("An encoded newline filename.\n")],
]);
const historicalPath = new URL("./independent.json", import.meta.url);
ok(statSync(historicalPath).size <= 1024 * 1024, "Historical BagIt input exceeds its bound.");
const historicalBytes = readFileSync(historicalPath);
const historical: { files: { path: string; base64: string }[] } = JSON.parse(historicalBytes.toString("utf8"));
const previousPayloads = historical.files.filter((file) => file.path.startsWith("data/"));
deepStrictEqual(previousPayloads.map((file) => file.path).sort(), [...payloads.keys()].sort());
for (const file of previousPayloads) deepStrictEqual(Buffer.from(file.base64, "base64"), payloads.get(file.path));

/** Encode literal percent first so a filename is decoded exactly once (RFC 8493). */
function filename(path: string): string {
  return path.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

/** Sorted manifest rows refer to the caller's original file bytes, never a decoded bag. */
function manifest(files: ReadonlyMap<string, Buffer>, algorithm: "sha256" | "sha512"): Buffer {
  return Buffer.from(
    [...files].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([path, bytes]) => `${createHash(algorithm).update(bytes).digest("hex")}  ${filename(path)}\n`).join(""),
  );
}

const tags = new Map<string, Buffer>([
  ["bagit.txt", Buffer.from("BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n")],
  [
    "bag-info.txt",
    Buffer.from(
      "Bagging-Date: 2026-11-05\nBag-Software-Agent: Authored TypeScript control\nContact-Name: One\nContact-Name: Two\nPayload-Oxum: 52.4\n",
    ),
  ],
]);
for (const algorithm of ["sha256", "sha512"] as const) {
  tags.set(`manifest-${algorithm}.txt`, manifest(payloads, algorithm));
}
const tagManifests = new Map<string, Buffer>();
for (const algorithm of ["sha256", "sha512"] as const) {
  tagManifests.set(`tagmanifest-${algorithm}.txt`, manifest(tags, algorithm));
}
const files = [...payloads, ...tags, ...tagManifests].sort(([left], [right]) =>
  left < right ? -1 : left > right ? 1 : 0
)
  .map(([path, bytes]) => ({
    path,
    base64: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sha512: createHash("sha512").update(bytes).digest("hex"),
  }));
const receipt = JSON.stringify(
  {
    producer: "Authored TypeScript BagIt 1.0 framing and Node digests",
    runtime: process.version,
    proof:
      "Complete payload originals match historical inputs; manifest rows are authored, not independently validated",
    independentValidation: false,
    historicalFixtureSha256: createHash("sha256").update(historicalBytes).digest("hex"),
    percentFilenameControl: { original: "literal%0A.txt", encoded: filename("data/literal%0A.txt") },
    files,
  },
  null,
  2,
) + "\n";
ok(Buffer.byteLength(receipt) <= 1024 * 1024, "BagIt receipt exceeds its output bound.");
writeFileSync(values.output, receipt, { flag: "wx" });
