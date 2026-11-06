import { bench, do_not_optimize } from "mitata";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { createEtcdClient } from "../src/etcd.ts";
import type { FetchType } from "../src/request.ts";
import { expectBytes, report } from "./result.ts";
import fixture from "../tests/fixtures/etcd/independent.json" with { type: "json" };

// Question: what does one warm typed lookup add above raw Fetch/JSON/base64
// decoding of the same captured etcd3.7.3 gateway response? The raw lane is a
// lower bound: it omits lossless native revision, exact-key and cardinality
// validation. Neither lane measures a server, gRPC, quorum, network or TLS.
// The six-byte etcdctl original measures fixed control costs, not bulk transfer.
const envelope = new Uint8Array(decodeBase64(fixture.range.base64));
const oracle = new Uint8Array(decodeBase64(fixture.oracle.base64));
const key = new TextEncoder().encode(fixture.key), encodedKey = encodeBase64(key);
const endpoint = "https://etcd-bench.invalid/", url = new URL("v3/kv/range", endpoint);
const suppliedFetch: FetchType = async (input, init) => {
  if (String(input) !== url.href || init?.method !== "POST") throw new Error("Uncaptured etcd benchmark operation.");
  return new Response(envelope, { status: fixture.range.status, headers: fixture.range.headers });
};
const client = createEtcdClient({ endpoint, fetch: suppliedFetch, policy: { retries: 0 } });
const request = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ key: encodedKey, serializable: false }),
};
// This deliberately unchecked shape is confined to the trusted raw fixture
// baseline; it is not external data admission in the production client.
async function raw(): Promise<Uint8Array<ArrayBuffer>> {
  const data = await (await suppliedFetch(url, request)).json() as { kvs: { value: string }[] };
  return new Uint8Array(decodeBase64(data.kvs[0]!.value));
}
// Complete-byte and raw-capture hash preflights stay outside timed callbacks.
for (const [capture, bytes] of [[fixture.range, envelope], [fixture.oracle, oracle]] as const) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== capture.sha256 || bytes.length !== capture.bytes) throw new Error("etcd captured bytes differ.");
}
const first = await client.get(key);
if (first.entry === null) throw new Error("etcd fixture omitted its original value.");
expectBytes(first.entry.key, key, "etcd/client/exact-key");
expectBytes(first.entry.value, oracle, "etcd/client/etcdctl-original");
expectBytes(await raw(), oracle, "etcd/raw/etcdctl-original");
bench(
  `etcd raw Fetch+JSON+base64 envelope=${envelope.length}B original=${oracle.length}B lower-bound validation=none transport=in-memory`,
  async () => do_not_optimize(await raw()),
);
bench(
  `etcd client get envelope=${envelope.length}B original=${oracle.length}B validation=lossless-revisions+exact-key transport=in-memory warm-client`,
  async () => do_not_optimize(await client.get(key)),
);
await report();
