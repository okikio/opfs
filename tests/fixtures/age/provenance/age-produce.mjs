/** DRAFT: candidate-free native age CLI proof. Never import the OPFS candidate. */
import { createDecipheriv, createHash, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { arch, platform, release } from "node:os";

const deadline = Date.now() + 120000;
const evidence = "/tool/evidence/";
const work = "/tmp/age-native/";
mkdirSync(work, { recursive: true });
const sha = (b) => createHash("sha256").update(b).digest("hex");
function bounded(path, maximum) {
  assert(statSync(path).size <= maximum, `Input cap: ${path}`);
  const bytes = readFileSync(path);
  assert(bytes.length <= maximum, `Input extent: ${path}`);
  return bytes;
}
function json(path, maximum = 1024 * 1024) {
  return JSON.parse(bounded(path, maximum));
}
const commands = [];
function command(executable, args, maximum = 4 * 1024 * 1024) {
  const remaining = deadline - Date.now();
  assert(remaining > 0, "Whole producer deadline");
  const result = spawnSync(executable, args, {
    timeout: Math.min(15000, remaining), maxBuffer: maximum,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: work, LANG: "C.UTF-8" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const row = {
    executable, args, status: result.status, signal: result.signal,
    stdoutBytes: result.stdout?.length ?? 0, stdoutSha256: sha(result.stdout ?? Buffer.alloc(0)),
    stderrBytes: result.stderr?.length ?? 0, stderr: result.stderr?.toString("utf8").slice(0, 4096) ?? "",
    ...(result.error ? { error: String(result.error).slice(0, 1024) } : {}),
  };
  commands.push(row);
  writeFileSync(work + "commands.json", JSON.stringify(commands, null, 2) + "\n");
  assert.equal(result.error, undefined, JSON.stringify(row));
  assert.equal(result.status, 0, JSON.stringify(row));
  return result.stdout;
}

// Test-only Bech32 encoding follows pinned age internal/bech32/bech32.go.
// Its upstream implementation carries the MIT notice of Takatoshi Nakagawa
// (2017) and the age Authors (2019); retain that inert source with this harness.
function bech32(hrp, raw) {
  const lower = hrp.toLowerCase();
  const words = [];
  let acc = 0, bits = 0;
  for (const value of raw) {
    acc = ((acc << 8) | value) >>> 0;
    bits += 8;
    while (bits >= 5) { bits -= 5; words.push((acc >>> bits) & 31); }
  }
  if (bits) words.push((acc << (5 - bits)) & 31);
  const expand = [...lower].map((c) => c.charCodeAt(0) >>> 5).concat([0], [...lower].map((c) => c.charCodeAt(0) & 31));
  let state = 1;
  for (const value of expand.concat(words, [0, 0, 0, 0, 0, 0])) {
    const high = state >>> 25;
    state = (((state & 0x1ffffff) << 5) ^ value) >>> 0;
    for (const [i, generator] of [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3].entries()) {
      if ((high >>> i) & 1) state = (state ^ generator) >>> 0;
    }
  }
  state = (state ^ 1) >>> 0;
  for (let i = 0; i < 6; i++) words.push((state >>> (5 * (5 - i))) & 31);
  const text = lower + "1" + words.map((n) => "qpzry9x8gf2tvdw0s3jn54khce6mua7l"[n]).join("");
  return hrp === hrp.toUpperCase() ? text.toUpperCase() : text;
}

function rawBase64(text, length) {
  assert(/^[A-Za-z0-9+/]*$/.test(text));
  const bytes = Buffer.from(text, "base64");
  assert.equal(bytes.length, length);
  assert.equal(bytes.toString("base64").replace(/=+$/, ""), text);
  return bytes;
}

/** Extract only the genuine CLI's X25519 stanza; not a production recipient API. */
function unlocked(wire, privateKey, publicRaw) {
  const footer = wire.indexOf(Buffer.from("\n--- "));
  assert(footer > 0 && footer < 65536);
  const end = wire.indexOf(10, footer + 5);
  assert(end > footer && end < 65536);
  const lines = wire.subarray(0, footer + 1).toString("ascii").split("\n");
  assert.equal(lines[0], "age-encryption.org/v1");
  const slots = lines.map((line, index) => [line, index]).filter(([line]) => line.startsWith("-> X25519 "));
  assert.equal(slots.length, 1);
  const [line, index] = slots[0];
  const args = line.split(" ");
  assert.equal(args.length, 3);
  const share = rawBase64(args[2], 32);
  let body = "";
  for (let i = index + 1; i < lines.length && !lines[i].startsWith("-> "); i++) body += lines[i];
  const sealed = rawBase64(body, 32);
  const ephemeral = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: share.toString("base64url") }, format: "jwk" });
  const secret = diffieHellman({ privateKey, publicKey: ephemeral });
  const key = Buffer.from(hkdfSync("sha256", secret, Buffer.concat([share, publicRaw]), Buffer.from("age-encryption.org/v1/X25519"), 32));
  let fileKey;
  try {
    const cipher = createDecipheriv("chacha20-poly1305", key, Buffer.alloc(12), { authTagLength: 16 });
    cipher.setAuthTag(sealed.subarray(16));
    const tentative = cipher.update(sealed.subarray(0, 16));
    try { fileKey = Buffer.concat([tentative, cipher.final()]); } finally { tentative.fill(0); }
    assert.equal(fileKey.length, 16);
    const macKey = Buffer.from(hkdfSync("sha256", fileKey, Buffer.alloc(0), Buffer.from("header"), 32));
    try {
      const expected = createHmac("sha256", macKey).update(wire.subarray(0, footer + 4)).digest();
      assert(timingSafeEqual(expected, rawBase64(wire.subarray(footer + 5, end).toString("ascii"), 32)));
    } finally { macKey.fill(0); }
    return { fileKey, nonce: wire.subarray(end + 1, end + 17).toString("hex"), headerBytes: end + 1 };
  } finally { secret.fill(0); key.fill(0); }
}

