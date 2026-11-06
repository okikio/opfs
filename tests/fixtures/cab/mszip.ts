/** Construct dictionary-dependent MSZIP controls with Node zlib and native 7zz.
 *
 * This source imports no candidate code. Its authored xorshift32 byte pattern
 * replaces CPython's PRNG; it does not reproduce the historical mszip.json bytes.
 * Use Node 26.5 or later for explicit trailing-compressed-input rejection and a
 * new --output receipt. Each native command is bounded to twenty seconds.
 * @module
 */
import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { constants, deflateRawSync, inflateRawSync } from "node:zlib";
import type { ZlibOptions } from "node:zlib";

const { values } = parseArgs({
  options: {
    seven: { type: "string", default: "7zz" },
    output: { type: "string" },
  },
});
ok(values.output, "Supply a new --output JSON path.");
const seven = values.seven;
ok(seven, "Supply the explicit 7zz executable.");
const [major, minor] = process.versions.node.split(".").map(Number);
ok(
  major !== undefined && minor !== undefined && (major > 26 || major === 26 && minor >= 5),
  "Node 26.5 or later is required for rejectGarbageAfterEnd.",
);
const deadline = Date.now() + 120_000;

/** The final partial word uses CAB's big-endian remainder rule, rather than zero-padded little-endian. */
function parity(bytes: Buffer): number {
  const full = bytes.length - bytes.length % 4;
  let result = 0, rest = 0;
  for (let offset = 0; offset < full; offset += 4) result ^= bytes.readUInt32LE(offset);
  for (const byte of bytes.subarray(full)) rest = (rest << 8) | byte;
  return (result ^ rest) >>> 0;
}

/** Only a normally exited native program supplies a format verdict, including the retained negative. */
function consume(args: string[]) {
  const remaining = deadline - Date.now();
  ok(remaining > 0, "Whole MSZIP producer deadline expired.");
  const result = spawnSync(seven, args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: Math.min(20_000, remaining),
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.signal || result.status === null) {
    throw new Error("7zz did not reach a native format verdict.", {
      cause: { error: result.error, signal: result.signal, status: result.status },
    });
  }
  return result;
}

/** Stable authored noise supplies original bytes before either codec reads a CAB.
 *
 * Xorshift32 uses a nonzero seed and three fixed shifts. This is a fixture byte
 * pattern, never randomness for encryption or an emulation of CPython Random.
 */
function original(length: number): Buffer {
  let state = 20519;
  return Buffer.from(Array.from({ length }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state & 255;
  }));
}

