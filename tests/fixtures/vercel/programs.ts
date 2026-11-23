/** Authored test programs, materialized as TypeScript only after explicit offline execution admission. */
export const VERCEL_SERVER = String.raw`
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import process from "node:process";
import { createServer, serve } from "@emulators/core";
import vercelPlugin from "@emulators/vercel";

const token = "vercel_blob_rw_fixture_localonly";
const address = "http://127.0.0.1:8071";
const { app } = createServer(vercelPlugin, { port: 8071, baseUrl: address });
const observations: unknown[] = [];
let requests = 0;
async function bytes(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader(), pieces: Uint8Array[] = [];
  let count = 0, complete = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) { complete = true; break; }
      if (next.value.byteLength > 262144 - count || pieces.length >= 1024) throw new Error("Fixture request-body ceiling.");
      pieces.push(new Uint8Array(next.value)); count += next.value.byteLength;
    }
    const result = new Uint8Array(count); let at = 0;
    for (const piece of pieces) { result.set(piece, at); at += piece.byteLength; }
    return result;
  } finally {
    try { if (!complete) await reader.cancel(); } finally { reader.releaseLock(); }
  }
}
const server = serve({ port: 8071, hostname: "127.0.0.1", async fetch(request: Request) {
  const url = new URL(request.url);
  if (url.pathname === "/__opfs/observations") return Response.json(observations);
  if (++requests > 128) return new Response("Fixture request ceiling.", { status: 429 });
  const body = await bytes(request);
  const forwarded = body.byteLength === 0 && !request.body ? request : new Request(request, { body });
  const response = await app.fetch(forwarded);
  observations.push({
    method: request.method, path: url.pathname, api: url.pathname.startsWith("/api/blob"),
    authorization: request.headers.has("authorization"), recognizedSyntheticToken: request.headers.get("authorization") === "Bearer " + token,
    apiVersion: request.headers.get("x-api-version"), storeID: request.headers.get("x-vercel-blob-store-id"),
    randomSuffix: request.headers.get("x-add-random-suffix"), overwrite: request.headers.get("x-allow-overwrite"),
    ifMatch: request.headers.has("x-if-match"), ifNoneMatch: request.headers.has("if-none-match"),
    requestIDPresent: request.headers.has("x-api-blob-request-id"), payloadBytes: body.byteLength,
    payloadSha256: createHash("sha256").update(body).digest("hex"), status: response.status,
  });
  return response;
} });
server.once("listening", () => {
  writeFileSync("/data/address", address, { mode: 0o600 });
  console.log("OPFS VERCEL EMULATOR READY");
});
server.once("error", () => { process.exitCode = 1; });
let closing = false;
process.on("SIGTERM", () => {
  if (closing) return; closing = true;
  server.closeAllConnections();
  server.close((error?: Error) => { process.exitCode = error ? 1 : 0; });
});
`;

