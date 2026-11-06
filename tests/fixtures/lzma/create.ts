/** Native XZ Utils and 7-Zip raw codecs, independently full-byte cross-consumed. No candidate code is imported. */
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command, crc32, encoded, equal, options, producer, publish, randomBytes } from "../codec.ts";

const args = options(["output", "seven", "xz"]);
const seven = args.seven ?? "7zz", xz = args.xz ?? "xz";
const u32 = (value: number): Buffer<ArrayBuffer> => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};
function vli(value: number): Buffer<ArrayBuffer> {
  const bytes: number[] = [];
  while (value >= 128) {
    bytes.push((value % 128) | 128);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return Buffer.from(bytes);
}

/** Authored XZ framing makes genuine raw LZMA2 consumable by a separately implemented native decoder. */
function frame(raw: Buffer, body: Buffer): Buffer<ArrayBuffer> {
  const flags = Buffer.from([0, 1]);
  const header = Buffer.concat([Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0]), flags, u32(crc32(flags))]);
  const blockPrefix = Buffer.from([2, 0, 0x21, 1, 8, 0, 0, 0]);
  const block = Buffer.concat([blockPrefix, u32(crc32(blockPrefix))]);
  const data = Buffer.concat([block, raw, Buffer.alloc((4 - raw.length % 4) % 4), u32(crc32(body))]);
  const indexPrefix = Buffer.concat([Buffer.from([0, 1]), vli(block.length + raw.length + 4), vli(body.length)]);
  const indexBody = Buffer.concat([indexPrefix, Buffer.alloc((4 - indexPrefix.length % 4) % 4)]);
  const index = Buffer.concat([indexBody, u32(crc32(indexBody))]);
  const footer = Buffer.concat([u32(index.length / 4 - 1), flags]);
  return Buffer.concat([header, data, index, u32(crc32(footer)), footer, Buffer.from("YZ")]);
}

/** Record native reset controls without using the candidate's state machine. */
function controls(raw: Buffer): readonly Record<string, number>[] {
  let at = 0;
  const result: Record<string, number>[] = [];
  while (at < raw.length) {
    const start = at, control = raw[at++]!;
    if (control === 0) {
      if (at !== raw.length) throw new Error("Unexpected native LZMA2 trailer.");
      result.push({ offset: start, control });
      return result;
    }
    if (control === 1 || control === 2) {
      const size = raw.readUInt16BE(at) + 1;
      at += 2 + size;
      result.push({ offset: start, control, unpacked: size });
    } else {
      if (control < 128) throw new Error("Invalid native LZMA2 control.");
      const unpacked = ((control & 31) << 16) + raw.readUInt16BE(at) + 1, packed = raw.readUInt16BE(at + 2) + 1;
      at += 4 + (control >= 192 ? 1 : 0) + packed;
      result.push({ offset: start, control, packed, unpacked });
    }
    if (at > raw.length) throw new Error("Native LZMA2 chunk exceeds input.");
  }
  throw new Error("Missing native LZMA2 terminator.");
}

