# Redis and Valkey byte commands

The native RESP2 client stores and retrieves bounded binary values through a connection supplied by your application. It
exposes one useful common wire profile for Redis and Valkey while keeping each server's qualification separate. It does
not translate keys into files, discover a server or provide a persistence guarantee.

Provide an `openChannel` function that acquires a new exclusive RESP2 connection. The adapter owns socket routing, TLS,
certificate validation and abort-aware acquisition. The client owns the returned channel and closes it on failure or
explicit disposal. This complete consumer function writes an empty binary key with a 30-second TTL, reads back the
bytes, observes the remaining TTL and closes the connection in `finally`:

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

The read is a later command. Another writer, eviction or expiry can change the key between the SET acknowledgement, GET
and PTTL. Neither the returned bytes nor the TTL observation establishes an immutable storage revision. Applications own
their key namespace and must select a server persistence and replication policy appropriate for their data.

The example preserves a local input failure if closing also fails. It skips a repeated close after a command has already
retired the connection, because that command has awaited cleanup and retained its failures. Re-awaiting the cached close
rejection in an unconditional `finally` could otherwise hide the command's original error.

## Binary keys and finite values

`get(key)` returns a private byte copy, or `null` when the key is absent. An existing empty value returns an empty
`Uint8Array`. Keys and values accept `Uint8Array` views, including the empty key, NUL, CRLF and non-UTF-8 bytes. The
client does not normalize, decode or join key components. Native RESP bulk-string lengths separate binary values from
command framing, so a value containing `\r\nDEL other\r\n` remains inert payload bytes.

The default and maximum selected key limit is 1 KiB; the value limit is 1 MiB. These are implementation safety limits,
not Redis or Valkey's full native string limits. `maxKeyBytes` and `maxBytes` can lower them. Caller byte views are
copied before asynchronous IO and before later option getters are read. Returned values belong to the caller. The first
profile materializes one value; it does not provide streaming values, ranges or a `ByteSource`.

`put(key, bytes, { mode, expiry })` issues SET. The mode must be `any`, `absent` (NX) or `present` (XX). It returns
`{ state: "stored" }` for the native OK receipt, or `{ state: "not-stored" }` for an NX/XX condition that was not met.
Those conditions test existence at the server, not the previous byte value or a revision. SET can replace a key holding
another native data type. There is no compare-and-swap, transaction or automatic retry.

Every write requires an explicit expiry policy:

| Policy                               | Native effect                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| `{ kind: "persist" }`                | No expiry modifier; a successful SET deliberately removes an old TTL.                    |
| `{ kind: "keep" }`                   | KEEPTTL retains an existing TTL. If NX creates a missing key, it does not acquire a TTL. |
| `{ kind: "relative", milliseconds }` | PX uses a positive safe-integer duration in milliseconds.                                |
| `{ kind: "absolute", milliseconds }` | PXAT uses a positive safe-integer Unix timestamp in milliseconds.                        |

An absolute timestamp in the past can acknowledge a SET whose key has already expired. The client does not acquire a
clock or reinterpret the server's expiry decisions. `RedisExpirySchema` owns this selected policy grammar; it does not
establish that an expiry will prevent eviction or survive server failure.

`ttl(key)` issues PTTL and returns one observed state: `missing`, `persistent`, or `remaining` with a canonical decimal
`milliseconds` string. Keeping the native signed-64-bit number as text avoids binary64 rounding. A remaining value of
`"0"` is distinct from missing. The observation does not pin the key, preserve its TTL or promise survival.

`remove(key)` issues single-key DEL and returns `true` for one removed key or `false` for no removed key. Deletion is
unconditional and cannot protect a newer writer, erase historical backups or establish durable erasure.

## Connection ownership and security

The supplied channel must be newly connected, exclusive and in native default RESP2 mode. It must have no earlier
commands, unread replies, client tracking or Pub/Sub state. This profile sends neither HELLO 3 nor RESP3, inline
commands, pipelines or automatic reconnects. Replies have no request IDs; correct association relies on this exclusive
channel and the native server command contract. Buffered unsolicited trailing bytes cause retirement; the protocol
cannot authenticate a malicious peer or independently correlate arbitrary delayed unsolicited replies.

