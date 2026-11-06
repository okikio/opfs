/**
 * Consumes the small authored ZIP workload with native 7-Zip and separate wire checks.
 *
 * No project ZIP reader participates. The native parser tests integrity and
 * extracts full payloads; the authored checks inspect the expected framing only.
 */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { parseArgs } from "node:util";

/** Reads no more than the admitted 1 MiB archive into one owned byte image. */
async function archiveInput(): Promise<Buffer> {
  const output = Buffer.alloc(1024 * 1024);
  let size = 0;
  for await (const value of stdin) {
    const chunk: unknown = value;
    if (!Buffer.isBuffer(chunk)) throw new TypeError("ZIP input must be an undecoded binary stream.");
    if (chunk.length > output.length - size) throw new Error("ZIP fixture exceeds the 1 MiB input budget.");
    chunk.copy(output, size);
    size += chunk.length;
  }
  return output.subarray(0, size);
}

/** The bitwise recurrence is authored independently of the candidate writer. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Refuses an extent before reading a framing field from it. */
function extent(bytes: Buffer, offset: number, length: number): void {
  ok(
    Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 &&
      offset <= bytes.length && length <= bytes.length - offset,
    "ZIP field exceeds the admitted image.",
  );
}

/**
 * Checks this workload's STORED/UTF-8/descriptor profile, not the full ZIP grammar.
 * Native 7-Zip separately owns independent format acceptance and payload checks.
 */
function framing(bytes: Buffer, expected: Readonly<Record<string, Buffer>>): void {
  equal(crc32(Buffer.from("123456789")), 0xcbf43926, "Independent CRC32 vector failed.");
  const end = bytes.length - 22;
  extent(bytes, end, 22);
  equal(bytes.readUInt32LE(end), 0x06054b50);
  equal(bytes.readUInt16LE(end + 4), 0);
  equal(bytes.readUInt16LE(end + 6), 0);
  equal(bytes.readUInt16LE(end + 8), Object.keys(expected).length);
  equal(bytes.readUInt16LE(end + 10), Object.keys(expected).length);
  equal(bytes.readUInt16LE(end + 20), 0);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryAt = bytes.readUInt32LE(end + 16);
  equal(directoryAt + directorySize, end);
  let central = directoryAt;
  let local = 0;
  const names: string[] = [];
  for (const [name, body] of Object.entries(expected)) {
    extent(bytes, central, 46);
    equal(bytes.readUInt32LE(central), 0x02014b50);
    equal(bytes.readUInt16LE(central + 8), 0x0808);
    equal(bytes.readUInt16LE(central + 10), 0);
    equal(bytes.readUInt16LE(central + 12), 0);
    equal(bytes.readUInt16LE(central + 14), 0x21);
    equal(bytes.readUInt32LE(central + 16), crc32(body));
    equal(bytes.readUInt32LE(central + 20), body.length);
    equal(bytes.readUInt32LE(central + 24), body.length);
    const nameLength = bytes.readUInt16LE(central + 28);
    const extraLength = bytes.readUInt16LE(central + 30);
    const commentLength = bytes.readUInt16LE(central + 32);
    equal(bytes.readUInt16LE(central + 34), 0);
    equal(bytes.readUInt32LE(central + 42), local);
    extent(bytes, central + 46, nameLength + extraLength + commentLength);
    const encodedName = bytes.subarray(central + 46, central + 46 + nameLength);
    equal(new TextDecoder("utf-8", { fatal: true }).decode(encodedName), name);
    names.push(name);
    extent(bytes, local, 30);
    equal(bytes.readUInt32LE(local), 0x04034b50);
    equal(bytes.readUInt16LE(local + 6), 0x0808);
    equal(bytes.readUInt16LE(local + 8), 0);
    equal(bytes.readUInt16LE(local + 10), 0);
    equal(bytes.readUInt16LE(local + 12), 0x21);
    equal(bytes.readUInt16LE(local + 26), nameLength);
    const localExtra = bytes.readUInt16LE(local + 28);
    extent(bytes, local + 30, nameLength + localExtra + body.length + 16);
    deepStrictEqual(bytes.subarray(local + 30, local + 30 + nameLength), encodedName);
    const payloadAt = local + 30 + nameLength + localExtra;
    deepStrictEqual(bytes.subarray(payloadAt, payloadAt + body.length), body);
    const descriptor = payloadAt + body.length;
    equal(bytes.readUInt32LE(descriptor), 0x08074b50);
    equal(bytes.readUInt32LE(descriptor + 4), crc32(body));
    equal(bytes.readUInt32LE(descriptor + 8), body.length);
    equal(bytes.readUInt32LE(descriptor + 12), body.length);
    local = descriptor + 16;
    central += 46 + nameLength + extraLength + commentLength;
  }
  deepStrictEqual(names, Object.keys(expected));
  equal(local, directoryAt);
  equal(central, end);
}

/** Native parser failures and diagnostic limits cannot become a successful receipt. */
function run(command: readonly string[]): Buffer {
  const child = spawnSync(command[0]!, command.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  if (child.error !== undefined || child.status !== 0) {
    throw new Error(
      JSON.stringify({
        command,
        status: child.status,
        signal: child.signal,
        stdout: child.stdout?.toString(),
        stderr: child.stderr?.toString(),
        error: child.error?.message,
      }),
    );
  }
  return child.stdout;
}

const { values: args } = parseArgs({ options: { seven: { type: "string", default: "7zz" } } });
const archive = await archiveInput();
const expected: Readonly<Record<string, Buffer>> = {
  "folder/": Buffer.alloc(0),
  "folder/é.txt": Buffer.from("first second\n"),
  "empty.txt": Buffer.alloc(0),
  "binary.bin": Buffer.from([0, 255, 1, 128]),
};
framing(archive, expected);
const owned = mkdtempSync(join(tmpdir(), "opfs-zip-verify-"));
let version: string;
try {
  const path = join(owned, "fixture.zip");
  writeFileSync(path, archive, { flag: "wx" });
  version = run([args.seven, "i"]).toString();
  run([args.seven, "t", "-tzip", path]);
  for (const [name, body] of Object.entries(expected)) {
    if (name.endsWith("/")) continue;
    deepStrictEqual(
      run([args.seven, "x", "-tzip", "-so", "-spd", path, name]),
      body,
      `Native ZIP payload differs: ${name}`,
    );
  }
} finally {
  rmSync(owned, { recursive: true, force: true });
}
stdout.write(
  `${
    JSON.stringify({
      consumer: "7-Zip",
      version,
      framing: "authored STORED/UTF-8/descriptor checks",
      entries: Object.keys(expected).length,
      bytes: archive.length,
      sha256: createHash("sha256").update(archive).digest("hex"),
      result: "passed",
    })
  }\n`,
);