const period = randomBytes(65000, 42129);
const bodies: Record<string, Buffer> = {
  empty: Buffer.alloc(0),
  literal: Buffer.from("Independent native LZMA payload\0\xff", "latin1"),
  overlap: Buffer.alloc(9000, 97),
  wrap: Buffer.concat([period, period, period, period.subarray(0, 117)]),
};
const root = mkdtempSync(join(tmpdir(), "opfs-lzma-ts-"));
const cases: unknown[] = [];
function store(
  name: string,
  raw: Buffer,
  body: Buffer,
  profile: string,
  origin: string,
  extra: Readonly<Record<string, unknown>> = {},
): void {
  cases.push({
    name,
    packed: raw.toString("base64"),
    body: body.toString("base64"),
    sha256: encoded(raw).sha256,
    profile,
    origin,
    ...extra,
  });
}
function checkRaw2(name: string, raw: Buffer, body: Buffer, origin: string): void {
  const wrapper = frame(raw, body), path = join(root, name + ".xz");
  writeFileSync(path, wrapper);
  equal(command(seven, ["x", "-so", path]), body, name + " 7-Zip");
  equal(command(xz, ["--format=raw", "--lzma2=dict=64KiB", "-dc"], raw), body, name + " xz raw");
  store(name, raw, body, "raw-lzma2", origin, {
    dictionary: 8,
    controls: controls(raw),
    consumerFrameSha256: encoded(wrapper).sha256,
  });
}
try {
  for (const [name, body] of Object.entries(bodies)) {
    const alone = command(xz, ["-T1", "--format=lzma", "--lzma1=dict=64KiB", "-c"], body),
      path = join(root, name + ".lzma");
    writeFileSync(path, alone);
    equal(command(seven, ["x", "-so", path]), body, name + " Alone");
    store("alone-" + name, alone, body, "alone", "Genuine XZ Utils .lzma; independent 7-Zip full-byte consumer");
    const raw = command(xz, ["-T1", "--format=raw", "--lzma2=dict=64KiB", "-c"], body);
    checkRaw2("lzma2-" + name, raw, body, "Genuine XZ Utils raw LZMA2; independent 7-Zip through authored XZ wrapper");
  }
  for (
    const [name, body] of Object.entries({
      continuation: Buffer.from("abcd".repeat(600000)),
      mixed: Buffer.concat([Buffer.alloc(1048576, 97), randomBytes(200000, 42130), Buffer.alloc(1048576, 98)]),
    })
  ) {
    checkRaw2(
      "lzma2-" + name,
      command(xz, ["-T1", "--format=raw", "--lzma2=dict=64KiB", "-c"], body),
      body,
      "Genuine XZ Utils raw LZMA2; independent 7-Zip through authored XZ wrapper",
    );
  }
  const repeated = bodies.overlap!,
    original = command(xz, ["-T1", "--format=raw", "--lzma2=dict=64KiB", "-c"], repeated);
  const first = original.subarray(0, -1);
  if (first[0] !== 224) throw new Error("Expected single fresh native overlap chunk.");
  const zeros = Buffer.from([2, 0, 3, 0, 0, 0, 0]);
  const stateOnly = Buffer.concat([Buffer.from([160]), first.subarray(1, 5), first.subarray(6)]);
  const propertiesOnly = Buffer.concat([Buffer.from([192]), first.subarray(1)]);
  checkRaw2(
    "lzma2-reset-composition",
    Buffer.concat([first, zeros, stateOnly, zeros, propertiesOnly, Buffer.from([0])]),
    Buffer.concat([repeated, Buffer.alloc(4), repeated, Buffer.alloc(4), repeated]),
    "Authored control/header composition over genuine XZ packed chunks; 7-Zip and native xz full-byte consumers",
  );
  const body = Buffer.from("Context states and positions. ".repeat(13));
  for (let lc = 0; lc < 5; lc++) {
    for (let lp = 0; lp < 5 - lc; lp++) {
      for (let pb = 0; pb < 5; pb++) {
        const raw = command(xz, ["-T1", "--format=raw", `--lzma1=dict=64KiB,lc=${lc},lp=${lp},pb=${pb}`, "-c"], body);
        const properties = Buffer.concat([Buffer.from([(pb * 5 + lp) * 9 + lc]), u32(65536)]), size = Buffer.alloc(8);
        size.writeBigUInt64LE(BigInt(body.length));
        const path = join(root, "properties.lzma");
        writeFileSync(path, Buffer.concat([properties, size, raw]));
        equal(command(seven, ["x", "-so", path]), body, `properties-${lc}-${lp}-${pb}`);
        store(
          `properties-${lc}-${lp}-${pb}`,
          raw,
          body,
          "raw-lzma1",
          "Genuine XZ raw LZMA1; authored known-size Alone wrapper accepted by 7-Zip",
          { properties: [...properties], size: body.length, marker: "required" },
        );
      }
    }
  }
  for (const method of ["LZMA", "LZMA2"]) {
    const body = bodies.wrap!, input = join(root, "native.bin"), path = join(root, method + ".7z");
    writeFileSync(input, body);
    command(seven, ["a", "-t7z", `-m0=${method}:d64k`, "-mmt=off", "-ms=off", "-mhc=off", path, input]);
    const wire = readFileSync(path), headerValue = wire.readBigUInt64LE(12);
    if (headerValue > BigInt(wire.length - 32)) throw new Error("Native 7z header exceeds archive.");
    const header = 32 + Number(headerValue);
    if (wire[header] !== 1) throw new Error("Native archive header is encoded.");
    const raw = wire.subarray(32, header);
    if (method === "LZMA") {
      const properties = Buffer.concat([Buffer.from([0x5d]), u32(65536)]), size = Buffer.alloc(8);
      size.writeBigUInt64LE(BigInt(body.length));
      equal(
        command(xz, ["--format=lzma", "-dc"], Buffer.concat([properties, size, raw])),
        body,
        "7-Zip LZMA1 via native xz",
      );
      store(
        "7zip-lzma1",
        raw,
        body,
        "raw-lzma1",
        "Genuine single-file 7-Zip packed extent; native xz known-size Alone consumer",
        { properties: [...properties], size: body.length, marker: "optional" },
      );
    } else {
      equal(command(xz, ["--format=raw", "--lzma2=dict=64KiB", "-dc"], raw), body, "7-Zip LZMA2 via native xz");
      store("7zip-lzma2", raw, body, "raw-lzma2", "Genuine single-file 7-Zip packed extent; native xz raw consumer", {
        dictionary: 8,
        size: body.length,
        controls: controls(raw),
      });
    }
  }
  publish(args.output!, {
    ...producer(import.meta.url),
    tools: { "7zip": command(seven, ["i"]).toString("utf8"), xz: command(xz, ["--version"]).toString("utf8") },
    randomRecipe: "xorshift32 low byte; seeds42129/42130; differs from historical Python MT",
    cases,
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}
