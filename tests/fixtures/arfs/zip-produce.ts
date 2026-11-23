/** Native InfoZIP producer and libarchive consumer for ArFS archive composition.
 * The original Python-produced zip.json stays unchanged. A new run proves only
 * the native ZIP payload below, not ArFS signing, chain inclusion or transport.
 */
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command, equal, hash, options } from "../codec.ts";

const args = options(["zip", "bsdtar", "output"]);
const destination = args.output;
if (!destination) throw new TypeError("Supply a new --output path");
const zip = args.zip ?? "zip";
const bsdtar = args.bsdtar ?? "bsdtar";
const original = Buffer.from("Selected member from an explicitly supplied ArFS data source.\n");
const root = mkdtempSync(join(tmpdir(), "opfs-arfs-zip-"));
try {
  const name = "preview.txt";
  const path = join(root, name);
  writeFileSync(path, original, { flag: "wx" });
  const time = new Date("2026-01-01T00:00:00Z");
  utimesSync(path, time, time);
  command(zip, ["-0", "-X", "native.zip", name], undefined, root);
  const archive = join(root, "native.zip");
  if (statSync(archive).size > 1024 * 1024) throw new RangeError("Native ZIP exceeds 1 MiB admission");
  const wire = readFileSync(archive);
  equal(command(bsdtar, ["-xOf", archive, name]), original, name);
  const receipt = {
    producer: "native InfoZIP zip, STORED; changed producer profile",
    version: command(zip, ["-v"]).toString(),
    consumer: command(bsdtar, ["--version"]).toString(),
    sourceSha256: hash(readFileSync(new URL(import.meta.url))),
    wireBase64: wire.toString("base64"),
    sha256: hash(wire),
    name,
    originalBase64: original.toString("base64"),
  };
  writeFileSync(destination, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
} finally {
  rmSync(root, { recursive: true, force: true });
}
