// Test-only independent JOSE producer/consumer. Never imports candidate code.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const input = "/tool/evidence";
const output = process.argv[2];
assert.ok(output, "An owned output path is required.");
assert.ok(Number(process.versions.node.split(".")[0]) >= 22);
const manifest = JSON.parse(await readFile(`${input}/acquisition.json`, "utf8"));
assert.equal(manifest.url, "https://registry.npmjs.org/jose/-/jose-6.2.15.tgz");
const admitted = new Map(manifest.members.map((row) => [row.name, row]));
assert.ok(manifest.selected.length <= 512);
for (const name of manifest.selected) {
  assert.ok(name.startsWith("package/") && !name.includes("\\"));
  const parts = name.split("/");
  assert.ok(parts.every((part) => part && part !== "." && part !== ".."));
  assert.ok(
    name === "package/package.json" || name === "package/LICENSE.md" || name === "package/README.md" ||
      (name.startsWith("package/dist/webapi/") && name.endsWith(".js")),
  );
  const relative = name.slice(8);
  const bytes = await readFile(`${input}/sdk/${relative}.snapshot`);
  assert.equal(bytes.length, admitted.get(name).bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), admitted.get(name).sha256);
  const target = resolve("/tool/sdk", relative);
  assert.ok(target.startsWith("/tool/sdk/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: "wx" });
}
const pkg = JSON.parse(await readFile("/tool/sdk/package.json", "utf8"));
assert.equal(pkg.name, "jose");
assert.equal(pkg.version, "6.2.15");
assert.equal(pkg.license, "MIT");
assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
const { CompactEncrypt, compactDecrypt } = await import(pathToFileURL("/tool/sdk/dist/webapi/index.js").href);
const zip = JSON.parse(await readFile("/tool/zip.json", "utf8"));
const original = [
  ["empty", new Uint8Array()],
  ["binary", Uint8Array.from({ length: 513 }, (_, i) => i % 256)],
  ["unicode", new TextEncoder().encode("e\u0301 / \u{1f4c1} / \u0000")],
  ["zip", new Uint8Array(Buffer.from(zip.wireBase64, "base64"))],
];
assert.equal(Buffer.from(original[2][1].subarray(0, 3)).toString("hex"), "65cc81");
const cases = [];
let serial = 0;
for (const bits of [128, 256]) {
  for (const [name, bytes] of original) {
    const index = ++serial;
    const key = Uint8Array.from({ length: bits / 8 }, (_, i) => (index * 17 + i) % 256);
    const iv = Uint8Array.from({ length: 12 }, (_, i) => (index * 19 + i) % 256);
    const header = {
      alg: "dir",
      enc: `A${bits}GCM`,
      kid: `public-test-key-${index}`,
      cty: name === "zip" ? "application/zip" : "application/octet-stream",
    };
    const compact = await new CompactEncrypt(bytes).setProtectedHeader(header).setInitializationVector(iv).encrypt(key);
    const decoded = await compactDecrypt(compact, key, {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: [`A${bits}GCM`],
    });
    assert.deepEqual(new Uint8Array(decoded.plaintext), bytes);
    assert.deepEqual(decoded.protectedHeader, header);
    assert.ok(compact.length <= 65536);
    cases.push({
      id: `${bits}-${name}`,
      profile: `jwe-compact-dir-a${bits}gcm`,
      keyBase64: Buffer.from(key).toString("base64"),
      ivBase64: Buffer.from(iv).toString("base64"),
      protected: header,
      compact,
      originalBase64: Buffer.from(bytes).toString("base64"),
      originalBytes: bytes.length,
      originalSha256: createHash("sha256").update(bytes).digest("hex"),
      nativeCompleteBytesEqual: true,
    });
  }
}
const result = JSON.stringify(
  {
    producer: "panva/jose",
    version: pkg.version,
    sourceCommit: "f931aa5a01d3689887b4370068660daca5e049e3",
    runtime: { node: process.version, versions: process.versions, arch: process.arch, platform: process.platform },
    artifact: { integrity: manifest.integrity, sha256: manifest.sha256 },
    scope:
      "Candidate-free CompactEncrypt/compactDecrypt complete original bytes for eight direct-AES-GCM messages; both SDK paths share native WebCrypto AES. Public fixture keys only.",
    cases,
  },
  null,
  2,
) + "\n";
assert.ok(Buffer.byteLength(result) <= 256 * 1024);
await writeFile(output, result, { flag: "wx" });