type ProfileType = { name: string; parts: Buffer[]; level: number; strategy: number };
const version = consume(["i"]);
equal(version.status, 0, "7zz version discovery failed.");
const history = original(32768);
const tail = Buffer.concat([history.subarray(1000, 13000), history.subarray(20000, 30000)]);
const profiles: ProfileType[] = [
  { name: "dynamic-history", parts: [history, tail], level: 9, strategy: constants.Z_DEFAULT_STRATEGY },
  { name: "fixed-history", parts: [history, tail], level: 9, strategy: constants.Z_FIXED },
  {
    name: "stored",
    parts: [history, Buffer.from("plain stored tail")],
    level: 0,
    strategy: constants.Z_DEFAULT_STRATEGY,
  },
  {
    name: "short-history",
    parts: [history.subarray(0, 4096), history.subarray(4096, 6144), history.subarray(0, 3000)],
    level: 9,
    strategy: constants.Z_DEFAULT_STRATEGY,
  },
  {
    name: "overlap",
    parts: [Buffer.alloc(32768, 65), Buffer.alloc(32768, 65)],
    level: 9,
    strategy: constants.Z_DEFAULT_STRATEGY,
  },
];
const root = mkdtempSync(join(tmpdir(), "opfs-mszip-controls-"));
const result = [], failures: unknown[] = [];
try {
  for (const profile of profiles) {
    const blocks: Buffer[] = [], packedBlocks: string[] = [], dependencies: boolean[] = [];
    let prior: Buffer = Buffer.alloc(0);
    for (const part of profile.parts) {
      const dictionary = prior.length ? { dictionary: prior } : {};
      // The largest unit is 32 KiB. memLevel 9 gives zlib enough pending
      // capacity to avoid splitting this incompressible original at the default
      // smaller buffer boundary. Keep the CAB bound explicit below.
      const raw = deflateRawSync(part, {
        level: profile.level,
        memLevel: 9,
        strategy: profile.strategy,
        ...dictionary,
      });
      const options: ZlibOptions & { rejectGarbageAfterEnd: boolean } = {
        ...dictionary,
        maxOutputLength: 32768,
        rejectGarbageAfterEnd: true,
      };
      const independentOptions: ZlibOptions & { rejectGarbageAfterEnd: boolean } = {
        maxOutputLength: 32768,
        rejectGarbageAfterEnd: true,
      };
      let dependent = false;
      try {
        dependent = !inflateRawSync(raw, independentOptions).equals(part);
      } catch {
        dependent = true;
      }
      deepStrictEqual(inflateRawSync(raw, options), part);
      // A native EOF is useful only with complete consumption. Exercise both
      // refusal controls so an ignored runtime option cannot silently pass.
      throws(() => inflateRawSync(Buffer.concat([raw, Buffer.from([0])]), options));
      throws(() => inflateRawSync(raw.subarray(0, -1), options));
      const packed = Buffer.concat([Buffer.from("CK"), raw]);
      ok(packed.length <= 32780, `${profile.name}: MSZIP unit exceeds the admitted CAB bound (${packed.length}).`);
      const suffix = Buffer.alloc(4);
      suffix.writeUInt16LE(packed.length, 0);
      suffix.writeUInt16LE(part.length, 2);
      const check = Buffer.alloc(4);
      check.writeUInt32LE((parity(packed) ^ parity(suffix)) >>> 0);
      blocks.push(Buffer.concat([check, suffix, packed]));
      packedBlocks.push(packed.toString("base64"));
      dependencies.push(dependent);
      prior = Buffer.concat([prior, part]).subarray(-32768);
    }
    if (profile.name.includes("history") || profile.name === "overlap") ok(dependencies.some(Boolean), profile.name);
    const body = Buffer.concat(profile.parts);
    const file = Buffer.alloc(16 + Buffer.byteLength("payload.bin\0"));
    file.writeUInt32LE(body.length);
    file.writeUInt16LE(32, 14);
    file.write("payload.bin\0", 16);
    const dataAt = 44 + file.length;
    const size = dataAt + blocks.reduce((sum, bytes) => sum + bytes.length, 0);
    const header = Buffer.alloc(36);
    header.write("MSCF");
    header.writeUInt32LE(size, 8);
    header.writeUInt32LE(44, 16);
    header[24] = 3;
    header[25] = 1;
    header.writeUInt16LE(1, 26);
    header.writeUInt16LE(1, 28);
    const folder = Buffer.alloc(8);
    folder.writeUInt32LE(dataAt);
    folder.writeUInt16LE(blocks.length, 4);
    folder.writeUInt16LE(1, 6);
    const archive = Buffer.concat([header, folder, file, ...blocks]);
    equal(archive.length, size);
    const path = join(root, `${profile.name}.cab`);
    writeFileSync(path, archive, { flag: "wx" });
    const checked = consume(["x", "-so", path, "payload.bin"]);
    if (profile.name === "short-history") {
      ok(checked.status !== 0, "The retained native short-history limitation changed.");
    } else {
      equal(checked.status, 0, checked.stderr.toString("utf8"));
      deepStrictEqual(checked.stdout, body, profile.name);
    }
    result.push({
      name: profile.name,
      archive: archive.toString("base64"),
      body: body.toString("base64"),
      parts: profile.parts.map((part) => part.toString("base64")),
      packed: packedBlocks,
      requiresHistory: dependencies,
      consumerExit: checked.status,
      consumerStderr: checked.stderr.toString("utf8"),
      consumerFullBytesMatch: checked.stdout.equals(body),
      consumerOutputBytes: checked.stdout.length,
      consumerOutputSha256: createHash("sha256").update(checked.stdout).digest("hex"),
      sha256: createHash("sha256").update(archive).digest("hex"),
    });
  }
  const receipt = JSON.stringify(
    {
      producer: `Authored TypeScript MS-CAB framing and Node zlib ${process.versions.zlib}`,
      runtime: process.version,
      compressionMemLevel: 9,
      originalPattern: "xorshift32 seed 20519, shifts 13/17/5, low byte; not CPython Random",
      source: "New authored controls; MS-MCI section 2 and RFC 1951; historical mszip.json unchanged",
      consumer: version.stdout.toString("utf8"),
      consumerCommand: [seven, "x", "-so", "<fixture.cab>", "payload.bin"],
      vectors: result,
    },
    null,
    2,
  ) + "\n";
  ok(Buffer.byteLength(receipt) <= 8 * 1024 * 1024, "MSZIP receipt exceeds its output budget.");
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
if (failures.length) throw new AggregateError(failures, "MSZIP control production and cleanup failed.");
