/**
 * Produces genuine WinZip AES fixtures and independent libarchive/OpenSSL checks.
 *
 * AE-1 and version-needed controls change authored metadata only; ciphertext
 * remains native 7-Zip output. No candidate archive or cryptography code runs.
 */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { inflateRawSync } from "node:zlib";

/** Locations in a small native WinZip-AES image, used only for authored controls. */
interface EntryType {
  readonly name: string;
  readonly central: number;
  readonly local: number;
  readonly centralAes: number;
  readonly localAes: number;
  readonly strength: 128 | 192 | 256;
  readonly method: number;
  readonly version: number;
  readonly crc: number;
  readonly salt: Buffer;
  readonly verifier: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
}

/** Complete native evidence for one accepted profile. */
interface FixtureType {
  readonly producer: string[];
  readonly consumer: string;
  readonly cryptoConsumer: string;
  readonly origin: string;
  readonly command: readonly string[];
  readonly independentPayloadVerified: true;
  readonly password: string;
  readonly sha256: string;
  readonly archive: string;
  readonly entries: readonly { name: string; body: string }[];
}

/** Native commands have finite input/output/work budgets and never use a shell. */
function run(command: readonly string[], cwd?: string, input?: Uint8Array): Buffer {
  const child = spawnSync(command[0]!, command.slice(1), {
    cwd,
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout: 30_000,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
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

/** Checks the native archive budget before materializing its bytes. */
function readArchive(path: string): Buffer {
  ok(statSync(path).size <= 1024 * 1024, "Native AES archive exceeds the 1 MiB fixture budget.");
  return readFileSync(path);
}

/** Admits an authored framing read before any Buffer field access. */
function extent(data: Buffer, at: number, size: number): void {
  ok(
    Number.isSafeInteger(at) && Number.isSafeInteger(size) && at >= 0 && size >= 0 && at <= data.length &&
      size <= data.length - at,
    "AES fixture field exceeds the native image.",
  );
}

/** Finds exactly one AES extra field within an already admitted extra region. */
function aesExtra(data: Buffer, at: number, size: number): number {
  extent(data, at, size);
  const end = at + size;
  let found: number | undefined;
  while (at < end) {
    ok(at + 4 <= end);
    const tag = data.readUInt16LE(at);
    const length = data.readUInt16LE(at + 2);
    ok(at + 4 + length <= end);
    if (tag === 0x9901) {
      equal(length, 7);
      equal(found, undefined, "Native image contains duplicate AES fields.");
      found = at;
    }
    at += 4 + length;
  }
  ok(found !== undefined, "Native member has no AES metadata.");
  return found;
}

/**
 * Interprets only the small single-disk, non-ZIP64 native workload.
 * This authored locator is not the independently supplied ZIP acceptance oracle.
 */
function entries(data: Buffer): EntryType[] {
  ok(data.length >= 22 && data.length <= 1024 * 1024);
  const end = data.length - 22;
  equal(data.readUInt32LE(end), 0x06054b50);
  equal(data.readUInt16LE(end + 4), 0);
  equal(data.readUInt16LE(end + 6), 0);
  equal(data.readUInt16LE(end + 20), 0);
  const count = data.readUInt16LE(end + 10);
  equal(data.readUInt16LE(end + 8), count);
  ok(count > 0 && count <= 16);
  let at = data.readUInt32LE(end + 16);
  equal(at + data.readUInt32LE(end + 12), end);
  const result: EntryType[] = [];
  for (let index = 0; index < count; index++) {
    extent(data, at, 46);
    equal(data.readUInt32LE(at), 0x02014b50);
    equal(data.readUInt16LE(at + 10), 99);
    ok((data.readUInt16LE(at + 8) & 1) !== 0);
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    extent(data, at + 46, nameLength + extraLength + commentLength);
    const nameBytes = data.subarray(at + 46, at + 46 + nameLength);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
    ok(!result.some((entry) => entry.name === name), "Native member names must be unique.");
    const centralAes = aesExtra(data, at + 46 + nameLength, extraLength);
    equal(data.subarray(centralAes + 6, centralAes + 8).toString("ascii"), "AE");
    const version = data.readUInt16LE(centralAes + 4);
    ok(version === 1 || version === 2);
    const strengthCode = data[centralAes + 8];
    const strength = strengthCode === 1 ? 128 : strengthCode === 2 ? 192 : strengthCode === 3 ? 256 : undefined;
    ok(strength !== undefined, "Native member has an unsupported AES strength.");
    const method = data.readUInt16LE(centralAes + 9);
    ok(method === 0 || method === 8);
    const local = data.readUInt32LE(at + 42);
    extent(data, local, 30);
    equal(data.readUInt32LE(local), 0x04034b50);
    equal(data.readUInt16LE(local + 8), 99);
    const localName = data.readUInt16LE(local + 26);
    const localExtraLength = data.readUInt16LE(local + 28);
    extent(data, local + 30, localName + localExtraLength);
    deepStrictEqual(data.subarray(local + 30, local + 30 + localName), nameBytes);
    const localAes = aesExtra(data, local + 30 + localName, localExtraLength);
    deepStrictEqual(data.subarray(localAes + 4, localAes + 11), data.subarray(centralAes + 4, centralAes + 11));
    const payloadAt = local + 30 + localName + localExtraLength;
    const compressedSize = data.readUInt32LE(at + 20);
    const saltLength = strength / 16;
    ok(compressedSize >= saltLength + 12);
    extent(data, payloadAt, compressedSize);
    ok(payloadAt + compressedSize <= data.readUInt32LE(end + 16));
    result.push({
      name,
      central: at,
      local,
      centralAes,
      localAes,
      strength,
      method,
      version,
      crc: data.readUInt32LE(at + 16),
      salt: data.subarray(payloadAt, payloadAt + saltLength),
      verifier: data.subarray(payloadAt + saltLength, payloadAt + saltLength + 2),
      ciphertext: data.subarray(payloadAt + saltLength + 2, payloadAt + compressedSize - 10),
      tag: data.subarray(payloadAt + compressedSize - 10, payloadAt + compressedSize),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  equal(at, end);
  return result;
}

/** CRC32 supplies plaintext metadata for explicit AE-1 adaptations only. */
function crc32(body: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Copies native output before changing AE version, CRC or ordinary version-needed fields. */
function adapt(original: Buffer, bodies: Readonly<Record<string, Buffer>>, version: number, needed?: number): Buffer {
  const data = Buffer.from(original);
  for (const entry of entries(data)) {
    if (needed !== undefined) {
      data.writeUInt16LE(needed, entry.central + 6);
      data.writeUInt16LE(needed, entry.local + 4);
    }
    if (version === 1) {
      const body = bodies[entry.name];
      ok(body !== undefined, "Adaptation has no original plaintext oracle.");
      const crc = crc32(body);
      data.writeUInt32LE(crc, entry.central + 16);
      data.writeUInt32LE(crc, entry.local + 14);
      data.writeUInt16LE(1, entry.centralAes + 4);
      data.writeUInt16LE(1, entry.localAes + 4);
    }
  }
  const before = entries(original);
  for (const [index, entry] of entries(data).entries()) {
    deepStrictEqual(entry.ciphertext, before[index]!.ciphertext);
    deepStrictEqual(entry.tag, before[index]!.tag);
  }
  return data;
}

const { values: args } = parseArgs({
  options: {
    seven: { type: "string", default: "7zz" },
    bsdtar: { type: "string", default: "bsdtar" },
    openssl: { type: "string", default: "openssl" },
    output: { type: "string" },
  },
});
if (args.output === undefined) throw new TypeError("--output requires a separate fixture destination.");
const password = "fixture-password";
const producer = run([args.seven]).toString().split(/\r?\n/u).slice(0, 5);
const consumer = run([args.bsdtar, "--version"]).toString().trim();
const cryptoConsumer = run([args.openssl, "version"]).toString().trim();
equal(crc32(Buffer.from("123456789")), 0xcbf43926);

/**
 * OpenSSL supplies PBKDF2, HMAC and AES block encryption; this authored glue
 * constructs WinZip's little-endian counters and compares full original bytes.
 */
function cryptoCheck(data: Buffer, bodies: Readonly<Record<string, Buffer>>): void {
  for (const entry of entries(data)) {
    const keyLength = entry.strength / 8;
    const keys = run([
      args.openssl,
      "kdf",
      "-binary",
      "-keylen",
      String(keyLength * 2 + 2),
      "-kdfopt",
      "digest:SHA1",
      "-kdfopt",
      `pass:${password}`,
      "-kdfopt",
      `hexsalt:${entry.salt.toString("hex")}`,
      "-kdfopt",
      "iter:1000",
      "PBKDF2",
    ]);
    equal(keys.length, keyLength * 2 + 2);
    deepStrictEqual(keys.subarray(keyLength * 2), entry.verifier);
    const digest = run(
      [
        args.openssl,
        "dgst",
        "-sha1",
        "-mac",
        "HMAC",
        "-macopt",
        `hexkey:${keys.subarray(keyLength, keyLength * 2).toString("hex")}`,
        "-binary",
      ],
      undefined,
      entry.ciphertext,
    );
    equal(digest.length, 20);
    deepStrictEqual(digest.subarray(0, 10), entry.tag, `${entry.name}: OpenSSL authentication differs.`);
    const counters = Buffer.alloc(Math.ceil(entry.ciphertext.length / 16) * 16);
    for (let offset = 0; offset < counters.length; offset += 16) counters.writeUInt32LE(offset / 16 + 1, offset);
    const stream = counters.length === 0 ? Buffer.alloc(0) : run(
      [
        args.openssl,
        "enc",
        `-aes-${entry.strength}-ecb`,
        "-e",
        "-K",
        keys.subarray(0, keyLength).toString("hex"),
        "-nopad",
        "-nosalt",
      ],
      undefined,
      counters,
    );
    equal(stream.length, counters.length);
    const compressed = Buffer.alloc(entry.ciphertext.length);
    for (let offset = 0; offset < compressed.length; offset++) {
      compressed[offset] = entry.ciphertext[offset]! ^ stream[offset]!;
    }
    const plain = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: 64 * 1024 });
    const expected = bodies[entry.name];
    ok(expected !== undefined);
    deepStrictEqual(plain, expected, `${entry.name}: OpenSSL-derived original plaintext differs.`);
    if (entry.version === 1) equal(crc32(plain), entry.crc);
  }
}

/** Native ZIP acceptance stays separate from authored envelope/OpenSSL checks. */
function qualify(
  root: string,
  key: string,
  data: Buffer,
  originals: Readonly<Record<string, Buffer>>,
  origin: string,
  command: readonly string[],
): FixtureType {
  const archive = join(root, `${key}.zip`);
  writeFileSync(archive, data);
  const destination = join(root, `out-${key}`);
  mkdirSync(destination);
  run([args.bsdtar, "--passphrase", password, "-xf", archive, "-C", destination]);
  for (const [name, body] of Object.entries(originals)) {
    deepStrictEqual(readFileSync(join(destination, name)), body, `${key}: libarchive payload differs: ${name}`);
  }
  cryptoCheck(data, originals);
  return {
    producer,
    consumer,
    cryptoConsumer,
    command,
    origin,
    independentPayloadVerified: true,
    password: Buffer.from(password).toString("base64"),
    sha256: createHash("sha256").update(data).digest("hex"),
    archive: data.toString("base64"),
    entries: Object.entries(originals).map(([name, body]) => ({ name, body: body.toString("base64") })),
  };
}

const root = mkdtempSync(join(tmpdir(), "opfs-aes-"));
try {
  const bodies: Record<string, Buffer> = {
    "first.bin": Buffer.from(Array.from({ length: 73 }, (_, at) => at)),
    "large.bin": Buffer.from(Array.from({ length: 8197 }, (_, at) => (at * 31 + 17) % 251)),
    "odd.bin": Buffer.concat([Buffer.from("odd binary\0"), Buffer.from([255]), Buffer.from("payload")]),
    empty: Buffer.alloc(0),
  };
  for (const [name, body] of Object.entries(bodies)) writeFileSync(join(root, name), body);
  const result: Record<string, FixtureType> = {};
  for (const strength of [128, 192, 256]) {
    const archive = join(root, `native-aes${strength}.zip`);
    const command = [
      args.seven,
      "a",
      "-tzip",
      "-mm=Copy",
      `-mem=AES${strength}`,
      `-p${password}`,
      archive,
      ...Object.keys(bodies),
    ];
    run(command, root);
    const original = readArchive(archive);
    ok(
      entries(original).every((entry) => entry.version === 2),
      "Native writer did not emit the labelled AE-2 profile.",
    );
    result[`aes${strength}-ae2`] = qualify(root, `aes${strength}-ae2`, original, bodies, "genuine 7-Zip AE-2", command);
    result[`aes${strength}-ae1`] = qualify(
      root,
      `aes${strength}-ae1`,
      adapt(original, bodies, 1),
      bodies,
      "AE-1 metadata/CRC adaptation over genuine 7-Zip ciphertext",
      command,
    );
  }
  const archive = join(root, "native-deflate.zip");
  const command = [args.seven, "a", "-tzip", "-mm=Deflate", "-mem=AES256", `-p${password}`, archive, "large.bin"];
  run(command, root);
  result.deflate = qualify(
    root,
    "deflate",
    readArchive(archive),
    { "large.bin": bodies["large.bin"]! },
    "genuine 7-Zip AES DEFLATE",
    command,
  );
  for (
    const [key, baseKey, version, needed] of [["stored-needed10", "aes256-ae2", 2, 10], [
      "deflate-needed20",
      "deflate",
      2,
      20,
    ], ["deflate-ae1", "deflate", 1, 20]] as const
  ) {
    const fixture = result[baseKey]!;
    const originals = Object.fromEntries(
      fixture.entries.map((entry) => [entry.name, Buffer.from(entry.body, "base64")]),
    );
    result[key] = qualify(
      root,
      key,
      adapt(Buffer.from(fixture.archive, "base64"), originals, version, needed),
      originals,
      "Version-needed/AE-version/CRC metadata adaptation over genuine 7-Zip ciphertext",
      fixture.command,
    );
  }
  writeFileSync(resolve(args.output), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
} finally {
  rmSync(root, { recursive: true, force: true });
}
