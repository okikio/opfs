/** Authored test admission. No candidate archive reader or downloaded package runs here. */
import { equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { inflateRawSync } from "node:zlib";

export const MIB = 1024 * 1024;
export function sha(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}
export function read(path: string, maximum = 32 * MIB): Buffer {
  const info = lstatSync(path);
  ok(info.isFile() && info.size <= maximum, "Fixture file exceeds its regular-file admission budget.");
  return readFileSync(path);
}
export interface CommandType {
  readonly argv: readonly string[];
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
/** prlimit execs its single native child; no shell, compiler plugin or resolver is used. */
export function run(argv: readonly string[], receipts: CommandType[], cwd?: string, input?: string): string {
  const child = spawnSync("/usr/bin/prlimit", [`--fsize=${32 * MIB}:${32 * MIB}`, "--", ...argv], {
    cwd,
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout: 120_000,
    killSignal: "SIGKILL",
    maxBuffer: 4 * MIB,
  });
  if (child.error !== undefined || child.status === null || child.signal !== null) {
    throw new Error(JSON.stringify({ argv, error: child.error?.message, signal: child.signal }));
  }
  const record = { argv, code: child.status, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
  receipts.push(record);
  if (record.code !== 0) throw new Error(JSON.stringify(record));
  return record.stdout;
}

/** CRC32 checks the ZIP envelope only; SHA256 pins its complete upstream identity. */
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc(body: Buffer): number {
  let value = 0xffffffff;
  for (const byte of body) {
    value = value >>> 8 ^ CRC_TABLE[(value ^ byte) & 255]!;
  }
  return (value ^ 0xffffffff) >>> 0;
}
export interface MemberType {
  readonly name: string;
  readonly body: Buffer;
  readonly sha256: string;
}
/**
 * Reads the two exact pinned ZIP32 profiles. This is not a general ZIP API.
 * Every member is admitted, including members that will never be extracted.
 */
export function inspectZip(body: Buffer, visit: (member: MemberType) => void): void {
  ok(body.length >= 22);
  let end = body.length - 22;
  while (end >= Math.max(0, body.length - 65557) && body.readUInt32LE(end) !== 0x06054b50) end--;
  ok(end >= Math.max(0, body.length - 65557), "ZIP end record missing.");
  equal(end + 22 + body.readUInt16LE(end + 20), body.length);
  equal(body.readUInt16LE(end + 4), 0);
  equal(body.readUInt16LE(end + 6), 0);
  const count = body.readUInt16LE(end + 10), start = body.readUInt32LE(end + 16);
  equal(body.readUInt16LE(end + 8), count);
  ok(count < 10000 && start < end);
  equal(start + body.readUInt32LE(end + 12), end);
  const names = new Set<string>(), ranges: [number, number][] = [];
  let at = start, expanded = 0;
  for (let index = 0; index < count; index++) {
    ok(at + 46 <= end);
    equal(body.readUInt32LE(at), 0x02014b50);
    const flags = body.readUInt16LE(at + 8), method = body.readUInt16LE(at + 10);
    const checksum = body.readUInt32LE(at + 16),
      stored = body.readUInt32LE(at + 20),
      bytes = body.readUInt32LE(at + 24);
    const nameBytes = body.readUInt16LE(at + 28),
      extra = body.readUInt16LE(at + 30),
      comment = body.readUInt16LE(at + 32);
    const next = at + 46 + nameBytes + extra + comment;
    ok(next <= end && bytes <= 128 * MIB && stored !== 0xffffffff && bytes !== 0xffffffff);
    equal(body.readUInt16LE(at + 34), 0);
    ok((flags & ~0x808) === 0 && (method === 0 || method === 8));
    const rawName = body.subarray(at + 46, at + 46 + nameBytes);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(rawName);
    const canonical = name.endsWith("/") ? name.slice(0, -1) : name;
    ok(canonical.length > 0 && !name.includes("\\") && !name.includes("\0") && !posix.isAbsolute(name));
    equal(posix.normalize(canonical), canonical);
    ok(!canonical.split("/").includes("..") && !names.has(canonical));
    ok(!name.toLowerCase().endsWith(".pth"));
    names.add(canonical);
    const mode = body.readUInt32LE(at + 38) >>> 16, kind = mode & 0xf000;
    ok([0, 0x4000, 0x8000].includes(kind) && !(mode & 0xc00));
    if (kind === 0x4000) ok(name.endsWith("/"));
    if (kind === 0x8000) ok(!name.endsWith("/"));
    const local = body.readUInt32LE(at + 42);
    ok(local + 30 <= start);
    equal(body.readUInt32LE(local), 0x04034b50);
    equal(body.readUInt16LE(local + 6), flags);
    equal(body.readUInt16LE(local + 8), method);
    equal(body.readUInt16LE(local + 26), nameBytes);
    ok(body.subarray(local + 30, local + 30 + nameBytes).equals(rawName));
    const payload = local + 30 + nameBytes + body.readUInt16LE(local + 28);
    ok(payload + stored <= start);
    let rangeEnd = payload + stored;
    if (flags & 8) {
      let descriptor = rangeEnd;
      if (body.readUInt32LE(descriptor) === 0x08074b50) descriptor += 4;
      ok(descriptor + 12 <= start);
      equal(body.readUInt32LE(descriptor), checksum);
      equal(body.readUInt32LE(descriptor + 4), stored);
      equal(body.readUInt32LE(descriptor + 8), bytes);
      rangeEnd = descriptor + 12;
    } else {
      equal(body.readUInt32LE(local + 14), checksum);
      equal(body.readUInt32LE(local + 18), stored);
      equal(body.readUInt32LE(local + 22), bytes);
    }
    ranges.push([local, rangeEnd]);
    expanded += bytes;
    ok(expanded <= 512 * MIB);
    const packed = body.subarray(payload, payload + stored);
    const decoded = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, bytes) });
    equal(decoded.length, bytes);
    equal(crc(decoded), checksum);
    visit({ name, body: decoded, sha256: sha(decoded) });
    at = next;
  }
  equal(at, end);
  ranges.sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < ranges.length; index++) {
    ok(ranges[index - 1]![1] <= ranges[index]![0], "ZIP member ranges overlap.");
  }
}
