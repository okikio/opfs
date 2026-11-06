/**
 * Released cryptolib reciprocally checks Node primitive-based content and names.
 * Filename SIV is authored RFC5297 glue over Node AES primitives, not a second
 * independently supplied complete SIV implementation. No candidate code runs.
 */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { versions } from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ARTIFACTS } from "./artifacts.ts";

const MIB = 1024 * 1024;
const { values: args } = parseArgs({
  options: {
    artifacts: { type: "string" },
    source: { type: "string", default: fileURLToPath(new URL("Native.java", import.meta.url)) },
    output: { type: "string" },
    java: { type: "string", default: "java" },
    javac: { type: "string", default: "javac" },
    seven: { type: "string", default: "7zz" },
    prlimit: { type: "string", default: "/usr/bin/prlimit" },
  },
});
if (args.artifacts === undefined || args.output === undefined) {
  throw new TypeError("--artifacts and a new --output destination are required.");
}
interface CommandType {
  readonly argv: readonly string[];
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
const commands: CommandType[] = [];
/** Preserves native file/heap/diagnostic limits independently of JS allocation. */
function run(argv: readonly string[], cwd?: string): string {
  const child = spawnSync(args.prlimit, [`--fsize=${8 * MIB}:${8 * MIB}`, "--", ...argv], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    killSignal: "SIGKILL",
    maxBuffer: MIB,
  });
  if (child.error !== undefined || child.status === null || child.signal !== null) {
    throw new Error(JSON.stringify({ argv, error: child.error?.message, signal: child.signal }));
  }
  const receipt = { argv, code: child.status, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
  commands.push(receipt);
  if (child.status !== 0) throw new Error(JSON.stringify(receipt));
  return receipt.stdout;
}
function read(path: string, limit = 8 * MIB): Buffer {
  const info = lstatSync(path);
  ok(info.isFile() && info.size <= limit, "Native fixture input/output exceeds its regular-file budget.");
  return readFileSync(path);
}
function sha(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}
function object(value: unknown): Record<string, unknown> {
  ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

/** GCM returns plaintext only after native final() verifies the complete tag. */
function seal(body: Buffer, key: Buffer, nonce: Buffer, aad?: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  if (aad !== undefined) cipher.setAAD(aad);
  return Buffer.concat([nonce, cipher.update(body), cipher.final(), cipher.getAuthTag()]);
}
function open(body: Buffer, key: Buffer, aad?: Buffer): Buffer {
  ok(body.length >= 28);
  const cipher = createDecipheriv("aes-256-gcm", key, body.subarray(0, 12), { authTagLength: 16 });
  if (aad !== undefined) cipher.setAAD(aad);
  cipher.setAuthTag(body.subarray(-16));
  return Buffer.concat([cipher.update(body.subarray(12, -16)), cipher.final()]);
}
function chunkAad(index: number, nonce: Buffer): Buffer {
  const position = Buffer.alloc(8);
  position.writeBigUInt64BE(BigInt(index));
  return Buffer.concat([position, nonce]);
}
function encryptContent(body: Buffer, master: Buffer): Buffer {
  const nonce = randomBytes(12), content = randomBytes(32);
  const output = [seal(Buffer.concat([Buffer.alloc(8, 255), content]), master.subarray(0, 32), nonce)];
  for (let at = 0, index = 0; at < body.length; at += 32768, index++) {
    output.push(seal(body.subarray(at, at + 32768), content, randomBytes(12), chunkAad(index, nonce)));
  }
  return Buffer.concat(output);
}
function decryptContent(body: Buffer, master: Buffer): Buffer {
  ok(body.length >= 68 && body.length <= 8 * MIB);
  const header = open(body.subarray(0, 68), master.subarray(0, 32));
  deepStrictEqual(header.subarray(0, 8), Buffer.alloc(8, 255));
  equal(header.length, 40);
  const output: Buffer[] = [];
  for (let at = 68, index = 0; at < body.length; at += 32796, index++) {
    output.push(open(body.subarray(at, at + 32796), header.subarray(8), chunkAad(index, body.subarray(0, 12))));
  }
  return Buffer.concat(output);
}

/** Fixed 128-bit operations implement CMAC/S2V framing only; AES stays native. */
function xor(left: Buffer, right: Buffer): Buffer {
  equal(left.length, 16);
  equal(right.length, 16);
  return Buffer.from(left.map((value, at) => value ^ right[at]!));
}
function double(value: Buffer): Buffer {
  equal(value.length, 16);
  const result = Buffer.alloc(16);
  let carry = 0;
  for (let at = 15; at >= 0; at--) {
    result[at] = (value[at]! << 1) | carry;
    carry = value[at]! >>> 7;
  }
  if (carry) result[15] = result[15]! ^ 0x87;
  return result;
}
function block(key: Buffer, value: Buffer): Buffer {
  equal(value.length, 16);
  const cipher = createCipheriv("aes-256-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(value), cipher.final()]);
}
function pad(value: Buffer): Buffer {
  ok(value.length < 16);
  const result = Buffer.alloc(16);
  value.copy(result);
  result[value.length] = 128;
  return result;
}
function cmac(key: Buffer, body: Buffer): Buffer {
  const first = double(block(key, Buffer.alloc(16))), second = double(first);
  const count = Math.max(1, Math.ceil(body.length / 16));
  let state: Buffer = Buffer.alloc(16);
  for (let index = 0; index < count - 1; index++) {
    state = block(key, xor(state, body.subarray(index * 16, index * 16 + 16)));
  }
  const tail = body.subarray((count - 1) * 16);
  const last = body.length > 0 && tail.length === 16 ? xor(tail, first) : xor(pad(tail), second);
  return block(key, xor(state, last));
}
/** One associated-data string is the parent ID, including when it is empty. */
function s2v(key: Buffer, parent: Buffer, text: Buffer): Buffer {
  const mixed = xor(double(cmac(key, Buffer.alloc(16))), cmac(key, parent));
  if (text.length < 16) return cmac(key, xor(double(mixed), pad(text)));
  const end = Buffer.from(text);
  xor(end.subarray(-16), mixed).copy(end, end.length - 16);
  return cmac(key, end);
}
function ctr(key: Buffer, tag: Buffer, body: Buffer): Buffer {
  const iv = Buffer.from(tag);
  iv[8] = iv[8]! & 127;
  iv[12] = iv[12]! & 127;
  const cipher = createCipheriv("aes-256-ctr", key, iv);
  return Buffer.concat([cipher.update(body), cipher.final()]);
}
function encryptName(name: string, parent: Buffer, key: Buffer): string {
  const body = Buffer.from(name), tag = s2v(key.subarray(32), parent, body);
  return Buffer.concat([tag, ctr(key.subarray(0, 32), tag, body)]).toString("base64").replaceAll("+", "-").replaceAll(
    "/",
    "_",
  ) + ".c9r";
}
function decryptName(name: string, parent: Buffer, key: Buffer): string {
  ok(name.endsWith(".c9r"));
  const wire = Buffer.from(name.slice(0, -4), "base64url");
  ok(wire.length >= 16);
  const tag = wire.subarray(0, 16), body = ctr(key.subarray(0, 32), tag, wire.subarray(16));
  ok(timingSafeEqual(s2v(key.subarray(32), parent, body), tag), "Authored SIV glue rejected the native filename tag.");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
}

const artifacts = resolve(args.artifacts), source = resolve(args.source);
const acquisition = object(JSON.parse(read(join(artifacts, "acquisition.json")).toString()) as unknown);
ok(Array.isArray(acquisition.artifacts));
equal(acquisition.artifacts.length, ARTIFACTS.length);
const jars: string[] = [];
for (const expected of ARTIFACTS) {
  const records: Record<string, unknown>[] = acquisition.artifacts.map(object).filter((
    record: Record<string, unknown>,
  ) => record.url === expected.url);
  equal(records.length, 1);
  const record = records[0]!;
  equal(record.sha256, expected.sha256);
  const path = join(artifacts, new URL(expected.url).pathname.split("/").at(-1)!);
  const body = read(path, 16 * MIB);
  equal(body.length, record.bytes);
  equal(sha(body), expected.sha256);
  if (path.endsWith(".jar") && !path.split("/").at(-1)!.startsWith("bcprov-")) jars.push(path);
}
equal(jars.length, 6);
const key = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
const head = Buffer.from('{"typ":"JWT","alg":"HS256","kid":"masterkeyfile:masterkey.cryptomator"}').toString(
  "base64url",
);
const payload = Buffer.from(
  '{"jti":"00000000-0000-0000-0000-000000000001","format":8,"cipherCombo":"SIV_GCM","shorteningThreshold":220}',
).toString("base64url");
const signing = `${head}.${payload}`,
  configuration = `${signing}.${createHmac("sha256", key).update(signing).digest("base64url")}`;
const root = mkdtempSync(join(tmpdir(), "opfs-cryptomator-"));
try {
  const nested = join(root, "nested");
  mkdirSync(nested);
  writeFileSync(
    join(nested, "unrelated.bin"),
    Buffer.from(Array.from({ length: MIB }, (_, index) => (index * 29 + Math.floor(index / 31)) & 255)),
  );
  writeFileSync(join(nested, "selected.txt"), "authenticated nested archive preview\n");
  const nestedZip = join(root, "nested.zip");
  run([args.seven, "a", "-tzip", "-mm=Copy", nestedZip, "unrelated.bin", "selected.txt"], nested);
  const cases: { label: string; original: Buffer; name: string; parent: Buffer }[] = [];
  for (const size of [0, 1, 15, 16, 17, 32767, 32768, 32769, 100003]) {
    cases.push({
      label: `length-${size}`,
      original: Buffer.from(Array.from({ length: size }, (_, index) => (index * 37 + Math.floor(index / 17)) & 255)),
      name: "report.bin",
      parent: Buffer.alloc(0),
    });
  }
  cases.push(
    {
      label: "unicode",
      original: Buffer.from("unicode-name"),
      name: "café-猫.txt",
      parent: Buffer.from("00000000-0000-0000-0000-000000000001"),
    },
    { label: "bom-name", original: Buffer.from("bom-name"), name: "\ufeffliteral.txt", parent: Buffer.alloc(0) },
    { label: "nested-zip", original: read(nestedZip), name: "archive.zip", parent: Buffer.alloc(0) },
  );
  for (const size of [1, 15, 16, 17, 31, 32, 33]) {
    cases.push({
      label: `name-${size}`,
      original: Buffer.from("name-boundary"),
      name: "n".repeat(size),
      parent: Buffer.alloc(size, 112),
    });
  }
  equal(cases.length, 19);
  const classpath = jars.join(delimiter);
  run([args.javac, "-J-Xmx256m", "-cp", classpath, "-d", root, source]);
  const fixtures: Record<string, unknown>[] = [];
  for (const { label, original, name, parent } of cases) {
    const folder = join(root, label);
    mkdirSync(folder);
    writeFileSync(join(folder, "key.bin"), key);
    writeFileSync(join(folder, "original.bin"), original);
    writeFileSync(join(folder, "name.txt"), name);
    writeFileSync(join(folder, "parent.bin"), parent);
    run([args.java, "-Xmx256m", "-cp", classpath + delimiter + root, "Native", "encrypt", folder]);
    const cipher = read(join(folder, "cipher.bin")), cipherName = read(join(folder, "name.cipher")).toString();
    deepStrictEqual(decryptContent(cipher, key), original);
    equal(decryptName(cipherName, parent, key), name);
    const nodeCipher = encryptContent(original, key), nodeName = encryptName(name, parent, key);
    equal(nodeName, cipherName, "Deterministic native and authored SIV name bytes differ.");
    writeFileSync(join(folder, "cipher.bin"), nodeCipher);
    writeFileSync(join(folder, "name.cipher"), nodeName);
    run([args.java, "-Xmx256m", "-cp", classpath + delimiter + root, "Native", "decrypt", folder]);
    deepStrictEqual(read(join(folder, "native-decoded.bin")), original);
    equal(read(join(folder, "native-name.txt")).toString(), name);
    fixtures.push({
      id: label,
      original: original.toString("base64"),
      originalSha256: sha(original),
      ciphertext: cipher.toString("base64"),
      ciphertextSha256: sha(cipher),
      nodeCiphertext: nodeCipher.toString("base64"),
      name,
      parent: parent.toString("ascii"),
      encryptedName: cipherName,
      nodeEncryptedName: nodeName,
    });
  }
  const result = {
    key: key.toString("base64"),
    configuration,
    fixtures,
    acquisition,
    commands,
    tools: {
      java: run([args.java, "--version"]),
      javac: run([args.javac, "--version"]),
      seven: run([args.seven, "i"]),
      node: versions,
    },
    classpath: jars.map((path) => path.split("/").at(-1)),
    oracle:
      "native cryptolib reciprocal acceptance; Node AES-GCM/HMAC primitives and authored RFC5297 S2V/CMAC over Node AES primitives; not independent complete SIV implementation",
    nestedProfile: "native 7-Zip STORED output; not Python zipfile byte replay",
    scripts: {
      "create.ts": sha(read(fileURLToPath(import.meta.url))),
      "Native.java": sha(read(source)),
      "acquire.ts": sha(read(fileURLToPath(new URL("acquire.ts", import.meta.url)))),
      "artifacts.ts": sha(read(fileURLToPath(new URL("artifacts.ts", import.meta.url)))),
    },
  };
  writeFileSync(resolve(args.output), `${JSON.stringify(result)}\n`, { flag: "wx" });
} finally {
  rmSync(root, { recursive: true, force: true });
}
