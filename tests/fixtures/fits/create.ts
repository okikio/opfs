/** CFITSIO writes and reads its native profile; authored values supply the byte oracle, not Astropy. */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { endianness, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const CAP = 16 * 1024 * 1024;
const { values: args } = parseArgs({
  options: {
    source: { type: "string" },
    output: { type: "string" },
    cc: { type: "string", default: "cc" },
    prlimit: { type: "string", default: "/usr/bin/prlimit" },
  },
});
if (args.source === undefined || args.output === undefined) {
  throw new TypeError("--source and a new --output destination are required.");
}
equal(endianness(), "LE", "Native dump comparisons currently require a little-endian runner.");
const source = resolve(args.source);
interface BlobType {
  readonly base64: string;
  readonly sha256: string;
}
interface CommandType {
  readonly argv: readonly string[];
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
const commands: CommandType[] = [];
/** A kernel per-file ceiling complements finite command time and captured diagnostics. */
function run(argv: readonly string[], cwd: string): string {
  const child = spawnSync(args.prlimit, [`--fsize=${CAP}:${CAP}`, "--", ...argv], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (child.error !== undefined || child.status === null || child.signal !== null) {
    throw new Error(JSON.stringify({ argv, signal: child.signal, error: child.error?.message }));
  }
  const receipt = { argv, code: child.status, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
  commands.push(receipt);
  if (child.status !== 0) throw new Error(JSON.stringify(receipt));
  return receipt.stdout;
}
/** Rejects links and oversized native output before materialization. */
function read(path: string): Buffer {
  const info = lstatSync(path);
  ok(info.isFile() && info.size <= CAP, "Fixture inputs and outputs must be regular files within 16 MiB.");
  return readFileSync(path);
}
function packed(data: Buffer): BlobType {
  return { base64: data.toString("base64"), sha256: createHash("sha256").update(data).digest("hex") };
}
const root = mkdtempSync(join(tmpdir(), "opfs-fits-native-"));
try {
  const executable = join(root, "fits-native");
  run([args.cc, source, "-lcfitsio", "-o", executable], root);
  const compiler = run([args.cc, "--version"], root);
  const packages = run(["/usr/bin/dpkg-query", "-W", "libcfitsio-dev", "gcc", "util-linux"], root);
  const path = join(root, "cfitsio.fits"), output = join(root, "dump");
  run([executable, "write", path, root], root);
  mkdirSync(output);
  const receipt = run([executable, "read", path, output], root);
  deepStrictEqual(
    receipt.trim().split(/\r?\n/u),
    ["0 1 1", "1 1 1"],
    "CFITSIO must report valid data and HDU checksums for both images.",
  );
  deepStrictEqual(readdirSync(output).sort(), ["0.bin", "0.physical", "1.bin"]);
  const shortValues = [-32768, -7, 0, 1, 7, 32767];
  const shorts = Buffer.alloc(shortValues.length * 2), physical = Buffer.alloc(shortValues.length * 8);
  for (const [index, value] of shortValues.entries()) {
    shorts.writeInt16LE(value, index * 2);
    physical.writeDoubleLE(value, index * 8);
  }
  const exact = [-9007199254740993n, 9007199254740993n, 9223372036854775807n];
  const longs = Buffer.alloc(exact.length * 8);
  for (const [index, value] of exact.entries()) longs.writeBigInt64LE(value, index * 8);
  deepStrictEqual(read(join(output, "0.bin")), shorts);
  deepStrictEqual(read(join(output, "0.physical")), physical);
  deepStrictEqual(read(join(output, "1.bin")), longs);
  const images = [
    {
      id: 0,
      bitpix: 16,
      axes: [3, 2],
      nativeLittleEndian: packed(shorts),
      physicalLittleEndian: packed(physical),
      checksum: "CFITSIO verified; no Astropy check",
    },
    {
      id: 1,
      bitpix: 64,
      axes: [3],
      nativeLittleEndian: packed(longs),
      physicalLittleEndian: null,
      checksum: "CFITSIO verified; no Astropy check",
    },
  ];
  const result = {
    byteorder: "little",
    evidence: "CFITSIO producer and consumer with authored full-byte expectations; not reciprocal Astropy acceptance",
    compiler,
    packages,
    commands,
    limits: { fileBytes: CAP, diagnosticBytes: 4 * 1024 * 1024, deadlineMs: 60_000, wrapper: args.prlimit },
    sources: {
      "create.ts": packed(read(fileURLToPath(import.meta.url))).sha256,
      "native.c": packed(read(source)).sha256,
    },
    fixtures: [{ producer: "cfitsio", file: packed(read(path)), images, cfitsioReceipt: receipt }],
  };
  writeFileSync(resolve(args.output), `${JSON.stringify(result)}\n`, { flag: "wx" });
} finally {
  rmSync(root, { recursive: true, force: true });
}