export const VERCEL_ORACLE = String.raw`
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { put, get, head, list, del, BlobPreconditionFailedError } from "@vercel/blob";
const address = readFileSync("/data/address", "utf8").trim();
const admission: unknown = JSON.parse(readFileSync("/fixture/admission.json", "utf8"));
const token = "vercel_blob_rw_fixture_localonly";
const options = { token, access: "public" as const, addRandomSuffix: false };
const signal = () => AbortSignal.timeout(5000);
function original(seed: number, size: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length: size }, (_, i) => (i * seed + (i >>> 8)) & 255);
}
async function body(response: Response): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader(), output = new Uint8Array(1048576);
  let at = 0, count = 0, complete = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) { complete = true; break; }
      if (++count > 4096 || next.value.byteLength > output.length - at) throw new Error("Native response extent ceiling.");
      output.set(next.value, at); at += next.value.byteLength;
    }
    return output.slice(0, at);
  } finally {
    try { if (!complete) await reader.cancel(); } finally { reader.releaseLock(); }
  }
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected native JSON object.");
  return value as Record<string, unknown>;
}
async function raw(url: string, init: RequestInit = {}): Promise<{ status: number; bytes: Uint8Array<ArrayBuffer>; etag: string | null }> {
  const response = await fetch(url, { ...init, signal: signal(), redirect: "error", credentials: "omit" });
  return { status: response.status, bytes: await body(response), etag: response.headers.get("etag") };
}
async function sdkBytes(url: string): Promise<{ status: number | null; bytes: string; etag: string | null }> {
  const response = await get(url, { ...options, abortSignal: signal() });
  if (!response) return { status: null, bytes: "", etag: null };
  const bytes = response.stream ? await body(new Response(response.stream)) : new Uint8Array(0);
  return { status: response.statusCode, bytes: Buffer.from(bytes).toString("base64"), etag: response.blob.etag ?? null };
}
const sdkToRaw: unknown[] = [], rawToSdk: unknown[] = [];
for (const [index, size] of [0, 131072].entries()) {
  const input = original(17, size);
  const receipt = await put("sdk-" + index, input, { ...options, allowOverwrite: false, abortSignal: signal() });
  const selected = await raw(receipt.url);
  const metadata = await head(receipt.url, { token, abortSignal: signal() });
  sdkToRaw.push({ receipt, metadata, status: selected.status, bytes: Buffer.from(selected.bytes).toString("base64") });

  const other = original(29, size);
  const created = await raw(address + "/api/blob?pathname=" + encodeURIComponent("raw-" + index), {
    method: "PUT", headers: { authorization: "Bearer " + token, "x-api-version": "13", "x-vercel-blob-store-id": "fixture",
      "x-vercel-blob-access": "public", "x-add-random-suffix": "0", "x-allow-overwrite": "0", "x-content-type": "application/octet-stream" }, body: other,
  });
  const metadataRaw = object(JSON.parse(new TextDecoder().decode(created.bytes)));
  if (typeof metadataRaw.url !== "string") throw new Error("Raw PUT omitted URL.");
  const rawMetadata = await head(metadataRaw.url, { token, abortSignal: signal() });
  rawToSdk.push({ status: created.status, receipt: metadataRaw, metadata: rawMetadata, selected: await sdkBytes(metadataRaw.url) });
}
const target = address + "/blob/fixture/sdk-1";
let createOnlyRejected = false, staleRejected = false;
try { await put("sdk-1", new Uint8Array([9]), { ...options, allowOverwrite: false, abortSignal: signal() }); } catch { createOnlyRejected = true; }
try { await put("sdk-1", new Uint8Array([8]), { ...options, ifMatch: '"not-current"', abortSignal: signal() }); }
catch (reason) { staleRejected = reason instanceof BlobPreconditionFailedError; }
const afterRefusals = await raw(target);
const current = await head(target, { token, abortSignal: signal() });
if (!current.etag) throw new Error("Native head omitted current ETag.");
const matched = await put("sdk-1", new Uint8Array([17, 0, 251]), { ...options, ifMatch: current.etag, abortSignal: signal() });
const afterMatched = await raw(matched.url);
const cached = await raw(matched.url, { headers: { "if-none-match": matched.etag } });
const pages: unknown[] = [];
let cursor: string | undefined;
for (let index = 0; index < 8; index++) {
  const page = await list({ token, prefix: "raw-", limit: 1, ...(cursor === undefined ? {} : { cursor }), abortSignal: signal() });
  pages.push(page);
  if (!page.hasMore) break;
  if (!page.cursor || page.cursor === cursor) throw new Error("Native pagination did not advance.");
  cursor = page.cursor;
  if (index === 7) throw new Error("Native pagination ceiling.");
}
await del(address + "/blob/fixture/raw-0", { token, abortSignal: signal() });
const deleted = await raw(address + "/blob/fixture/raw-0");
const missing = await get(address + "/blob/fixture/missing", { ...options, abortSignal: signal() });
const controller = new AbortController(); controller.abort(new Error("Authored pre-abort."));
let preAbortRejected = false;
try { await put("pre-abort", new Uint8Array([1]), { ...options, abortSignal: controller.signal }); }
catch { preAbortRejected = true; }
const preAbortReadback = await raw(address + "/blob/fixture/pre-abort");
const observations = await raw(address + "/__opfs/observations");
const requests: unknown = JSON.parse(new TextDecoder().decode(observations.bytes));
console.log("RECEIPT:" + JSON.stringify({ profile: "vercel-blob-2.8.2-emulator-0.13.0-native-v1", admission,
  sdkToRaw, rawToSdk, createOnlyRejected, staleRejected, afterRefusals: Buffer.from(afterRefusals.bytes).toString("base64"),
  matched, afterMatched: Buffer.from(afterMatched.bytes).toString("base64"), cache: { status: cached.status, bytes: cached.bytes.length },
  pages, deleted: deleted.status, missing: missing === null, preAbortRejected, preAbortReadback: preAbortReadback.status, requests,
  scope: "Official SDK and independently authored local emulator plus authored literal wire probe; not production Vercel, OIDC, multipart, range or filesystem proof." }));
`;

