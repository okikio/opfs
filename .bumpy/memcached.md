---
"@okikio/opfs": minor
---

Read and conditionally replace opaque Memcached values over an explicitly acquired byte channel.

```ts
import { openMemcachedClient } from "@okikio/opfs/memcached";
import type { MemcachedOptionsType } from "@okikio/opfs/memcached";

export async function replace(openChannel: MemcachedOptionsType["openChannel"], key: string, bytes: Uint8Array) {
  const client = await openMemcachedClient({ openChannel });
  try {
    const previous = await client.get(key);
    return previous === null
      ? await client.put(key, bytes, { mode: "add", flags: 0, expiry: { kind: "relative", seconds: 300 } })
      : await client.put(key, bytes, {
        mode: "cas",
        cas: previous.cas,
        flags: previous.flags,
        expiry: { kind: "relative", seconds: 300 },
      });
  } finally {
    await client.close();
  }
}
```

The classic ASCII client preserves binary values, unsigned 32-bit flags and exact unsigned 64-bit CAS strings. Every
write explicitly replaces expiry and flags; expiry uses the pinned server's signed 32-bit storage parser. Successful
channel acquisition transfers ownership, and ambiguous replies retire the connection without automatic retry. A lost
mutation reply has an unknown outcome. Native server and independent pymemcache fixtures compare complete bytes and CAS
conflicts. This cache client supplies no persistence, filesystem projection, CAS-protected deletion or authentication
extension. The application owns transport security; the [guide](../docs/memcached.md) explains failure recovery and
limits.