assert.equal(process.version, "v26.13.0");
assert.equal(arch(), "arm64");
const acquisition = json(evidence + "cli-receipt.json");
assert.equal(acquisition.result.sha256, "6b8dc4333c53a5a57c9e5834e3a48f92605d7154014cd07269ff3327db5d37f4");
const binaryRow = acquisition.result.members.find((row) => row.path === "age/age");
const binary = bounded(evidence + "cli/age.snapshot", 32 * 1024 * 1024);
assert.equal(binary.length, binaryRow.bytes);
assert.equal(sha(binary), binaryRow.sha256);
assert((binaryRow.mode & 0o111) !== 0, "Native archive executable mode");
assert(binary.length >= 64 && binary.subarray(0, 7).equals(Buffer.from([127, 69, 76, 70, 2, 1, 1])), "ELF64 little-endian header");
assert.equal(binary.readUInt16LE(18), 183, "Native ELF AArch64 machine");
assert([2, 3].includes(binary.readUInt16LE(16)), "Native ELF executable type");
writeFileSync(work + "age", binary);
chmodSync(work + "age", 0o700);
const version = command(work + "age", ["--version"], 16384).toString("utf8").trim();
assert(/^v?1\.3\.2$/.test(version));

const keys = generateKeyPairSync("x25519");
const privateJwk = keys.privateKey.export({ format: "jwk" });
const publicRaw = Buffer.from(keys.publicKey.export({ format: "jwk" }).x, "base64url");
const testPrivateRaw = Buffer.from(privateJwk.d, "base64url");
assert.equal(testPrivateRaw.length, 32);
const identity = bech32("AGE-SECRET-KEY-", testPrivateRaw);
const recipient = bech32("age", publicRaw);
testPrivateRaw.fill(0);
writeFileSync(work + "identity.txt", identity + "\n", { mode: 0o600 });
const zipRaw = bounded("/tool/zip.json", 4096);
assert.equal(sha(zipRaw), "ffc47f0fc7ff99ed86e85e004e8cbcc44657320906b585d9ef4b7817f3e1aba9");
const zip = JSON.parse(zipRaw);
const zipBytes = Buffer.from(zip.wireBase64, "base64");
assert.equal(sha(zipBytes), "cd39011fa874b83462d6a51dd054ef4f8df198f80f698f5fe003772e25d1dad7");
const originals = [0, 1, 65535, 65536, 65537, 131072, 131089].map((length) => ({
  name: "bytes-" + length,
  bytes: Buffer.from(Array.from({ length }, (_, i) => (i * 73 + (i >>> 8) * 19 + 11) & 255)),
}));
originals.push({ name: "python-zip", bytes: zipBytes });
const records = [], nonces = new Set();
for (const [index, original] of originals.entries()) {
  assert(original.bytes.length <= 2 * 1024 * 1024);
  writeFileSync(work + `original-${index}`, original.bytes);
  command(work + "age", ["-r", recipient, "-o", work + `cipher-${index}`, work + `original-${index}`]);
  const wire = bounded(work + `cipher-${index}`, 2 * 1024 * 1024);
  command(work + "age", ["-d", "-i", work + "identity.txt", "-o", work + `decoded-${index}`, work + `cipher-${index}`]);
  const actual = bounded(work + `decoded-${index}`, 2 * 1024 * 1024);
  assert(actual.equals(original.bytes), original.name + ": native complete original bytes");
  const result = unlocked(wire, keys.privateKey, publicRaw);
  assert.equal(nonces.has(result.nonce), false);
  nonces.add(result.nonce);
  records.push({ name: original.name, originalBase64: original.bytes.toString("base64"), originalSha256: sha(original.bytes),
    wireBase64: wire.toString("base64"), wireSha256: sha(wire), fileKeyHex: result.fileKey.toString("hex"),
    headerBytes: result.headerBytes, payloadNonce: result.nonce, nativeCompleteOriginalEqual: true });
  result.fileKey.fill(0);
}

