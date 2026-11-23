import { bench, do_not_optimize } from "mitata";
import { createHash } from "node:crypto";
import { createGlacierClient, GLACIER_MIB, glacierTreeHash } from "../src/glacier.ts";
import type { GlacierJobType, GlacierOptionsType } from "../src/glacier.ts";
import { expectBytes, payload, report } from "./result.ts";

// Question: what do snapshot ownership, Glacier tree reduction, request signing,
// and exact completed-output admission cost for the same 4 MiB + 13 byte image?
// Native Node SHA and copy-only lanes are deliberately different lower bounds.
// No lane measures AWS, HTTP/TLS, durable upload, cold retrieval, process startup,
// or an SDK. WebCrypto internals and Response construction may allocate copies.
const original = new Uint8Array(payload(4 * GLACIER_MIB + 13));
/** Independent native SHA full-level reduction; no candidate spine or input snapshot. */
function nativeTree(bytes: Uint8Array): string {
  let level: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += GLACIER_MIB) {
    level.push(createHash("sha256").update(bytes.subarray(at, at + GLACIER_MIB)).digest());
  }
  if (level.length === 0) return createHash("sha256").digest("hex");
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let at = 0; at < level.length; at += 2) {
      next.push(
        at + 1 === level.length ? level[at]! : createHash("sha256").update(level[at]!).update(level[at + 1]!).digest(),
      );
    }
    level = next;
  }
  return Array.from(level[0]!, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
const expectedTree = nativeTree(original);
const expectedLinear = createHash("sha256").update(original).digest("hex");
const job: GlacierJobType = {
  JobId: "job",
  Action: "ArchiveRetrieval",
  Completed: true,
  StatusCode: "Succeeded",
  ArchiveId: "archive",
  ArchiveSizeInBytes: original.length,
  RetrievalByteRange: `0-${original.length - 1}`,
};
const endpoint = "https://glacier-bench.invalid";
const upload = { id: "upload", partSize: 8 * GLACIER_MIB };
let requests = 0, copiedInput: Uint8Array | undefined, lastHeaders = new Headers();
let checked = true;
/** In-memory transport has bounded counters and no accumulated request history. */
const suppliedFetch: GlacierOptionsType["fetch"] = async (input, init) => {
  requests = (requests + 1) % 1000000;
  const url = new URL(String(input));
  lastHeaders = new Headers(init?.headers);
  if (init?.method === "PUT" && url.pathname === "/-/vaults/fixture/multipart-uploads/upload") {
    if (!(init.body instanceof Uint8Array)) throw new TypeError("Benchmark requires a materialized part image.");
    copiedInput = init.body;
    return new Response(null, { status: 204, headers: { "x-amz-sha256-tree-hash": expectedTree } });
  }
  if (init?.method === "GET" && url.pathname === "/-/vaults/fixture/jobs/job/output") {
    return new Response(original, {
      headers: {
        "content-length": String(original.length),
        ...(checked ? { "x-amz-sha256-tree-hash": expectedTree } : {}),
      },
    });
  }
  throw new Error("Unexpected Glacier benchmark route.");
};
const client = createGlacierClient({
  endpoint,
  account: "-",
  vault: "fixture",
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture-only" },
  fetch: suppliedFetch,
  subtle: crypto.subtle,
  now: () => new Date("2026-11-05T00:00:00Z"),
  requestPolicy: { retries: 0 },
});

// Complete correctness preflight is outside every timed callback. The full image
// is checked, rather than a length/sentinel or a candidate-generated digest.
if (await glacierTreeHash(original, crypto.subtle) !== expectedTree) {
  throw new Error("Glacier public tree differs from native SHA reduction.");
}
const part = await client.uploadPart(upload, 0, original);
if (
  part.start !== 0 || part.end !== original.length - 1 || part.treeHash !== expectedTree || copiedInput === undefined
) throw new Error("Glacier part receipt changed.");
expectBytes(copiedInput, original, "glacier/owned-request-image");
if (
  copiedInput.buffer === original.buffer || lastHeaders.get("x-amz-content-sha256") !== expectedLinear ||
  lastHeaders.get("content-range") !== `bytes 0-${original.length - 1}/*`
) throw new Error("Glacier request ownership or checksums changed.");
expectBytes(
  (await client.readOutput(job, 0, original.length, { requireChecksum: true })).bytes,
  original,
  "glacier/verified-output",
);
checked = false;
expectBytes((await client.readOutput(job, 0, original.length)).bytes, original, "glacier/exact-output");
if (requests !== 3) throw new Error("Glacier preflight request count changed.");
const copied = new Uint8Array(original);
expectBytes(copied, original, "glacier/raw-snapshot");

bench(
  `Glacier copy-only ${original.length}B owned-copies=1 validation=none lower-bound`,
  () => do_not_optimize(new Uint8Array(original)),
);
bench(
  `Glacier native Node SHA tree ${original.length}B leaves=5 input-copies=0 reduction=full-level lower-bound different-crypto`,
  () => do_not_optimize(nativeTree(original)),
);
bench(
  `Glacier WebCrypto linear SHA ${original.length}B input-copies=0 tree=none lower-bound`,
  async () => do_not_optimize(await crypto.subtle.digest("SHA-256", original)),
);
bench(
  `Glacier public tree ${original.length}B owned-copies=1 reduction=log-spine crypto=WebCrypto`,
  async () => do_not_optimize(await glacierTreeHash(original, crypto.subtle)),
);
bench(
  `Glacier client part ${original.length}B owned-copies=1 tree+linear+SigV4 transport=in-memory warm-client`,
  async () => do_not_optimize(await client.uploadPart(upload, 0, original)),
);
bench(
  `Glacier client output ${original.length}B validation=exact-size tree=none response-copy+output-allocation transport=in-memory`,
  async () => {
    checked = false;
    do_not_optimize(await client.readOutput(job, 0, original.length));
  },
);
bench(
  `Glacier client output ${original.length}B validation=exact-size+service-tree response-copy+output-allocation transport=in-memory`,
  async () => {
    checked = true;
    do_not_optimize(await client.readOutput(job, 0, original.length, { requireChecksum: true }));
  },
);
await report();
