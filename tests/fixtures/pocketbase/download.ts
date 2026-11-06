/** Hash-admitted independent PocketBase native executable and SDK, without package execution. @module */
import { ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import process from "node:process";
const hashes: Record<string, string> = {
  arm64: "d22c66ceb67ca92b7d767f36d826e848a276bcfa3c197ead20bf87c42208984f",
  x64: "0e1f609158ed945f809f8a02ae012aa0427129c66ebb63c1aee76f2c0309373f",
};
const hash = hashes[process.arch];
ok(hash, "Unsupported native fixture architecture.");
const artifacts: readonly [string, string, "sha256" | "sha512", string, "hex" | "base64"][] = [
  [
    `https://github.com/pocketbase/pocketbase/releases/download/v0.40.6/pocketbase_0.40.6_linux_${
      process.arch === "x64" ? "amd64" : "arm64"
    }.zip`,
    "server.zip",
    "sha256",
    hash,
    "hex",
  ],
  [
    "https://registry.npmjs.org/pocketbase/-/pocketbase-0.28.1.tgz",
    "sdk.tgz",
    "sha512",
    "/3ihkq+rvfcs0MQgrK4sEElOg6gfenHW9S/O+3BSO+V1yT+4B10+9aT22uTQUPqze9ItwNtwWyY5ZmdgVCTdVA==",
    "base64",
  ],
];
for (const [url, path, algorithm, expected, encoding] of artifacts) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  ok(response.ok && response.body, "Official fixture download failed.");
  const chunks: Uint8Array[] = [];
  let count = 0;
  for await (const chunk of response.body) {
    count += chunk.length;
    ok(count <= 32 * 1024 * 1024, "Artifact exceeds byte bound.");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  ok(createHash(algorithm).update(bytes).digest(encoding) === expected, "Official artifact hash differs.");
  await writeFile(path, bytes, { flag: "wx" });
}
