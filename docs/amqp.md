# AMQP publication and destructive queue reads

Publish bounded bytes to an existing RabbitMQ topology, or take one queued message with explicit permission to remove
it. The application supplies an adapter that opens and owns a fresh AMQP 0-9-1 connection; the client does not look for
sockets, URLs, credentials or a broker SDK.

```ts
import { AmqpClient, AmqpCompletionError, AmqpOutcomeError } from "@okikio/opfs/amqp";
import type { AmqpChannelType } from "@okikio/opfs/amqp";

export async function exchangeMessage(
  openChannel: (options: { readonly signal: AbortSignal }) => Promise<AmqpChannelType>,
  auth: { readonly user: string; readonly password: string },
  bytes: Uint8Array,
): Promise<Uint8Array | null> {
  const client = new AmqpClient({ openChannel, auth, vhost: "/owned" });
  try {
    const receipt = await client.publish("owned", "key", bytes);
    if (receipt.returned) throw new Error("Broker returned the unroutable message.");
    if (receipt.confirmation === "nack") {
      throw new Error("Broker negatively confirmed publication; routing may have partial effects.");
    }
    // The broker's queue and exchange already exist. This operation removes
    // whichever message is next; it need not be the message just published.
    const message = await client.take("owned", { autoAck: true });
    return message?.bytes ?? null;
  } catch (reason) {
    if (reason instanceof AmqpCompletionError) {
      // A complete native receipt survives a later cleanup failure. Record it
      // with the failure before deciding what your application should do next.
      throw reason;
    }
    if (reason instanceof AmqpOutcomeError) {
      // Do not automatically retry: either publication or dequeue may already
      // have happened. Application message IDs and broker topology own recovery.
      throw reason;
    }
    throw reason;
  }
}
```

The injected adapter must declare `security: "tls"` after authenticating the peer and completing TLS. Plaintext is
refused before the first protocol or credential write unless the caller explicitly selects `allowPlaintext: true`. That
option permits an unencrypted channel; it does not establish trust in its peer. PLAIN credentials are sent only over the
admitted channel. The adapter owns certificate checks and any routing or proxy policy. The client advertises RabbitMQ's
`authentication_failure_close` capability because it implements and sanitizes that native refusal; it does not interpret
a silent transport close as proof of an authentication error.

## What a result establishes

`publish(exchange, routingKey, bytes)` enables publisher confirms on its own channel and sends one mandatory
publication. A complete receipt retains the native `ack` or `nack`. A mandatory `basic.return`, if present, is read
completely and checked against the requested exchange, routing key and full body before its code, inert properties and
bytes are included as `receipt.returned`. RabbitMQ orders that return before its terminal confirmation. Only sequence 1,
or the native all-outstanding acknowledgement form, is accepted because this channel has exactly one outstanding
publication.

A confirmation does not establish consumer delivery. Persistence depends on the topology, queue type, message properties
and broker configuration. This profile publishes without message properties, so it does not request persistent messages.
A `nack` does not prove that nothing was routed: a message sent to multiple queues can have partial effects. An `ack`
alongside a return does not mean successful routing. The two observations remain separate.

`take(queue, { autoAck: true })` sends native `basic.get` with no-ack enabled. The broker may dequeue the message before
all bytes reach this client. The method therefore has mutation outcomes, despite the native method name `get`. It
returns a complete private byte array and inert property bytes, or `null` for one native empty response. A zero-byte
message is a message, not `null`. `remaining` and `redelivered` are native declarations, not a complete-backlog or
exactly-once guarantee. A delivery tag remains canonical uint64 decimal text; it is scoped to the now-retired channel
and cannot be acknowledged later.

There is no manual acknowledgement, consumer subscription, topology creation, transaction, reconnect, background retry,
deduplication, filesystem projection or AMQP 1.0 implementation. Delayed manual acknowledgement needs a separate owned
delivery/session lifetime; this per-operation profile does not pretend that a tag is portable between connections.

## Ownership, limits and failures

Each operation acquires one fresh exclusive `AmqpChannelType` and retires it, including on malformed peer data or
cancellation. A client admits one operation at a time and rejects concurrent calls without queuing. Separate clients do
not share a global pool. The adapter's `close()` must be idempotent, retire pending IO, and clean up late or partially
acquired connections if acquisition loses its abort race. A broken adapter can outlive the bounded wait; the client
cannot force arbitrary foreign code to release its resources.

The whole operation deadline defaults to 30 seconds and admits at most one day. It covers acquisition, authentication,
content, receipt and graceful protocol close. Physical retirement has a separate five-second wait, configurable up to
one minute, so an already-aborted operation still attempts release. Primary and independent retirement failures are
retained through the core close owner. Successful protocol close is followed by physical retirement; malformed or failed
operations retire physically without another request. Reader and writer locks are released even if retirement fails.

