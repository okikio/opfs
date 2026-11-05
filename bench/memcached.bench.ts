import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { openMemcachedClient } from "../src/memcached.ts";
import type { MemcachedChannelType } from "../src/memcached.ts";
import { expectBytes, finish, report } from "./result.ts";
import fixture from "../tests/fixtures/memcached/independent.json" with { type: "json" };

// Question: what does one warm strict gets command add above raw Webstream
// write/read of the same native 43-byte reply? The raw lane is a lower bound: it
// omits framing/key/CAS/length validation, private copies and command deadlines.
// Six SDK-original bytes reveal fixed protocol costs, not live-cache throughput,
// TCP/TLS performance, eviction, durability or equivalent protocol conformance.
const envelope = new Uint8Array(decodeBase64(fixture.get.base64));
const oracle = new Uint8Array(decodeBase64(fixture.oracle.base64));
const command = new TextEncoder().encode(`gets ${fixture.key}\r\n`);
const valueAt = envelope.findIndex((byte, index) => byte === 13 && envelope[index + 1] === 10) + 2;
if (valueAt < 2) throw new Error("Captured Memcached header is missing.");
for (const [capture, bytes] of [[fixture.get, envelope], [fixture.oracle, oracle]] as const) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== capture.sha256 || bytes.length !== capture.bytes) throw new Error("Memcached captured bytes differ.");
}
// A clean exclusive synthetic channel enqueues the captured response once per
// write. Returning the trusted raw array models a borrowed transport chunk;
// the production client must take ownership before returning public bytes.
function channel(): MemcachedChannelType {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const readable = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write() {
      controller.enqueue(envelope);
    },
  });
  return {
    readable,
    writable,
    close: () => {
      if (!closed) {
        closed = true;
        controller.close();
      }
      return Promise.resolve();
    },
  };
}
const rawChannel = channel();
const rawReader = rawChannel.readable.getReader(), rawWriter = rawChannel.writable.getWriter();
const client = await openMemcachedClient({ openChannel: () => Promise.resolve(channel()) });
async function raw(): Promise<Uint8Array> {
  await rawWriter.write(command);
  const next = await rawReader.read();
  if (next.done) throw new Error("Raw benchmark stream ended.");
  return next.value.subarray(valueAt, valueAt + oracle.length);
}
let primary: readonly unknown[] = [];
try {
  const first = await client.get(fixture.key);
  if (first === null || first.cas !== fixture.cas || first.flags !== fixture.flags) {
    throw new Error("Native fixture identity differs.");
  }
  expectBytes(first.bytes, oracle, "memcached/client/pymemcache-original");
  expectBytes(await raw(), oracle, "memcached/raw/pymemcache-original");
  bench(
    `memcached raw Webstreams envelope=${envelope.length}B original=${oracle.length}B lower-bound validation=none warm-channel`,
    async () => do_not_optimize(await raw()),
  );
  bench(
    `memcached client gets envelope=${envelope.length}B original=${oracle.length}B validation=framing+key+CAS+ownership warm-client`,
    async () => do_not_optimize(await client.get(fixture.key)),
  );
  await report();
} catch (reason) {
  primary = [reason];
  throw reason;
} finally {
  await finish([
    () => {
      rawReader.releaseLock();
      rawWriter.releaseLock();
    },
    () => rawChannel.close(),
    () => client.close(),
  ], primary);
}