const vectors = json(evidence + "vectors-receipt.json");
const corpus = [];
for (const row of vectors.result.files.filter((row) => row.metadata?.expect?.[0] === "success")) {
  const name = row.path.split("/").at(-1);
  assert(/^[a-z0-9_]+$/.test(name));
  const original = bounded(evidence + "sources/" + row.repo + "/" + row.path + ".snapshot", 65536);
  assert.equal(sha(original), row.sha256);
  const wire = bounded(evidence + "vectors/" + name + ".age.snapshot", 1024 * 1024);
  assert.equal(sha(wire), row.wire.sha256);
  assert.equal(row.metadata.identity.length, 1);
  assert.equal(row.metadata.payload.length, 1);
  writeFileSync(work + "corpus-identity", row.metadata.identity[0] + "\n", { mode: 0o600 });
  writeFileSync(work + "corpus-input", wire);
  // stdout is finite and retained only after the native decrypt succeeds.
  const actual = command(work + "age", ["-d", "-i", work + "corpus-identity", work + "corpus-input"], 2 * 1024 * 1024);
  assert.equal(sha(actual), row.metadata.payload[0], name + ": published whole plaintext SHA-256");
  corpus.push({ name, originalBase64: actual.toString("base64"), originalSha256: sha(actual),
    wireBase64: wire.toString("base64"), wireSha256: sha(wire), fileKeyHex: row.metadata["file key"][0], nativePublishedWholeHashEqual: true });
}
assert.equal(records.length, 8);
assert.equal(corpus.length, 8);
const output = {
  scope: "Candidate-free native Go CLI producer/consumer, test-only Node file-key extraction, and eight upstream successful vectors. No negative native-conformance claim.",
  node: process.version, platform: platform(), architecture: arch(), release: release(), nativeVersion: version,
  nativeArchiveSha256: acquisition.result.sha256, nativeBinarySha256: sha(binary),
  cctvCommit: vectors.result.cctvCommit, testIdentityGeneratedEphemerally: true, secretIdentityIncludedInFixture: false, records, corpus, commands,
  zip: { producer: zip.producer, version: zip.version, name: zip.name, originalBase64: zip.originalBase64, sha256: zip.sha256 },
};
const encoded = JSON.stringify(output, null, 2) + "\n";
assert(Buffer.byteLength(encoded) <= 16 * 1024 * 1024);
writeFileSync(work + "independent.json", encoded);
console.log(JSON.stringify({ nativeVersion: version, originals: records.length, upstreamSuccesses: corpus.length,
  bytes: Buffer.byteLength(encoded), sha256: sha(Buffer.from(encoded)), scope: output.scope }));
