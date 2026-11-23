import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { createPubsubClient } from "../src/pubsub.ts";
import type { FetchType } from "../src/request.ts";
import { expectBytes, report } from "./result.ts";
import fixture from "../tests/fixtures/pubsub/independent.json" with { type: "json" };

// Question: what does one warm unary pull add above raw Fetch/JSON/base64
// decoding of the identical captured emulator reply? Raw is a lower bound:
// it omits lossless numeric/duplicate-key and delivery-token/calendar admission,
// actual control-byte budgets, private value ownership and deadline cleanup.
// A real pull mutates delivery state; this in-memory transport does not contact
// the service or acquire native delivery leases. Six original bytes isolate
// fixed control costs, not live message throughput, gRPC, IAM or processing.
const envelope = new Uint8Array(decodeBase64(fixture.pull.base64));
const oracle = new Uint8Array(decodeBase64(fixture.oracle.base64));
const endpoint = "https://pubsub-bench.invalid/";
const url = new URL(`v1/projects/${fixture.project}/subscriptions/${fixture.subscription}:pull`, endpoint);
const suppliedFetch: FetchType = async (input, init) => {
  if (String(input) !== url.href || init?.method !== "POST") throw new Error("Uncaptured Pub/Sub benchmark operation.");
  return new Response(envelope, { status: fixture.pull.status, headers: fixture.pull.headers });
};
const client = createPubsubClient({ endpoint, project: fixture.project, fetch: suppliedFetch });
const request = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ maxMessages: 1 }),
};
// This unchecked wire shape belongs only to the trusted fixture baseline.
async function raw(): Promise<Uint8Array<ArrayBuffer>> {
  const data = await (await suppliedFetch(url, request)).json() as {
    receivedMessages: { message: { data: string } }[];
  };
  return new Uint8Array(decodeBase64(data.receivedMessages[0]!.message.data));
}
for (const [capture, bytes] of [[fixture.pull, envelope], [fixture.oracle, oracle]] as const) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== capture.sha256 || bytes.length !== capture.bytes) throw new Error("Pub/Sub captured bytes differ.");
}
const first = await client.pull(fixture.subscription, { maxMessages: 1 });
if (first.length !== 1 || first[0]!.messageId !== fixture.messageId) {
  throw new Error("Pub/Sub captured delivery identity differs.");
}
expectBytes(first[0]!.bytes, oracle, "pubsub/client/SDK-original");
expectBytes(await raw(), oracle, "pubsub/raw/SDK-original");
bench(
  `pubsub raw Fetch+JSON+base64 envelope=${envelope.length}B original=${oracle.length}B lower-bound validation=none transport=in-memory`,
  async () => do_not_optimize(await raw()),
);
bench(
  `pubsub client pull envelope=${envelope.length}B original=${oracle.length}B validation=delivery+UTF8+budgets transport=in-memory warm-client`,
  async () => do_not_optimize(await client.pull(fixture.subscription, { maxMessages: 1 })),
);
await report();
