import { bench, do_not_optimize } from "mitata";
import { AmqpClient } from "../src/amqp.ts";
import { createAmqpReplay, prepareAmqpReplay } from "../tests/fixtures/amqp/replay.ts";
import { expectBytes, finish, report } from "./result.ts";

// Question: what does full AMQP admission add over a trusted fixed-layout read
// through the same fresh Webstreams? This is parser/ownership cost, not broker,
// TCP or TLS throughput. Setup and all fixture hashes are outside sampling.
const native = await prepareAmqpReplay();
const client = new AmqpClient({
  openChannel: async () => createAmqpReplay(native.take),
  auth: { user: "fixture", password: "fixture-only-amqp" },
  vhost: "/owned",
  allowPlaintext: true,
});
/** Fixed captured layout omits protocol and receipt validation deliberately. */
async function raw(): Promise<Uint8Array> {
  const channel = createAmqpReplay(native.take),
    reader = channel.readable.getReader(),
    writer = channel.writable.getWriter();
  let body: Uint8Array | undefined;
  let failures: readonly unknown[] = [];
  try {
    for (let index = 0; index < native.take.commands.length; index++) {
      await writer.write(native.take.commands[index]!);
      for (const frame of native.take.release[index]!) {
        const result = await reader.read();
        if (result.done) throw new Error("Native AMQP lower bound ended early.");
        // Frame six is the independently captured complete body frame.
        if (frame === 6) body = result.value.slice(7, -1);
      }
    }
    if (!body) throw new Error("Native AMQP lower bound lacks the original.");
    return body;
  } catch (reason) {
    failures = [reason];
    throw reason;
  } finally {
    await finish([() => channel.close(), () => reader.releaseLock(), () => writer.releaseLock()], failures);
  }
}
expectBytes((await client.take("owned", { autoAck: true }))!.bytes, native.original, "amqp/client/pika-original");
expectBytes(await raw(), native.original, "amqp/raw/pika-original");
const publisher = new AmqpClient({
  openChannel: async () => createAmqpReplay(native.publish),
  auth: { user: "fixture", password: "fixture-only-amqp" },
  vhost: "/owned",
  allowPlaintext: true,
});
const publication = await publisher.publish("owned", "key", native.original);
if (publication.confirmation !== "ack" || publication.returned) {
  throw new Error("Native AMQP publication preflight differs.");
}
bench(
  "amqp raw Webstreams take reply=688B original=6B lower-bound validation=none fresh-channel",
  async () => do_not_optimize(await raw()),
);
bench(
  "amqp client take reply=688B original=6B validation=frames+properties+ownership fresh-channel",
  async () => do_not_optimize(await client.take("owned", { autoAck: true })),
);
bench(
  "amqp client publish reply=650B original=6B mandatory+confirm+ownership fresh-channel",
  async () => do_not_optimize(await publisher.publish("owned", "key", native.original)),
);
await report();
