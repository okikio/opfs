import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { openRedisClient } from "../src/redis.ts";
import type { RedisChannelType } from "../src/redis.ts";
import { expectBytes, finish, report } from "./result.ts";
import fixture from "../tests/fixtures/redis/independent.json" with { type: "json" };

// Question: what does one warm strict GET add above raw Webstream write/read
// and a trusted fixed-offset copy of the same native reply? The raw lane is a
// lower bound, without framing, signed-length, budget or deadline admission.
// Six redis-py-original bytes expose fixed protocol costs, not live Redis or
// Valkey throughput, TCP/TLS costs, durability or equivalent conformance.
const capture = fixture.providers[0];
if (capture === undefined || capture.kind !== "redis") throw new Error("Redis capture is missing.");
const envelope = new Uint8Array(decodeBase64(capture.get.base64));
const command = new Uint8Array(decodeBase64(capture.getRequest.base64));
const key = new Uint8Array(decodeBase64(capture.key.base64));
const oracle = new Uint8Array(decodeBase64(fixture.oracle.base64));
for (
  const [record, bytes] of [
    [capture.get, envelope],
    [capture.getRequest, command],
    [capture.key, key],
    [fixture.oracle, oracle],
  ] as const
) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== record.sha256 || bytes.length !== record.bytes) throw new Error("Redis captured bytes differ.");
}
// This is the native six-byte fixture's exact framing, not a general parser.
expectBytes(envelope, new Uint8Array([36, 54, 13, 10, ...oracle, 13, 10]), "redis/native-envelope");

/** Each exact GET write supplies one unchanged borrowed native transport chunk. */
function channel(): RedisChannelType {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  return {
    readable: new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(bytes) {
        expectBytes(bytes, command, "redis/captured-request");
        controller.enqueue(envelope);
      },
    }),
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
const client = await openRedisClient({ openChannel: () => Promise.resolve(channel()) });
async function raw(): Promise<Uint8Array> {
  await rawWriter.write(command);
  const next = await rawReader.read();
  if (next.done) throw new Error("Raw benchmark stream ended.");
  return next.value.slice(4, 4 + oracle.length);
}
let primary: readonly unknown[] = [];
try {
  const first = await client.get(key);
  if (first === null) throw new Error("Native fixture GET is missing.");
  expectBytes(first, oracle, "redis/client/redis-py-original");
  expectBytes(await raw(), oracle, "redis/raw/redis-py-original");
  bench(
    `redis raw Webstreams envelope=${envelope.length}B original=${oracle.length}B lower-bound validation=none warm-channel`,
    async () => do_not_optimize(await raw()),
  );
  bench(
    `redis client GET envelope=${envelope.length}B original=${oracle.length}B validation=framing+length+ownership warm-client`,
    async () => do_not_optimize(await client.get(key)),
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
