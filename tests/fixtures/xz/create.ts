/** Native XZ Utils producer and independent 7-Zip consumer; no candidate decoder imports. */
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command, encoded, equal, observe, options, producer, publish, randomBytes } from "../codec.ts";

const args = options(["output", "seven", "xz"]);
const xz = args.xz ?? "xz", seven = args.seven ?? "7zz";

/** Bit-at-a-time CRC64/XZ uses BigInt rather than the candidate's two-word lookup implementation. */
function crc64(bytes: Uint8Array): bigint {
  const mask = (1n << 64n) - 1n;
  let state = mask;
  for (const byte of bytes) {
    state ^= BigInt(byte);
    for (let bit = 0; bit < 8; bit++) state = (state >> 1n) ^ ((state & 1n) ? 0xc96c5795d7870f42n : 0n);
  }
  return state ^ mask;
}
if (crc64(Buffer.from("123456789")) !== 0x995dc9bbdf1939fan || crc64(Buffer.alloc(0)) !== 0n) {
  throw new Error("Independent CRC64 check failed.");
}

function vli(raw: Buffer, start: number): { readonly value: number; readonly next: number } {
  let value = 0n;
  for (let index = 0; index < 9; index++) {
    const byte = raw[start + index];
    if (byte === undefined) throw new Error("Truncated native VLI.");
    value |= BigInt(byte & 127) << BigInt(index * 7);
    if (!(byte & 128)) {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Native VLI exceeds exact arithmetic.");
      return { value: Number(value), next: start + index + 1 };
    }
  }
  throw new Error("Native VLI exceeds documented encoding.");
}

/** Locate native block checks through the footer/index and compare every complete authored block. */
function checks64(
  raw: Buffer,
  body: Buffer,
): readonly {
  readonly offset: number;
  readonly decodedOffset: number;
  readonly decodedBytes: number;
  readonly hex: string;
}[] {
  const indexAt = raw.length - 12 - (raw.readUInt32LE(raw.length - 8) + 1) * 4;
  if (raw[7] !== 4 || raw[indexAt] !== 0) throw new Error("Expected native CRC64 XZ index.");
  const count = vli(raw, indexAt + 1);
  let at = count.next, physical = 12, decoded = 0;
  const checks = [];
  for (let index = 0; index < count.value; index++) {
    const unpadded = vli(raw, at), size = vli(raw, unpadded.next);
    at = size.next;
    const padded = Math.ceil(unpadded.value / 4) * 4;
    const checkAt = physical + padded - 8;
    const expected = crc64(body.subarray(decoded, decoded + size.value));
    if (raw.readBigUInt64LE(checkAt) !== expected) {
      throw new Error("Native CRC64 differs from independent authored block.");
    }
    checks.push({
      offset: checkAt,
      decodedOffset: decoded,
      decodedBytes: size.value,
      hex: expected.toString(16).padStart(16, "0"),
    });
    physical += padded;
    decoded += size.value;
  }
  if (decoded !== body.length) throw new Error("Native block sizes differ from authored total.");
  return checks;
}

