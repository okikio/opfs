---
"@okikio/opfs": minor
---

Publish binary JetStream messages and retrieve acknowledged sequences through an explicit channel capability.

```ts
import { NatsClient } from "@okikio/opfs/nats";
import type { NatsChannelType, NatsMessageType } from "@okikio/opfs/nats";

export async function save(
  openChannel: (options: { readonly signal: AbortSignal }) => Promise<NatsChannelType>,
  token: string,
  bytes: Uint8Array,
  publishInbox: string,
  readInbox: string,
): Promise<NatsMessageType> {
  const client = new NatsClient({ openChannel, auth: { token } });
  const receipt = await client.publish("ORDERS", "orders.new", bytes, { inbox: publishInbox });
  try {
    return await client.get(receipt.stream, receipt.sequence, { inbox: readInbox });
  } catch (reason) {
    throw new Error("Publication was acknowledged, but the later read failed.", { cause: { receipt, reason } });
  }
}
```

The optional client uses native expected-stream publication and sequence-based retrieval. Each operation acquires and
closes one exclusive caller-supplied channel; importing it opens no connection or credentials. Applications own TLS,
stream provisioning, permissions, retention and unique reply inboxes. Native uint64 sequences remain decimal strings;
message bytes are copied and timestamps retain their original server spelling.

Publication is not retried automatically. Native deduplication is limited to the configured stream window. An unknown
publication outcome and an admitted result followed by cleanup failure have distinct errors; a later read failure must
not erase an already acknowledged publication. This is a native message client, with no filesystem projection or
background consumer. The [guide](../docs/nats.md) explains transport ownership, receipts, bounded framing and recovery.