/** Fixed Node-built-in-only copier. Foreign entrypoints remain blocked until all admitted files pass readback. */
export const VERCEL_WRITER = String.raw`
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const parts = [];
let inputBytes = 0;
for await (const chunk of process.stdin) {
  inputBytes += chunk.length;
  if (inputBytes > 32 * 1048576) throw new Error("Serialized copy ceiling exceeded.");
  parts.push(Buffer.from(chunk));
}
const raw = Buffer.concat(parts);
const source = new TextDecoder("utf-8", { fatal: true }).decode(raw);
const parsed = JSON.parse(source);
if (!Array.isArray(parsed) || parsed.length > 12002) throw new Error("Copy entry ceiling exceeded.");
const names = new Set();
const entries = [];
let total = 0;
for (const item of parsed) {
  if (!item || typeof item !== "object" || Array.isArray(item) ||
    typeof item.name !== "string" || !item.name || item.name.includes("\\") || item.name.includes("\0") ||
    item.name.split("/").some(part => !part || part === "." || part === "..") || item.name === "ready" ||
    names.has(item.name) || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > 24 * 1048576 ||
    typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.sha256) ||
    typeof item.base64 !== "string" || item.base64.length > 32 * 1048576) throw new Error("Invalid copy entry.");
  names.add(item.name);
  const bytes = Buffer.from(item.base64, "base64");
  if (bytes.toString("base64") !== item.base64 || bytes.length !== item.size || digest(bytes) !== item.sha256) {
    throw new Error("Copy byte identity differs.");
  }
  total += bytes.length;
  if (total > 24 * 1048576) throw new Error("Copy payload ceiling exceeded.");
  entries.push({ name: item.name, bytes, sha256: item.sha256 });
}
// Validate the full namespace before the first write; a file cannot also be a parent directory.
for (const item of entries) {
  const components = item.name.split("/");
  for (let count = 1; count < components.length; count++) {
    if (names.has(components.slice(0, count).join("/"))) throw new Error("Conflicting copy namespace.");
  }
}
for (const item of entries) {
  const path = "/fixture/" + item.name;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, item.bytes, { flag: "wx", mode: 0o400 });
  const copied = await readFile(path);
  if (copied.length !== item.bytes.length || digest(copied) !== item.sha256) throw new Error("Copy readback differs.");
}
for (const path of ["/fixture/emulator/server.ts", "/fixture/sdk/oracle.ts"]) {
  execFileSync(process.execPath, ["--check", path], { timeout: 10000, maxBuffer: 65536 });
}
await writeFile("/fixture/ready", "ready\n", { flag: "wx", mode: 0o400 });
`;
