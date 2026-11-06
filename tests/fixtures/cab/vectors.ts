/** Construct CAB checksum controls and compare every accepted payload with cabextract.
 *
 * This producer imports no candidate code. The exact historical producer remains
 * vectors.py.snapshot; this TypeScript port writes a new caller-selected receipt.
 * Ordinary vectors must pass. Reserved-area outcomes remain diagnostic evidence.
 * @module
 */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    cabextract: { type: "string", default: "cabextract" },
    output: { type: "string" },
  },
});
ok(values.output, "Supply a new --output JSON path.");
const consumer = values.cabextract;
ok(consumer, "Supply the explicit cabextract executable.");
const deadline = Date.now() + 5 * 60_000;

/** CAB XORs complete little-endian words, then treats any remainder as big-endian. */
function checksum(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const full = bytes.length - bytes.length % 4;
  let value = 0;
  for (let offset = 0; offset < full; offset += 4) value ^= view.getUint32(offset, true);
  let remainder = 0;
  for (const byte of bytes.subarray(full)) remainder = (remainder << 8) | byte;
  return (value ^ remainder) >>> 0;
}

/** A missing executable, signal or expired watchdog must not become a negative format result. */
function consume(args: string[]) {
  const remaining = deadline - Date.now();
  ok(remaining > 0, "Whole vector producer deadline expired.");
  const result = spawnSync(consumer, args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: Math.min(15_000, remaining),
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.signal || result.status === null) {
    throw new Error("cabextract did not reach a native format verdict.", {
      cause: {
        error: result.error,
        signal: result.signal,
        status: result.status,
      },
    });
  }
  return result;
}

const version = consume(["--version"]);
equal(version.status, 0, "cabextract version discovery failed.");
type VectorType = {
  size: number;
  blockReserveBytes: number;
  checksumScope: "fixed-header" | "header-and-reserve";
  consumerAccepted: boolean;
  consumerExitCode: number | null;
  consumerStderr: string;
  checksum: number;
  archive: string;
  body: string;
  sha256: string;
};
const result: VectorType[] = [], diagnostics: VectorType[] = [];
const root = mkdtempSync(join(tmpdir(), "opfs-cab-vectors-"));
const failures: unknown[] = [];
try {
  for (const size of [1, 2, 3, 4]) {
    const scopes: [number, "fixed-header" | "header-and-reserve"][] = [[0, "fixed-header"]];
    for (const reserve of [1, 2, 3]) scopes.push([reserve, "fixed-header"], [reserve, "header-and-reserve"]);
    for (const [reserve, scope] of scopes) {
      const body = Buffer.from([0x11, 0x22, 0x33, 0x44].slice(0, size));
      const reservedHeader = reserve ? Buffer.from([0, 0, 0, reserve]) : Buffer.alloc(0);
      const filesAt = 44 + reservedHeader.length;
      const dataAt = filesAt + 18;
      const suffix = Buffer.alloc(4 + reserve);
      suffix.writeUInt16LE(size, 0);
      suffix.writeUInt16LE(size, 2);
      suffix.set([0x55, 0x66, 0x77].slice(0, reserve), 4);
      const check = (checksum(body) ^ checksum(scope === "header-and-reserve" ? suffix : suffix.subarray(0, 4))) >>> 0;
      const totalSize = dataAt + 4 + suffix.length + body.length;
      const header = Buffer.alloc(36);
      header.write("MSCF");
      header.writeUInt32LE(totalSize, 8);
      header.writeUInt32LE(filesAt, 16);
      header[24] = 3;
      header[25] = 1;
      header.writeUInt16LE(1, 26);
      header.writeUInt16LE(1, 28);
      header.writeUInt16LE(reserve ? 4 : 0, 30);
      const folder = Buffer.alloc(8);
      folder.writeUInt32LE(dataAt, 0);
      folder.writeUInt16LE(1, 4);
      const file = Buffer.alloc(18);
      file.writeUInt32LE(size, 0);
      file.writeUInt16LE(32, 14);
      file[16] = 0x61;
      const parity = Buffer.alloc(4);
      parity.writeUInt32LE(check);
      const archive = Buffer.concat([header, reservedHeader, folder, file, parity, suffix, body]);
      equal(archive.length, totalSize);
      const name = `size${size}-reserve${reserve}-${scope}`;
      const path = join(root, `${name}.cab`), destination = join(root, name);
      writeFileSync(path, archive, { flag: "wx" });
      mkdirSync(destination);
      const checked = consume(["-q", "-d", destination, path]);
      const accepted = checked.status === 0;
      if (accepted) deepStrictEqual(readFileSync(join(destination, "a")), body);
      if (!reserve) ok(accepted, `Ordinary checksum vector failed: ${checked.stderr.toString("utf8")}`);
      (reserve ? diagnostics : result).push({
        size,
        blockReserveBytes: reserve,
        checksumScope: scope,
        consumerAccepted: accepted,
        consumerExitCode: checked.status,
        consumerStderr: checked.stderr.toString("utf8"),
        checksum: check,
        archive: archive.toString("base64"),
        body: body.toString("base64"),
        sha256: createHash("sha256").update(archive).digest("hex"),
      });
    }
  }
  equal(result.length, 4);
  equal(diagnostics.length, 24);
  const receipt = JSON.stringify(
    {
      source: "Authored TypeScript MS-CAB section 3.1 mathematical controls; independent cabextract payload comparison",
      consumer: version.stdout.toString("utf8").trim(),
      vectors: result,
      reservedDiagnostics: diagnostics,
    },
    null,
    2,
  ) + "\n";
  ok(Buffer.byteLength(receipt) <= 1024 * 1024, "Vector receipt exceeds its output budget.");
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
if (failures.length) throw new AggregateError(failures, "CAB vector production and cleanup failed.");
