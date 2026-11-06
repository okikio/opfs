import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { createCouchdbClient } from "../src/couchdb.ts";
import type { FetchType } from "../src/request.ts";
import { expectBytes, report } from "./result.ts";
import fixture from "../tests/fixtures/couchdb/independent.json" with { type: "json" };

// Question: what does the native client add above raw Fetch+JSON/arrayBuffer
// decoding of the same captured CouchDB3.5.3 bytes? Raw lanes are lower bounds:
// they omit lossless numeric/identity admission, metadata freezing and EOF checks.
// No server, SDK, network or TLS is timed. These tiny originals measure fixed
// request/control/stream-owner costs, not storage speed or bulk throughput.
// Exact native envelopes and full Nano11.0.8 original: fixtures/couchdb/provenance.json.
const metadata = new Uint8Array(decodeBase64(fixture.document.base64));
const content = new Uint8Array(decodeBase64(fixture.content.base64));
const oracle = new Uint8Array(decodeBase64(fixture.oracle.base64));
const endpoint = "https://couchdb-bench.invalid/";
const documentUrl = new URL(`${fixture.database}/${fixture.documentId}`, endpoint);
documentUrl.searchParams.set("attachments", "false");
documentUrl.searchParams.set("att_encoding_info", "true");
const contentUrl = new URL(`${fixture.database}/${fixture.documentId}/${fixture.attachmentName}`, endpoint);
const suppliedFetch: FetchType = async (input) => {
  const url = new URL(String(input));
  if (url.href === documentUrl.href) {
    return new Response(metadata, { status: fixture.document.status, headers: fixture.document.headers });
  }
  if (url.href === contentUrl.href) {
    return new Response(content, { status: fixture.content.status, headers: fixture.content.headers });
  }
  throw new TypeError("CouchDB benchmark requested an uncaptured operation.");
};
const client = createCouchdbClient({
  endpoint,
  database: fixture.database,
  fetch: suppliedFetch,
  policy: { retries: 0 },
});
// Hashes and complete-byte/identity preflights remain outside timed callbacks.
for (
  const [capture, bytes] of [[fixture.document, metadata], [fixture.content, content], [
    fixture.oracle,
    oracle,
  ]] as const
) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== capture.sha256 || bytes.length !== capture.bytes) throw new Error("CouchDB captured bytes differ.");
}
const result = await client.document(fixture.documentId);
if (result.id !== fixture.documentId || result.attachments[0]?.name !== fixture.attachmentName) {
  throw new Error("CouchDB typed metadata preflight differs.");
}
const raw: unknown = await (await suppliedFetch(documentUrl)).json();
if (raw === null || typeof raw !== "object" || !("_id" in raw) || raw._id !== fixture.documentId) {
  throw new Error("CouchDB raw metadata preflight differs.");
}
expectBytes(await client.read(fixture.documentId, fixture.attachmentName), oracle, "couchdb/client/Nano-original");
expectBytes(new Uint8Array(await (await suppliedFetch(contentUrl)).arrayBuffer()), oracle, "couchdb/raw/Nano-original");
bench(
  `couchdb raw Fetch+JSON metadata=${metadata.length}B lower-bound validation=none transport=in-memory cached-URL`,
  async () => do_not_optimize(await (await suppliedFetch(documentUrl)).json()),
);
bench(
  `couchdb client document metadata=${metadata.length}B validation=lossless-ID-stubs-frozen transport=in-memory warm-client`,
  async () => do_not_optimize(await client.document(fixture.documentId)),
);
bench(
  `couchdb raw Fetch+arrayBuffer original=${content.length}B lower-bound extent-validation=none transport=in-memory cached-URL`,
  async () => do_not_optimize(new Uint8Array(await (await suppliedFetch(contentUrl)).arrayBuffer())),
);
bench(
  `couchdb client read original=${content.length}B validation=owned-complete+extent transport=in-memory warm-client`,
  async () => do_not_optimize(await client.read(fixture.documentId, fixture.attachmentName)),
);
await report();