const period = randomBytes(65000, 92311);
const bodies: Record<string, Buffer> = {
  empty: Buffer.alloc(0),
  literal: Buffer.from("Independent XZ container payload\x00\xff", "latin1"),
  overlap: Buffer.alloc(9000, 97),
  wrap: Buffer.concat([period, period, period, period.subarray(0, 117)]),
  vector: Buffer.from("123456789"),
};
const profiles: readonly (readonly [string, string, readonly string[]])[] = [
  ["crc32-empty", "empty", ["-T1", "--check=crc32", "--lzma2=dict=64KiB"]],
  ["crc32-literal", "literal", ["-T1", "--check=crc32", "--lzma2=dict=64KiB"]],
  ["none-literal", "literal", ["-T1", "--check=none", "--lzma2=dict=64KiB"]],
  ["crc32-overlap", "overlap", ["-T1", "--check=crc32", "--lzma2=dict=4KiB"]],
  ["crc32-wrap", "wrap", ["-T1", "--check=crc32", "--lzma2=dict=64KiB"]],
  ["crc32-blocks", "wrap", ["-T1", "--check=crc32", "--block-size=65536", "--lzma2=dict=64KiB"]],
  ["crc32-threaded", "wrap", ["-T2", "--check=crc32", "--block-size=65536", "--lzma2=dict=64KiB"]],
  ...["literal", "empty", "vector", "wrap"].map((name) =>
    ["crc64-" + name, name, ["-T1", "--check=crc64", "--lzma2=dict=64KiB"]] as const
  ),
  ["crc64-default-threaded", "wrap", ["-T2", "--block-size=65536", "--lzma2=dict=64KiB"]],
  ["sha256-refusal", "literal", ["-T1", "--check=sha256", "--lzma2=dict=64KiB"]],
  ["delta-refusal", "literal", ["-T1", "--check=crc32", "--delta=dist=1", "--lzma2=dict=64KiB"]],
  ["bcj-refusal", "literal", ["-T1", "--check=crc32", "--x86", "--lzma2=dict=64KiB"]],
];
const root = mkdtempSync(join(tmpdir(), "opfs-xz-ts-"));
const cases: unknown[] = [];
let literal: Buffer | undefined;
try {
  for (const [name, bodyName, flags] of profiles) {
    const body = bodies[bodyName];
    if (!body) throw new Error("Unknown authored XZ body.");
    const raw = command(xz, [...flags, "-c"], body);
    const path = join(root, name + ".xz");
    writeFileSync(path, raw);
    equal(command(xz, ["-dc"], raw), body, name + " xz");
    equal(command(seven, ["x", "-so", path]), body, name + " 7-Zip");
    if (name === "crc32-literal") literal = raw;
    const evidence: Record<string, unknown> = {};
    if (raw[7] === 4) {
      const checks = checks64(raw, body);
      evidence.crc64Checks = checks;
      if (checks.length) {
        const damaged = Buffer.from(raw);
        damaged[checks[0]!.offset]! ^= 1;
        const bad = join(root, name + "-corrupt.xz");
        writeFileSync(bad, damaged);
        const failures = [];
        for (const [tool, flags_] of [[seven, ["x", "-so", bad]], [xz, ["-dc", bad]]] as const) {
          const result = observe(tool, flags_);
          if (result.exitCode === 0) throw new Error("Native consumer accepted damaged CRC64: " + tool);
          failures.push({ consumer: tool, exitCode: result.exitCode, stderr: result.stderr.toString("utf8") });
        }
        evidence.nativeChecksumCorruptionFailures = failures;
      }
    }
    cases.push({
      name,
      command: [xz, ...flags, "-c"],
      archive: raw.toString("base64"),
      body: body.toString("base64"),
      sha256: encoded(raw).sha256,
      supported: !name.endsWith("-refusal"),
      origin: "Genuine XZ Utils container; native xz and independent 7-Zip full-byte consumers",
      ...evidence,
    });
  }
  if (!literal) throw new Error("Missing native literal profile.");
  const padded = Buffer.concat([literal, Buffer.alloc(20)]), path = join(root, "padded.xz");
  writeFileSync(path, padded);
  const body = bodies.literal!;
  equal(command(xz, ["-dc"], padded), body, "XZ stream padding");
  equal(command(seven, ["x", "-so", path]), body, "7-Zip stream padding");
  cases.push({
    name: "crc32-padded",
    archive: padded.toString("base64"),
    body: body.toString("base64"),
    sha256: encoded(padded).sha256,
    supported: true,
    origin: "Authored 20-byte Stream Padding appended to genuine XZ container; xz and 7-Zip full-byte acceptance",
  });
  publish(args.output!, {
    ...producer(import.meta.url),
    tools: { xz: command(xz, ["--version"]).toString("utf8"), "7zip": command(seven, ["i"]).toString("utf8") },
    randomRecipe: "xorshift32 seed92311, low byte each round; not historical Python MT",
    cases,
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}