An `AmqpOutcomeError` means the mutating method reached transport write admission without a complete selected receipt.
Its `operation` distinguishes `publish` from `take`. It does not say a complete frame reached the broker. If a complete
mandatory return arrived before a confirmation was lost, `AmqpOutcomeError.returned` preserves that return as separate
evidence without inventing a confirmation. This conservative classification also covers native channel refusal after
method dispatch, since this narrow profile does not prove every broker error had no effects. An
`AmqpCompletionError.receipt` retains a complete confirmation, message, or empty result if later cancellation or cleanup
fails. Native refusal codes are exposed through `AmqpError` without the peer's potentially private reply text.
Caller-injected errors can themselves contain secrets; preserving the original cause is not a promise to sanitize
foreign error objects.

Names use a selected ASCII profile of letters, digits, underscore, dot, colon and hyphen, up to 127 bytes. The default
exchange is the empty exchange name. Vhosts use nonempty UTF-8 up to 127 bytes; routing keys use UTF-8 up to 255 bytes.
NUL and malformed UTF-16 input are refused before encoding. The combined PLAIN response has a 2 KiB implementation limit
so the initial 4096-byte frame policy can contain it. These are implementation safety limits, not claims that the broker
forbids every other valid name or credential.

Bodies are materialized with a default and maximum 1 MiB policy (`maxBytes` can lower it). Caller publication bytes and
credentials are privately copied before reading later publication option getters or asynchronous acquisition. Returned
and received bodies have the same bound. Incoming uint64 body lengths are checked before narrowing or allocating.
Transport chunks are capped at 64 KiB, negotiated frames at 4096–65536 bytes, and each operation admits at most 2048
frames and 128 heartbeat controls. Sixteen consecutive empty transport chunks are allowed. Outbound body frames respect
the negotiated frame size. This is bounded materialization, not a streaming upload or streaming consumer API.

Heartbeats use the same serialized writer as all methods. The positive local proposal defaults to 60 seconds and has a
maximum of 3600 seconds; negotiation uses the smaller positive peer value, or the local value if the peer proposes zero.
While waiting, the client sends at half the negotiated timeout and keeps exactly one pending transport read. The
operation deadline bounds silence; there is no separate assertion of broker liveness or background idle timer.

The fourteen Basic property positions and their flag word are validated before raw property bytes are exposed.
Continuation/reserved flags, truncated values, unknown field types, duplicate table keys and malformed UTF-8 short
strings are refused. Leading UTF-8 BOM characters remain part of native text identity; they are not stripped from
routing declarations or table keys. Nested table/array containers share a 1024-entry budget and depth limit 16, and each
declared container is at most 64 KiB and must end exactly. Native integer, timestamp, floating-point and decimal field
values remain inert bytes; there is no lossy conversion into JavaScript numbers. Binary long strings and byte arrays
remain binary. The same grammar checks the server's initial properties without treating them as discovery instructions.

## Sources and verification boundary

The historical selected profile passed a disposable RabbitMQ 4.4.0 check with Python 3.13.12 and independent Pika 1.4.4.
Pika seeded complete 6-byte and 128-KiB messages for this client to dequeue; this client then published both originals
for Pika to read and compare byte for byte. The same check covered an empty queue, a mandatory return with code 312
followed by an acknowledgement, a missing queue, and a refused password. Both containers retired without an
out-of-memory event or retained fixture resources. This plaintext fixture does not qualify TLS, persistence, clustering,
manual acknowledgements or AMQP 1.0. Compiler, package-artifact and CI evidence remain separate checks.

The current provider fixture replaces Python/Pika execution with a signed Debian rabbitmq-c client through an authored C
shim and TypeScript launcher. This changed native SDK profile passed its provider case against RabbitMQ 4.4.0, comparing
every byte of both 6-byte and 128-KiB originals in both directions. It also checked publication confirmation, mandatory
returns, empty and missing queues, and authentication refusal. Its native image and package/source receipts are separate
from the frozen Pika captures and receipts; neither profile is relabeled as the other.

The test fixture uses a durable queue because RabbitMQ 4.4 refuses deprecated nonexclusive transient queues by default.
Its broker data lives only in owned tmpfs, and the client still publishes nonpersistent messages. This setup makes the
fixture disposable; it does not establish durable message delivery.

The protocol source is the pinned
[AMQP 0-9-1 extended specification](https://github.com/rabbitmq/amqp-0.9.1-spec/blob/b8e975a762b8677263ebbbba1e70654b5263af81/xml/amqp0-9-1.extended.xml).
Publisher ordering and confirmation scope use the pinned
[RabbitMQ confirms guide](https://github.com/rabbitmq/rabbitmq-website/blob/978dfbce4d6451e8bbfd3abd7142f765ca7c022f/docs/confirms.md)
and
[native channel implementation](https://github.com/rabbitmq/rabbitmq-server/blob/24d5157cd415ef396c8ecd40a2d08c4d7ad3da9f/deps/rabbit/src/rabbit_channel.erl).
The bounded inert field grammar was checked against the pinned
[Pika field codec](https://github.com/pika/pika/blob/60fee4203a30d5dfa0500857cea6a65ef571d46c/pika/data.py), 9236 source
bytes with SHA-256 `8e81059008f55b057c73fd126ced2706c16b767f2a6caec0bf660ef2e015137d`. This implementation does not copy
server or SDK code. The specification XML has its own AMQP specification and BSD modification notices; the repository's
MPL notice is not a blanket license for all specification material.