`openRedisClient` copies optional AUTH password bytes and optional username bytes before acquiring the channel. Local
limits are 4 KiB for the password and 1 KiB for the username. It sends password-only AUTH when no username is supplied,
otherwise username/password AUTH. An optional `database` index sends SELECT after authentication; omitted leaves native
database 0. An explicit index is admitted locally from 0 to 65535, but the server's configured database count and ACLs
can reject it. Initialization failure closes the acquired channel. The client never discovers credentials, endpoint
variables, runtime sockets or TLS settings. AUTH is a native command, not transport encryption: the adapter must supply
an appropriately protected connection. Private auth packets remain in client memory; this implementation makes no
secure-memory erasure claim.

Successful acquisition transfers channel ownership before stream locks are acquired. The adapter's `close()` must be
idempotent, close the connection and retire pending reads and writes. Acquisition must honor its signal and close
partial or late connections itself instead of returning a live channel after cancellation. This client can bound its
wait for a broken adapter; it cannot force an arbitrary injected capability to release an external resource.

One operation runs at a time. A concurrent command fails with a busy error rather than joining a hidden queue. Capture
the result before submitting another command. `close()` and `Symbol.asyncDispose` share one completion promise, abort
the active operation, retire the channel and release acquired stream locks. Repeated calls retain the same cleanup
failure rather than pretending that a failed close succeeded. An idle lifetime signal is checked on the next operation;
callers must still close an idle client when they stop using it.

The default command/acquisition deadline is 30 seconds, with a local maximum of one day. `timeoutMs` applies to the
complete acquisition plus AUTH/SELECT sequence and separately to each later command. The default `cleanupMs` is five
seconds, at most one minute. These are finite local wait policies, not server-side command cancellation. The lifetime
signal and each operation's optional signal add cancellation. A pre-aborted operation and invalid local inputs dispatch
no command. Once an operation is admitted, failure retires the channel so a partial reply cannot become the next
command's reply. Cancellation after dispatch never establishes that a mutation had no effect, including a cancellation
observed after the complete native receipt was admitted.

Incoming chunks are capped at 64 KiB by default, at most 1 MiB; adapters must expose suitably bounded chunks. Reply
lines are capped at 1024 bytes by default, at most 8192. Seventeen consecutive empty transport chunks fail the progress
policy. Bulk lengths are admitted before value allocation; signed integer syntax and int64 limits are checked before
selective conversion. RESP arrays, RESP3 types, malformed CRLF and unrelated command receipt types are refused.

## Failure and recovery

`RedisError` reports a complete native error reply with a small selected code such as `NOAUTH`, `WRONGPASS`, `NOPERM`,
`WRONGTYPE`, `OOM` or `READONLY`; unknown codes become `OTHER`. Server reason text is omitted. These errors retire the
connection. `RedisProtocolError` reports unsupported framing or a local connection-state refusal. Arbitrary errors from
your injected adapter remain their original causes and can contain details supplied by that adapter.

`RedisPublicationError` has `outcome: "unknown"` and the dispatched `put` or `remove` operation. It means that no
attributable complete terminal reply was observed. Bytes may already have reached the server and changed the key. There
is no automatic retry. Reconcile using a newly acquired connection and your application ownership protocol. A later GET
alone cannot prove which writer produced identical bytes, whether an earlier DEL removed a replaced key, or whether a
timed-out NX succeeded and then expired. Preserve the original failure and make a new mutation only when your
application can accept that uncertainty. Independent cleanup failures are retained alongside the primary failure.

## Protocol sources and qualification

