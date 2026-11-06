import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { createCmisClient } from "../src/cmis.ts";
import type { FetchType } from "../src/request.ts";
import { expectBytes, report } from "./result.ts";
import fixture from "../tests/fixtures/cmis/independent.json" with { type: "json" };

// Question: what does bounded CMIS request/metadata admission cost above raw
// Fetch+JSON decoding over the same captured bytes? Raw lanes are lower bounds:
// they omit lossless-number/property validation, freezing and client request policy.
// All responses use in-memory Fetch; no service, SDK, socket or TLS is timed.
// Exact native InMemory1.1.0 bodies captured on2026-11-05 after an independent
// SDK1.1.0 complete-byte seed/read. Server/SDK hashes and native limits: docs/cmis.md.
// Captured URLs/IDs are inert disposable data; no endpoint is contacted.
const objectId = fixture.objectId;
const rootId = fixture.rootId;
const repositoryText = fixture.repository.text;
const objectText = fixture.object.text;
const content = new Uint8Array(decodeBase64(fixture.content.base64));
const captures = { repository: fixture.repository, object: fixture.object, content: fixture.content };
const rootUrl = "https://cmis-bench.invalid/browser/A1/root";
const repositoryUrl = "https://cmis-bench.invalid/browser/A1";
const suppliedFetch: FetchType = async (input) => {
  const selector = new URL(String(input)).searchParams.get("cmisselector");
  if (selector === "repositoryInfo") return new Response(repositoryText);
  if (selector === "object") return new Response(objectText);
  if (selector === "content") return new Response(content, { headers: { "content-length": String(content.length) } });
  throw new TypeError("CMIS benchmark requested an uncaptured response.");
};
const client = createCmisClient({
  repository: "A1",
  repositoryUrl,
  rootUrl,
  fetch: suppliedFetch,
  policy: { retries: 0 },
});
const objectUrl = new URL(rootUrl);
objectUrl.searchParams.set("objectId", objectId);
objectUrl.searchParams.set("cmisselector", "object");
objectUrl.searchParams.set("succinct", "false");
const infoUrl = new URL(repositoryUrl);
infoUrl.searchParams.set("cmisselector", "repositoryInfo");
infoUrl.searchParams.set("succinct", "false");
const contentUrl = new URL(objectUrl);
contentUrl.searchParams.set("cmisselector", "content");
contentUrl.searchParams.set("download", "attachment");

// Hashing, setup and complete result oracles run before samples. Every timed
// callback still consumes its actual result. These tiny originals measure fixed
// request/materialization overhead, not bulk transfer or provider throughput.
for (
  const [kind, bytes] of [["repository", new TextEncoder().encode(repositoryText)], [
    "object",
    new TextEncoder().encode(objectText),
  ], ["content", content]] as const
) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (bytes.length !== captures[kind].bytes || hex !== captures[kind].sha256) {
    throw new Error("CMIS captured-byte provenance differs.");
  }
}
if ((await client.repository()).root !== rootId || (await client.get(objectId)).id !== objectId) {
  throw new Error("CMIS typed fixture preflight differs.");
}
const rawObject: { readonly properties: Readonly<Record<string, { readonly value: unknown }>> } =
  await (await suppliedFetch(objectUrl)).json();
if (rawObject.properties["cmis:objectId"]?.value !== objectId) {
  throw new Error("CMIS raw JSON fixture preflight differs.");
}
expectBytes(await client.read(objectId), content, "cmis/owned/full-original");
expectBytes(new Uint8Array(await (await suppliedFetch(contentUrl)).arrayBuffer()), content, "cmis/raw/full-original");

bench(
  `cmis raw Fetch+JSON object=${captures.object.bytes}B lower-bound validation=none transport=in-memory cached-URL`,
  async () => do_not_optimize(await (await suppliedFetch(objectUrl)).json()),
);
bench(
  `cmis client get object=${captures.object.bytes}B validation=typed-lossless-frozen transport=in-memory warm-client`,
  async () => do_not_optimize(await client.get(objectId)),
);
bench(
  `cmis raw Fetch+JSON repository=${captures.repository.bytes}B lower-bound validation=none transport=in-memory cached-URL`,
  async () => do_not_optimize(await (await suppliedFetch(infoUrl)).json()),
);
bench(
  `cmis client repository=${captures.repository.bytes}B validation=selected-ID+capability transport=in-memory warm-client`,
  async () => do_not_optimize(await client.repository()),
);
bench(
  `cmis raw Fetch+arrayBuffer original=${content.length}B lower-bound extent-validation=none transport=in-memory cached-URL`,
  async () => do_not_optimize(new Uint8Array(await (await suppliedFetch(contentUrl)).arrayBuffer())),
);
bench(
  `cmis client read original=${content.length}B owned-complete+extent-validation transport=in-memory warm-client`,
  async () => do_not_optimize(await client.read(objectId)),
);
await report();
