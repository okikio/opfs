---
"@okikio/opfs": minor
---

Publish confirmed AMQP messages and explicitly remove queued messages.

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

The native AMQP 0-9-1 client uses fresh exclusive caller-supplied channels and requires TLS unless plaintext is
explicitly admitted. Mandatory publication retains both the broker confirmation and any complete returned message. A
queue take requires autoAck: true because delivery can remove the message before the caller receives a result.
Applications own topology, TLS authentication, deduplication and recovery after uncertain effects; the client does not
invent filesystem semantics, reconnect or retry mutations.

See the [guide](../docs/amqp.md) for supported profiles, costs, ownership and verification limits.