The selected common commands are specified by the official
[Redis RESP reference](https://redis.io/docs/latest/develop/reference/protocol-spec/),
[Redis SET reference](https://redis.io/docs/latest/commands/set/),
[Valkey RESP reference](https://valkey.io/topics/protocol/) and [Valkey SET reference](https://valkey.io/commands/set/).
The source research pins Redis 8.10.3 at `1a2574ce1551d3de6e0b4a56756c0fdbc6659e4f` and Valkey 9.1.3 at
`29173b67508b2de4c0f0ed551f3b47cf19fc3ca8`. Redis's native server license is separate from Valkey's BSD-3-Clause
license; no server implementation is copied into the production client. Production uses only project-owned protocol
code, existing byte/cleanup primitives and Zod.

Fourteen authored protocol cases passed separately on Deno, Node and Bun in a network-isolated 1 GiB runner, including
the initialization-abort regression. Formatting and lint also passed. The first genuine provider run passed both native
Redis 8.10.3 and Valkey 9.1.3 cases separately. Each compared all 128 KiB in both directions with independent redis-py
8.1.0 on Python 3.13.12, and consumed all bytes from the server's bundled CLI producer. The native cases also checked
empty and CRLF/NUL keys, authentication refusal, NX/XX conditions, KEEPTTL, explicit persistence, past PXAT, PTTL and
DEL.

The exact public image indices, actual arm64 image IDs/configuration, upstream server license bytes and independent MIT
SDK notice remain in `tests/fixtures/redis`. The wheel's 125 members were hash/CRC checked as inert acquisition data
before importing SDK code. Its inactive dependency markers are admitted as the exact eleven literal lines in that pinned
artifact, with Python 3.13.12 asserted before the native SDK import. Two earlier fail-closed inspection attempts are
retained in provenance: the raw wheel uses single quotes where PyPI's normalized metadata used double quotes. No general
dependency-marker parser or implicit dependency installation was introduced. The project ZIP reader is acquisition
tooling only. The independently implemented protocol oracle is redis-py and the native server CLI; this does not
establish independent archive-reader conformance.

Both native cases used a private disposable network, database 3 and fixture-only ACL credentials. Actual Docker readback
verified each server and SDK container at a 256 MiB RAM/swap ceiling, half a CPU and PID limit 128. The server had an
explicit 16 MiB temporary filesystem, persistence disabled and no host bind. SDK installation used only the pinned local
wheel without dependencies or extras; retries were disabled. All owned sockets, containers and networks closed before
the successful return, and the exact task-label query found no remaining containers. The original native log, version
receipts and resource readback are retained without rewriting server responses.

These runs qualify only this selected single-node wire profile. They do not establish persistence, replication,
eviction, TLS, cluster/Sentinel routing, Lua, transactions, scans, arbitrary command dispatch, streaming, Pub/Sub or
complete Redis/Valkey support. The separate native capture preserves both servers' raw replies and all six original SDK
bytes in `tests/fixtures/redis/independent.json`. A portable replay test checks both captured hashes, byte-fragmented
GET parsing and every original byte.

To repeat the authored runtime cases from a checkout with dependencies installed, run
`deno test --no-check tests/redis.test.ts`, `node --test tests/redis.test.ts` and `bun test tests/redis.test.ts`. These
are runtime checks; they do not replace the repository's separately isolated type/package gate.

The genuine provider cases run with `node --max-old-space-size=512 --test tests/redis-provider.test.ts` and require a
working Docker daemon plus access to the exact public image/wheel pins. They create only disposable test databases; do
not supply an existing Redis/Valkey endpoint. The reviewed resource, acquisition and cleanup recipe lives in
`tests/provider/redis.ts`, and the independent byte/condition assertions live in `tests/redis-provider.test.ts`.

## Captured-fixture overhead

`bench/redis.bench.ts` replays the unchanged 12-byte native GET response for the six-byte SDK value through two warm
Webstream channels. Before sampling it checks captured SHA-256 hashes, the exact request and all original bytes. The raw
lane copies a trusted fixed-offset payload; it is a lower bound without framing, signed-length, budget or deadline
admission. The client lane performs strict GET admission and returns private bytes. Both lanes include the same exact
request-byte check in the synthetic transport.

One representative Node 26.13.0 arm64 run in an offline 1 GiB RAM/swap-ceiling, one-CPU, PID-128 runner measured mean
0.735 microseconds for the raw lane and 23.147 microseconds for the client lane. These figures expose fixed in-memory
protocol and ownership costs for this tiny workload. They do not measure deployed Redis or Valkey throughput, TCP/TLS,
larger values, eviction or equivalent conformance. The first runner launch failed before TypeScript execution because
its command duplicated the image's shell entrypoint; the explicitly selected shell retry passed. Raw JSON, lossless
gzip, executed-input hashes and actual resource/exit receipts remain in the ignored implementation evidence referenced
by fixture provenance.

Run `BENCH_JSON=1 node bench/redis.bench.ts` with development dependencies installed to reproduce the workload. Use an
isolated quiet runner for comparable timing, and retain the full distributions rather than treating this single mean as
a performance guarantee.
