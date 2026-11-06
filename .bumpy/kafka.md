---
"@okikio/opfs": minor
---

Append binary Kafka records and read explicit offsets from one selected partition.

The optional `@okikio/opfs/kafka` client keeps log semantics visible: reading does not remove a record, retention and
compaction remain broker policy, and the application owns the position it saves. An application can use the native
protocol without adding a broker SDK or projecting records into files.

This complete example accepts the application's channel opener. The topic already exists, and the opener must connect to
the selected broker, verify TLS and complete any SASL authentication before returning a fresh exclusive channel.

```ts
import { KafkaClient } from "@okikio/opfs/kafka";
import type { KafkaChannelType, KafkaReceiptType } from "@okikio/opfs/kafka";

export async function appendEvent(
  openChannel: (options: { readonly signal: AbortSignal }) => Promise<KafkaChannelType>,
): Promise<KafkaReceiptType> {
  const client = new KafkaClient({
    openChannel,
    topic: "owned-events",
    partition: 0,
    brokerId: 1,
    maxBytes: 256 * 1024,
    maxRecords: 100,
  });
  return await client.append([
    {
      timestamp: 1700000000000n,
      key: null,
      value: new Uint8Array([0, 255, 13, 10]),
      headers: [
        { name: "tag", value: new Uint8Array([1]) },
        { name: "tag", value: null },
        { name: "tag", value: new Uint8Array() },
      ],
    },
  ]);
}
```

The client copies records and nested bytes before the first asynchronous step. Null and empty values remain distinct;
header order and duplicate names are preserved. Offsets and timestamps remain bigint. Each operation acquires and
retires its own channel, checks fixed API versions and observes the configured partition leader before its selected
request. Advertised endpoints are metadata, never authority to connect or forward credentials.

Keep the acknowledged `baseOffset`, `count` and native timestamp evidence. `KafkaOutcomeError` means Produce reached the
writer without an admitted successful acknowledgment: reconcile using application IDs and log state before another
append. A complete nonzero broker response is also conservatively unknown. `KafkaCompletionError.receipt` retains a
known result after later cancellation or cleanup failed. There is no automatic retry, reconnect or exactly-once claim.

Use `offset("earliest" | "latest")` and `fetch(offset)` to read independently. Fetch validates the entire admitted page
before returning records or a cursor; compaction gaps and empty batches advance only through native batch boundaries.
Policy overflow or an incomplete tail returns neither a record prefix nor an invented cursor. The application owns
persisting the returned position and coordinating it with its own side effects.

The first profile is one partition with uncompressed, nontransactional, non-idempotent magic-2 CreateTime batches;
idempotent producer state, compressed records and LogAppendTime reads are explicitly refused. Native Java/candidate
full-byte append/read comparisons passed in both directions on one plaintext broker; a second run included public
metadata and earliest/latest offsets. Deno record/session controls passed separately. TLS/SASL, multiple brokers,
allocation measurements and current release package/CI gates remain distinct evidence. This adds no consumer groups,
filesystem driver or adapter. See the [guide](../docs/kafka.md) for complete reads, recovery diagrams, limits and proof
boundaries.
