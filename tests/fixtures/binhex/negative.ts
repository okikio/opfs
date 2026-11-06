/** Authored wire mutations require CRC-specific native C refusal after full-byte baseline acceptance. */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const CAP = 2 * 1024 * 1024;
const alphabet = "!\"#$%&'()*+,-012345689@ABCDEFGHIJKLMNPQRSTUVXYZ[`abcdefhijklmpqr";
interface ReceiptType {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
interface ControlType {
  readonly name: string;
  readonly offset: number;
  readonly base64: string;
  readonly sha256: string;
  readonly native: ReceiptType;
}
const { values: args } = parseArgs({
  options: {
    fixture: { type: "string" },
    output: { type: "string" },
    hexbin: { type: "string", default: "/usr/bin/hexbin" },
    prlimit: { type: "string", default: "/usr/bin/prlimit" },
  },
});
if (args.fixture === undefined || args.output === undefined) {
  throw new TypeError("--fixture and a new --output destination are required.");
}

/** Rejects links and oversized files before materializing input or native forks. */
function read(path: string): Buffer {
  const info = lstatSync(path);
  ok(info.isFile() && info.size <= CAP, "Input and native fork files must be regular files within 2 MiB.");
  return readFileSync(path);
}
function object(value: unknown): Record<string, unknown> {
  ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function bytes(value: unknown): Buffer {
  const record = object(value);
  ok(typeof record.base64 === "string" && record.base64.length <= CAP * 2);
  ok(
    typeof record.bytes === "number" && Number.isSafeInteger(record.bytes) && record.bytes >= 0 && record.bytes <= CAP,
  );
  const body = Buffer.from(record.base64, "base64");
  equal(body.toString("base64"), record.base64);
  equal(body.length, record.bytes);
  equal(createHash("sha256").update(body).digest("hex"), record.sha256);
  return body;
}

const original = read(resolve(args.fixture));
const input = object(JSON.parse(original.toString()) as unknown);
ok(Array.isArray(input.fixtures) && input.fixtures.length <= 64);
const matches = input.fixtures.map(object).filter((value) => value.case === "forks" && value.producer === "macutils");
equal(matches.length, 1);
const fixture = matches[0]!;
equal(fixture.name, "forks.bin");
const data = bytes(fixture.data), resource = bytes(fixture.resource), wire = bytes(fixture.archive);

/** Decodes this known genuine input only; no candidate decoder supplies mutations. */
function unpack(wire: Buffer): Buffer {
  const first = wire.indexOf(0x3a), last = wire.indexOf(0x3a, first + 1);
  ok(first >= 0 && last > first);
  const packed: number[] = [];
  let bits = 0, count = 0;
  for (const byte of wire.subarray(first + 1, last)) {
    if (byte === 10 || byte === 13) continue;
    const sextet = alphabet.indexOf(String.fromCharCode(byte));
    ok(sextet >= 0);
    bits = (bits << 6) | sextet;
    count += 6;
    if (count >= 8) {
      count -= 8;
      packed.push(bits >>> count);
      bits &= (1 << count) - 1;
    }
  }
  const raw: number[] = [];
  for (let at = 0; at < packed.length;) {
    const value = packed[at++]!;
    if (value !== 0x90) raw.push(value);
    else {
      ok(at < packed.length);
      const repeat = packed[at++]!;
      if (repeat === 0) raw.push(0x90);
      else {
        ok(raw.length > 0 && raw.length + repeat - 1 <= CAP);
        const previous = raw[raw.length - 1]!;
        for (let n = 1; n < repeat; n++) raw.push(previous);
      }
    }
    ok(raw.length <= CAP);
  }
  return Buffer.from(raw);
}

/** Literal marker escaping and sextet grouping deliberately omit RLE run compression. */
function encode(value: Buffer): Buffer {
  const packed: number[] = [];
  for (const byte of value) {
    packed.push(byte);
    if (byte === 0x90) packed.push(0);
  }
  let body = ":";
  for (let at = 0; at < packed.length; at += 3) {
    const size = Math.min(3, packed.length - at);
    const number = (packed[at]! << 16) | ((packed[at + 1] ?? 0) << 8) | (packed[at + 2] ?? 0);
    const shifts = [18, 12, 6, 0];
    for (let n = 0; n < Math.ceil(size * 8 / 6); n++) body += alphabet[(number >>> shifts[n]!) & 63];
  }
  body += ":";
  const lines: string[] = [];
  for (let at = 0; at < body.length; at += 64) lines.push(body.slice(at, at + 64));
  return Buffer.from(`(This file must be converted with BinHex 4.0)\n\n${lines.join("\n")}\n`, "ascii");
}

const raw = unpack(wire);
ok(raw.length > 0);
const headerSize = raw[0]! + 20;
equal(raw.length, headerSize + 6 + data.length + resource.length);
const commands: ReceiptType[] = [];
/** Native checksum refusal must remain distinguishable from deadline or setup failure. */
function decode(path: string, cwd: string): ReceiptType {
  const child = spawnSync(args.prlimit, [`--fsize=${CAP}:${CAP}`, "--", args.hexbin, "-3", path], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    killSignal: "SIGKILL",
    maxBuffer: CAP,
  });
  if (child.error !== undefined || child.status === null || child.signal !== null) {
    throw new Error(JSON.stringify({ error: child.error?.message, signal: child.signal }));
  }
  const receipt = { code: child.status, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
  commands.push(receipt);
  return receipt;
}
const root = mkdtempSync(join(tmpdir(), "opfs-binhex-negative-"));
try {
  const baseline = join(root, "baseline.hqx"), target = join(root, "baseline");
  writeFileSync(baseline, encode(raw));
  mkdirSync(target);
  equal(decode(baseline, target).code, 0);
  deepStrictEqual(readdirSync(target).sort(), ["forks.bin.info", "forks.bin.data", "forks.bin.rsrc"].sort());
  deepStrictEqual(read(join(target, "forks.bin.data")), data);
  deepStrictEqual(read(join(target, "forks.bin.rsrc")), resource);
  const positions: readonly (readonly [string, number])[] = [
    ["header-type", raw[0]! + 2],
    ["header-crc", headerSize + 1],
    ["data-byte", headerSize + 2],
    ["data-crc", headerSize + 3 + data.length],
    ["resource-byte", headerSize + 4 + data.length],
    ["resource-crc", raw.length - 1],
  ];
  const controls: ControlType[] = [];
  for (const [name, offset] of positions) {
    ok(offset >= 0 && offset < raw.length);
    const changed = Buffer.from(raw);
    changed[offset] = changed[offset]! ^ 1;
    const encoded = encode(changed), path = join(root, `${name}.hqx`), output = join(root, name);
    writeFileSync(path, encoded);
    mkdirSync(output);
    const receipt = decode(path, output);
    ok(receipt.code !== 0 && /crc|checksum/iu.test(receipt.stderr), JSON.stringify({ name, receipt }));
    controls.push({
      name,
      offset,
      base64: encoded.toString("base64"),
      sha256: createHash("sha256").update(encoded).digest("hex"),
      native: receipt,
    });
  }
  const result = {
    kind: "authored wire mutations, not genuine producer outputs",
    inputSHA256: createHash("sha256").update(original).digest("hex"),
    scriptSHA256: createHash("sha256").update(read(fileURLToPath(import.meta.url))).digest("hex"),
    limits: { fileBytes: CAP, stdoutBytes: CAP, deadlineMs: 60_000, wrapper: args.prlimit },
    controls,
    commands,
  };
  writeFileSync(resolve(args.output), `${JSON.stringify(result)}\n`, { flag: "wx" });
} finally {
  rmSync(root, { recursive: true, force: true });
}
