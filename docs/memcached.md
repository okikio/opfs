# Memcached byte values

Use this native client when an application owns a clean Memcached connection and needs opaque cache bytes with native
compare-and-set (CAS) conditions. CAS detects an item change. It is not a content digest, durable file version or
promise that the cache retains an item.

```ts
import { openMemcachedClient } from "@okikio/opfs/memcached";
import type { MemcachedOptionsType, MemcachedReceiptType } from "@okikio/opfs/memcached";

export async function replaceCachedValue(
  openChannel: MemcachedOptionsType["openChannel"],
  key: string,
  bytes: Uint8Array,
): Promise<MemcachedReceiptType> {
  const client = await openMemcachedClient({ openChannel });
  try {
    const previous = await client.get(key);
    return previous === null
      ? await client.put(key, bytes, {
        mode: "add",
        flags: 0,
        expiry: { kind: "relative", seconds: 0 },
      })
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

The caller supplies `openChannel`, which acquires a clean, exclusive connection represented by Web readable/writable
byte streams and an idempotent asynchronous `close`. Successful acquisition transfers that connection to the client;
explicit close, disposal or a protocol/transport failure retires it. The application owns routing, TLS certificates,
connection authorization and network policy. This client discovers no runtime sockets, hostnames, credentials or SDKs.
The writable side must transmit every byte in order, and close must retire pending reads/writes. Transport chunks may
fragment or combine wire data within the configured chunk limit. A completed stream write is not a server
acknowledgement; the client still waits for the native terminal reply.

It implements neither SASL nor Memcached's optional text-authentication extension. Do not deploy an unprotected cache
because the disposable fixture uses plain TCP.

The example returns the complete native receipt. An absent key can still be created by another client before `add`, and
an existing key can expire, be evicted or change before CAS. The caller decides whether to refresh, rebuild from its
authoritative data source or abandon the operation. Nothing retries automatically. This is a native cache client; it
exposes no record driver, filesystem projection, prefix listing or immutable byte source.

## Native keys, values and conditions

The selected classic ASCII profile accepts keys containing 1–250 visible ASCII bytes, without whitespace or controls. It
does not normalize, URL-encode or reinterpret punctuation. UTF-8/non-ASCII keys and the meta protocol's binary-key
extension are outside this profile. Values can contain every byte, including NUL, CR and LF. A declared value length,
not a search for CRLF inside the value, determines its boundary.

`get(key)` issues `gets` for exactly one item and returns `{ key, bytes, flags, cas }` or `null`. Empty bytes remain an
existing item. Returned arrays are caller-owned copies. Flags use the modern uint32 profile; older 16-bit-only servers
are not qualified. CAS remains a positive canonical uint64 decimal string and never passes through JavaScript Number.
The server must have CAS enabled. No response header, cache token or metadata proves a complete value's hash or
publisher authenticity.

`put(key, bytes, { mode, flags, expiry, cas? })` copies bytes and captures all options before asynchronous dispatch.
Every write explicitly supplies flags and expiry. Its native mode is:

| Mode  | Native command and effect                    | Terminal result                               |
| ----- | -------------------------------------------- | --------------------------------------------- |
| `set` | Store unconditionally                        | `stored` or `not-stored`                      |
| `add` | Store only when absent                       | `stored` or `not-stored`                      |
| `cas` | Store only for the supplied `cas` item token | `stored`, `exists`, `missing` or `not-stored` |

A CAS write replaces expiry and flags. Classic CAS has no preserve-expiry option; the example deliberately selects a new
five-minute duration instead of pretending to retain an unknown deadline. `not-stored` is a native acknowledgement,
usually an unmet `add` condition, and not an instruction to retry. Some failures can affect existing cache state; even a
complete error reply does not prove that the old item remains unchanged.

`MemcachedExpirySchema` owns the serialized expiry grammar. `{ kind: "relative", seconds }` allows 0 through 2,592,000
(30 days). Zero disables expiry but does not prevent eviction or removal. `{ kind: "absolute", seconds }` allows values
above 30 days through 2,147,483,647, interpreted as Unix timestamps. The pinned classic storage parser uses a signed
32-bit expiry even though flags are uint32; larger timestamps are refused before IO. The application owns that clock
decision. The client never converts between clock domains or silently changes a duration above 30 days into a timestamp.
There is no negative expiry, touch, lease, refresh or expiry-preservation operation. Native server time is coarse, and
this profile does not claim subsecond expiry precision.

`remove(key)` is native **unconditional** deletion: `true` for `DELETED`, `false` for `NOT_FOUND`. It has no CAS
predicate and must not be used as a conditional filesystem removal primitive. There is no flush, arbitrary range
deletion, history erasure or physical-storage reclamation API.

## Connection ownership, cancellation and limits

One command is active at a time. Concurrent requests fail as busy before dispatch and do not cancel the admitted
request. There is no hidden queue, pipelining, pool, reconnect or automatic retry. The channel must be exclusive and
start at a clean protocol boundary; the caller must not share it with another producer or consumer.

CRLF lines, native reply grammar, exact key, flags, length, CAS, payload terminator and final `END` are validated before
returning an item. Already-buffered trailing bytes cannot belong to another legitimate outstanding response and retire
the connection. This is not authentication against a malicious server. The classic protocol carries no request IDs, and
future unsolicited data cannot be proven absent by checking the current buffer alone.

`timeoutMs` bounds acquisition or one complete command (default 30 seconds, maximum one day). Caller/lifetime signals
add cancellation; preaborted work stops before acquisition or dispatch. Cancellation after dispatch can occur after the
cache has already changed. A malformed/lost terminal mutation reply raises `MemcachedPublicationError` with the
operation and original key. Reconcile cache and authoritative application state before choosing another operation; equal
bytes cannot attribute a concurrent writer.

Native `ERROR`, `CLIENT_ERROR` and `SERVER_ERROR` replies raise sanitized `MemcachedError`, omitting foreign reason
text. The connection is retired even for a known error reply. Independent cleanup failures remain aggregated beside the
original refusal; they do not relabel it as an uncertain publication. Caller-injected channel errors can contain their
own sensitive context, and original causes remain available. Library-owned messages omit value bytes; the uncertain
publication error deliberately retains the original key for reconciliation.

`cleanupMs` limits the wait for the adapter's close (default five seconds, maximum one minute). Close is idempotent and
shares its completion, including a failure, across explicit close and asynchronous disposal. It retires pending channel
IO before releasing reader/writer locks. The adapter must honor acquisition cancellation and retire partial or late
connections itself. A deadline bounds this library's wait; it cannot make an arbitrary broken adapter release resources.
If the adapter's close times out, the client still releases its locks, reports the failure and refuses reuse.

`maxBytes` defaults to and cannot exceed 1 MiB per materialized value. Server item limits include their own overhead and
can be lower. `maxChunkBytes` bounds an individual incoming transport chunk (default 64 KiB, maximum 1 MiB), while
`maxLineBytes` bounds an ASCII control line excluding CRLF (default 1024, maximum 8192). More than 16 consecutive empty
transport chunks are refused. Declared lengths are checked before allocating a value, and chunks are privately copied
before later consumption. Requests materialize bounded header/value framing; this initial profile is not a streaming
upload/download API. These implementation limits do not describe cache capacity, persistence or eviction policy.

## Contract and independent proof

The primary profile is Memcached 1.6.45 commit
[`2d51e364799bc9698bd4b11728ea978cea12da6e`](https://github.com/memcached/memcached/tree/2d51e364799bc9698bd4b11728ea978cea12da6e),
particularly its
[classic ASCII protocol](https://github.com/memcached/memcached/blob/2d51e364799bc9698bd4b11728ea978cea12da6e/doc/protocol.txt)
and BSD-3-Clause source license. Protocol bytes and licensing hashes are recorded in provenance. No production SDK or
third-party runtime dependency is introduced.

Twelve authored protocol cases passed on Deno, Node and Bun. They cover fragmented binary framing, empty versus missing
values, uint64 CAS/uint32 flags, native outcomes, caller snapshots, invalid framing/budgets, cancellation, exclusive
admission and cleanup failures. These protocol cases are not native-server qualification by themselves.

The native Testcontainers proof uses a pinned official Memcached server with UDP disabled, a private network and
ephemeral mapped TCP port. A separately implemented, test-only pinned `pymemcache` 4.0.0 oracle runs in an isolated
Python container with a hash-required, no-index/no-dependency wheel installation. Its default `noreply=True` is
explicitly disabled so writes must receive native acknowledgements. The exact wheel is hashed before bounded inert ZIP
inspection; existing project ZIP/native zlib are acquisition tooling, not an independent Memcached protocol oracle.
Inert acquisition passed: the exact 60,772-byte wheel contains 28 safe members totaling 258,914 expanded bytes, with
CRC/member hashes, matching Apache-2.0 license bytes and no declared dependencies. The native test passed with complete
128 KiB SDK-to-client and client-to-SDK bytes, maximum uint32 flags, real CAS/add outcomes, empty versus missing values
and unconditional deletion that preserves unrelated keys. Actual Docker readback confirmed a 128 MiB server and 512 MiB
oracle, each with 0.5 CPU and PID limit 128. All owned resources closed before successful return. A separate capture
preserves the exact 43-byte native `gets` reply and all six independent SDK bytes in
`tests/fixtures/memcached/independent.json`; raw hashes and acquisition history remain in provenance. No persistence,
production authentication/TLS, eviction ordering or sleep-based TTL behavior is qualified.

`bench/memcached.bench.ts` measures one warm `gets` over this captured 43-byte reply against raw Webstream write/read.
Both lanes compare complete bytes with the independent six-byte original before timing. The raw lane returns a trusted
view and omits framing, key/CAS/length checks, ownership copies and deadlines, so it is a lower bound rather than an
equivalent client. One quiet Node 26.13.0 arm64 Linux run in a network-disabled, mount-free container with 1 GiB RAM and
swap ceiling, one CPU and PID limit 128 recorded raw mean 0.571 µs (p50 0.500 µs; p99 0.875 µs) and client mean 28.803
µs (p50 15.584 µs; p99 74.084 µs). These fixed control/stream costs do not measure live cache, TCP/TLS or bulk
throughput. Raw distributions, input hashes and actual container state are retained in the benchmark receipt; provenance
records the losslessly compressed raw report hash. This is a baseline for later parser work, not an optimization claim
or CI performance threshold.
