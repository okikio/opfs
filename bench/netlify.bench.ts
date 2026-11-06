/** Authored in-memory transport costs, not SDK/server interoperability or live provider timings. */
import { bench, do_not_optimize } from "mitata";
import { createNetlifyClient, NETLIFY_PROFILE } from "../src/netlify.ts";
import type { FetchType } from "../src/netlify.ts";
import { expectBytes, report } from "./result.ts";

// Fixed 128 KiB original; setup and full-byte checks stay outside timing.
const original = Uint8Array.from({ length: 128 * 1024 }, (_, index) => index % 256);
let stored = new Uint8Array(original);
const api = "https://api.fixture", data = "https://data.fixture/object?signature=authored";
/** No history, retry or network belongs to this transport; one retained object is replaced on PUT. */
const transport: FetchType = (input, init = {}) => {
  const url = String(input), headers = new Headers(init.headers), method = init.method;
  if (init.redirect !== "error" || init.credentials !== "omit" || !init.signal) {
    throw new Error("Netlify benchmark transport policy differs.");
  }
  init.signal.throwIfAborted();
  if (url === `${api}/api/v1/blobs/fixture-site/site:fixture-store/bench/payload.bin`) {
    if (
      headers.get("authorization") !== "Bearer fixture-token" ||
      headers.get("accept") !== "application/json;type=signed-url" || init.body !== undefined ||
      method !== "GET" && method !== "PUT"
    ) throw new Error("Netlify benchmark API negotiation differs.");
    return Promise.resolve(Response.json({ url: data }));
  }
  if (url !== data || headers.has("authorization")) throw new Error("Netlify benchmark data authority differs.");
  if (method === "GET") {
    return Promise.resolve(
      new Response(new Uint8Array(stored), {
        headers: { "content-length": String(stored.length), etag: '"authored"' },
      }),
    );
  }
  if (method === "PUT" && init.body instanceof Uint8Array) {
    stored = new Uint8Array(init.body);
    return Promise.resolve(new Response(null, { headers: { etag: '"authored"' } }));
  }
  throw new Error("Netlify benchmark unexpected request.");
};
const client = createNetlifyClient({
  profile: NETLIFY_PROFILE,
  api,
  site: "fixture-site",
  store: "fixture-store",
  token: "fixture-token",
  fetch: transport,
  authorizeDataURL: (url) => url === data,
});
const put = await client.put("bench/payload.bin", original);
if (!put.modified || put.size !== original.length || put.work.requests !== 2) {
  throw new Error("Netlify benchmark PUT receipt differs.");
}
expectBytes(stored, original, "netlify/authored-transport-full-PUT");
const get = await client.get("bench/payload.bin");
if (get.state !== "present" || get.size !== original.length || get.work.requests !== 2) {
  throw new Error("Netlify benchmark GET receipt differs.");
}
expectBytes(get.bytes, original, "netlify/authored-transport-full-GET");
const copied = new Uint8Array(original);
expectBytes(copied, original, "netlify/owned-copy-lower-bound");
original[0] = 127;
if (get.bytes[0] !== 0 || stored[0] !== 0 || copied[0] !== 0) throw new Error("Netlify benchmark ownership differs.");
original[0] = 0;

// Different workloads: GET negotiates JSON, admits authority/headers/lengths,
// copies a synthetic body and retires readers. PUT snapshots input, negotiates,
// then the authored transport copies into its single stored object. The lower
// bound only copies trusted bytes. No SDK/live-service or exact-heap claim follows.
bench(`netlify owned-array copy lower-bound bytes=${original.length} requests=0 validation=absent`, () => {
  do_not_optimize(new Uint8Array(original));
});
bench(
  `netlify authored in-memory GET bytes=${original.length} requests=${get.work.requests} response=${get.work.responseBytes}B read-steps=${get.work.readSteps} network=absent`,
  async () => {
    do_not_optimize(await client.get("bench/payload.bin"));
  },
);
bench(
  `netlify authored in-memory PUT bytes=${original.length} requests=${put.work.requests} response=${put.work.responseBytes}B read-steps=${put.work.readSteps} network=absent`,
  async () => {
    do_not_optimize(await client.put("bench/payload.bin", original));
  },
);
await report();
