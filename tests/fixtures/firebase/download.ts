/** Hash-admitted Firebase CLI, SDK and rules runtime, test-only and outside production imports. @module */
import { ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
const artifacts: readonly [string, string, "sha256" | "sha512", string][] = [
  [
    "https://registry.npmjs.org/firebase-tools/-/firebase-tools-15.35.0.tgz",
    "/fixture/tools.tgz",
    "sha512",
    "grcjoqNsJoWTTu+YEuM8BScOM7c5lM1XCFenmz0RhNEyJVoj8dTslPy7sx5Hct69+9OAKJb70qZ3JTHZFw+3zQ==",
  ],
  [
    "https://registry.npmjs.org/firebase/-/firebase-13.2.0.tgz",
    "/fixture/sdk.tgz",
    "sha512",
    "29ye5F+viPTv48mcljy84ZnwnrYmTTIULrWf3P113SfeTB/USIUZTs8gREreN5PmndQdKs3D06KQUPJIrFeTGw==",
  ],
  [
    "https://storage.googleapis.com/firebase-preview-drop/emulator/cloud-storage-rules-runtime-v1.1.3.jar",
    "/root/.cache/firebase/emulators/cloud-storage-rules-runtime-v1.1.3.jar",
    "sha256",
    "0cd52db6f6271d62078f805220706377c849220b73bd68aa27078d977df9c900",
  ],
];
for (const [url, path, algorithm, expected] of artifacts) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  ok(response.ok && response.body, "Fixture download failed.");
  const chunks: Uint8Array[] = [];
  let count = 0;
  // These are build artifacts, not decoded service payloads. Keep their acquisition policy explicit.
  for await (const chunk of response.body) {
    count += chunk.length;
    ok(count <= 128 * 1024 * 1024, "Firebase artifact exceeds acquisition bound.");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  ok(
    createHash(algorithm).update(bytes).digest(algorithm === "sha512" ? "base64" : "hex") === expected,
    "Fixture artifact hash differs.",
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: "wx" });
}
