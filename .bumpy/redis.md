---
"@okikio/opfs": minor
---

Use one bounded RESP2 byte client with independently qualified Redis and Valkey servers.

```ts
import { openRedisClient } from "@okikio/opfs/redis";
import type { RedisChannelType, RedisTtlType } from "@okikio/opfs/redis";

export async function save(
  openChannel: (options: { readonly signal: AbortSignal }) => Promise<RedisChannelType>,
  password: Uint8Array,
  value: Uint8Array,
): Promise<{ bytes: Uint8Array | null; ttl: RedisTtlType }> {
  const client = await openRedisClient({ openChannel, auth: { password } });
  const failures: unknown[] = [];
  try {
    const key = new Uint8Array();
    await client.put(key, value, { mode: "any", expiry: { kind: "relative", milliseconds: 30_000 } });
    return { bytes: await client.get(key), ttl: await client.ttl(key) };
  } catch (reason) {
    failures.push(reason);
    throw reason;
  } finally {
    if (!client.closed) {
      try {
        await client.close();
      } catch (reason) {
        if (failures.length) {
          throw new AggregateError([...failures, reason], "The operation and connection cleanup failed.", {
            cause: failures[0],
          });
        }
        throw reason;
      }
    }
  }
}
```

The caller supplies a new exclusive channel and credentials; the client owns the acquired connection. Binary keys and
values retain native NX/XX and explicit expiry semantics, including empty keys and values. PTTL remains an observation,
not a revision or survival promise. Complete native receipts differ from uncertain dispatched outcomes, which retire the
connection without automatic retry. Independent SDK and CLI fixtures compare complete bytes on both servers. There is no
filesystem projection, persistence or TLS qualification, transaction API, reconnect or streaming-value claim. The
[guide](../docs/redis.md) explains transport security, finite admission and application recovery.
