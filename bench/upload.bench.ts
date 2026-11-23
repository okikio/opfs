/** Authored Fetch-contract costs; these workloads exclude sockets, provider storage and publication. */
import { bench, do_not_optimize } from "mitata";
import { createUploadClient } from "../src/upload.ts";
import type { FetchType } from "../src/request.ts";
import { readDictionary } from "../src/transfer/fields.ts";
import { expectBytes, report } from "./result.ts";

const target = "https://upload.example/report";
const chunk = Uint8Array.from({ length: 65536 }, (_, index) => index % 251);
/** A fresh native Response per call keeps body ownership equivalent between lanes. */
const transport: FetchType = async (_url, init) => {
  const method = init?.method;
  if (method === "POST") return new Response(null, { status: 201, headers: { Location: "/uploads/one" } });
  if (method === "HEAD") return new Response(null, { headers: { "Upload-Offset": "0" } });
  return new Response(null, { status: 204, headers: { "Upload-Complete": "?0" } });
};
async function selectedChunk(fetch: FetchType = transport) {
  const client = createUploadClient({ profile: "draft-15", target, fetch });
  const made = await client.create({ method: "POST", size: chunk.byteLength });
  if (made.kind !== "created") throw new Error("Benchmark creation failed.");
  const resource = client.open(made.session);
  await resource.status();
  return await resource.append(0, chunk);
}
let transmitted = 0;
const checked = await selectedChunk(async (url, init) => {
  if (init?.method === "PATCH") {
    const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
    expectBytes(bytes, chunk, "upload/copied64KiB-all-transmitted-bytes");
    transmitted += bytes.byteLength;
  }
  return await transport(url, init);
});
if (checked.kind !== "ack" || checked.offset !== chunk.byteLength || transmitted !== chunk.byteLength) {
  throw new Error("Upload preflight acknowledgement or transmitted bytes differ.");
}
const fields = 'max-size=1048576, max-append-size=65536; ext="opaque,parameter", extra=(1 2; x=?1)';
if (readDictionary(fields).get("maxSize") !== undefined || readDictionary(fields).get("max-size")?.value !== 1048576) {
  throw new Error("Structured-field preflight failed.");
}
bench("raw authored Fetch / HEAD response allocation+cancel / 1 request", async () => {
  const result = await transport(target, { method: "HEAD" });
  await result.body?.cancel();
  do_not_optimize(result.status);
});
bench("RFC9651 advice dictionary / 3 members / finite parser", () => do_not_optimize(readDictionary(fields)));
bench(
  "cold upload workflow creation+HEAD+copied64KiB append / 3 requests / not raw-HEAD equivalent",
  async () => do_not_optimize(await selectedChunk()),
);
await report();
