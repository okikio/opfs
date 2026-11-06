# etcd byte values

Use the native JSON gateway client when an application owns an etcd endpoint and byte keys. A modification revision is
an exact native concurrency token. It is not a file version, content digest or promise that historical bytes remain
available after compaction.

```ts
import { createEtcdClient } from "@okikio/opfs/etcd";
import type { EtcdReceiptType } from "@okikio/opfs/etcd";

export async function replaceValue(
  endpoint: string,
  token: string,
  key: Uint8Array,
  value: Uint8Array,
): Promise<EtcdReceiptType> {
  const client = createEtcdClient({ endpoint, credentials: () => token });
  const current = await client.get(key);
  if (current.entry === null) {
    return await client.put(key, value, { create: true });
  }
  return await client.put(key, value, {
    modRevision: current.entry.modRevision,
    lease: "preserve",
  });
}
```

The result has `applied: false` if another writer wins the native condition. The application decides whether to inspect,
merge or choose another operation; the client never refreshes a revision and retries a mutation automatically. The
example preserves an existing lease deliberately. It does not renew that lease: the key can still disappear when its
native lease expires.

This module is a native byte-key client. It exposes no record driver or filesystem projection. Mapping keys to paths,
directories and large-file layouts requires a separate application schema, ownership and lease policy.

## Keys, revisions and bounded reads

The client owns no cluster membership or login session. Configure one exact HTTPS API base ending in `/`, optionally
with a gateway prefix. A per-operation callback supplies the raw etcd Authorization token, not a Bearer wrapper or
username/password. The callback sees a detached URL and borrowed signal. HTTP requires explicit `allowHttp: true`, for
example for the disposable local fixture. All requests disable redirects and ambient cookies; no returned URL or
cluster-member advertisement grants another credential target. The native JSON gateway does not support TLS Common Name
authentication. A caller can inject a transport that owns TLS policy, but the client makes no TLS-CN claim.

Keys and values are byte arrays, not URL path strings. `get`, `put` and `remove` encode literal key bytes as canonical
standard base64 in the JSON request body. Empty keys are refused; empty **values** remain present and distinct from a
missing key. Arrays are copied before credentials are awaited. Returned key/value arrays are caller-owned copies, not
immutable verification objects. Changing them cannot change an already-created cursor or the native revision strings.

Native protobuf int64 and uint64 fields remain bounded canonical decimal strings throughout the client. This preserves
cluster/member IDs and revisions larger than JavaScript's safe integer range. Zod validates the selected native data; a
preceding bounded lexical parser rejects duplicate/prototype keys and unsafe bare numeric spellings before they can
round into accepted fields. Native int64/uint64 strings are never converted through `Number`. The control parser allows
at most 8 MiB text, depth 32, 100000 tokens and 2 MiB string tokens. Responses are server-trusted; no content hash or
publisher authentication is inferred from revisions.

`get(key, { revision? })` reads exactly one key. A missing key produces `entry: null`; an existing empty value produces
an entry with an empty byte array. Without `revision`, the request asks for a native linearizable current read. A
positive explicit revision selects that historical point, which the server can refuse after compaction or if it is in
the future. The single-node fixture cannot qualify a replicated deployment's availability or consensus behavior.

`list(prefix, { limit?, cursor? })` reads one sorted prefix page. The nonempty prefix is literal bytes; no implicit
whole-keyspace query is exposed. `limit` defaults to 100 and is capped at 1000. Each returned key must stay inside the
requested prefix/start and advance strictly. `count` is the native count for that request's remaining range, not an
unchanging total across pages.

If more keys exist, `next` contains the exact base64 prefix, an advancing start, selected revision and native cluster
ID. `EtcdCursorSchema` owns this serialized grammar; each call also checks it against the caller's actual prefix. Later
pages select the original revision and refuse cluster rebinding. The response header can describe a newer current
revision, so `page.revision` separately reports the selected point. Compaction can still invalidate a cursor; persisted
cursor data is not a durable snapshot, authentication grant or availability guarantee. There is no background iterator
or automatic traversal.

`ETCD_KEY_BYTES` caps keys at 4096 bytes. `maxBytes` caps individual materialized values, defaults to 1 MiB and cannot
exceed `ETCD_VALUE_BYTES` (1 MiB). Page decoded bytes are capped at 8 MiB, independent of per-value and control-text
limits; a response exceeding a bound fails instead of silently truncating. JSON gateway values are materialized and
base64 encoded, so this is not a streaming/large-file API. Client limits are separate from the server's request limit,
quota and deployment policy.

## Conditional mutations and leases

`put(key, value, { create: true })` uses a native transaction comparing the key's creation revision to zero. It creates
without a lease only if the key is absent. An existing key produces `applied: false`.

For an existing key, use `{ modRevision, lease }`. The native transaction compares its modification revision before one
put. The lease choice is mandatory:

| Choice     | Native effect                                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| `preserve` | Sends `ignore_lease: true`, preserving the current lease without acquiring or renewing one.               |
| `none`     | Sends `lease: "0"`, explicitly detaching the key from its current lease. The lease itself is not revoked. |

No arbitrary lease IDs, lease creation, keepalive, automatic retries or general transaction programs are exposed.
`remove(key, { modRevision })` conditionally deletes exactly that key. It never requests a prefix/range deletion.
Successful deletion requires a receipt acknowledging one removed key. Native history may remain after deletion; no
compaction, repository cleanup or physical-erasure guarantee is made.

`EtcdReceiptType` preserves `applied` and the native header. A failed comparison has an empty failure branch and does
not write anything. A successful native transaction receipt is an acknowledgement, not complete-byte digest verification
or universal deployed durability certification. A dispatched mutation whose response is lost, malformed or inconsistent
throws `EtcdPublicationError` with operation and original base64 key. Reconcile current bytes and revisions before
choosing another operation; a matching value cannot attribute which concurrent writer published it. A known native HTTP
refusal remains `EtcdError`, including when an independent cleanup error aggregates beside it. Library-owned messages
omit native response text, tokens and values. Injected Fetch/credential errors can themselves contain sensitive context;
their original causes are retained. Cancellation after dispatch can arrive after the native transaction has already been
acknowledged; it does not undo the write. If the caller receives no receipt, reconcile before another attempt.

The client owns each control response body until it is fully consumed or cancelled, before the operation settles.
Borrowed Fetch capabilities, their connection pools and credential providers remain the caller's responsibility. Keep
the supplied signal live throughout the call; a preaborted operation stops before credentials. Construction and imports
perform no provider I/O or global configuration.

## Contract and independent verification

The selected wire profile is based on etcd 3.7.3 commit
[`0a173d0410a96d01091b484daae81365bbcde57e`](https://github.com/etcd-io/etcd/tree/0a173d0410a96d01091b484daae81365bbcde57e):
[native RPC definitions](https://github.com/etcd-io/etcd/blob/0a173d0410a96d01091b484daae81365bbcde57e/api/etcdserverpb/rpc.proto),
[KV fields](https://github.com/etcd-io/etcd/blob/0a173d0410a96d01091b484daae81365bbcde57e/api/mvccpb/kv.proto) and
[JSON gateway documentation](https://etcd.io/docs/v3.7/dev-guide/api_grpc_gateway/). The gateway's HTTP error mapping
changed in 3.6; this profile does not claim compatibility with every historical proxy dialect.

`tests/etcd.test.ts` uses authored responses to exercise exact revision strings, empty versus missing values, lease
choices, detached credential/byte snapshots, cursor affinity, native condition failure, uncertain receipts and native
refusal plus cleanup failure. These are protocol cases, not independent native-service qualification.

The qualified disposable native recipe uses exact official release archive digests and standalone `etcd`/`etcdctl`
binaries in a pinned Node base that supplies a native shell and timeout. No npm modules or Go resolver runs. It verifies
archive hashes before bounded inert TAR inspection and copies only selected regular member buffers; it never extracts
archive paths onto the host. Inert acquisition passed for both Linux ARM64 and AMD64 archives: each has 48 members, and
the exact archive and selected binary hashes are recorded in `tests/fixtures/etcd/provenance.json`. The archives contain
no `LICENSE` or `NOTICE` file; the Apache-2.0 source license is pinned separately at the selected upstream commit. The
existing project TAR reader is acquisition tooling, not an independent etcd protocol oracle.

The genuine single-node test passed against official etcd 3.7.3 and its separately implemented `etcdctl` gRPC client. It
checks full binary bytes in both directions, existing-key creation refusal, stale revision comparisons, empty versus
missing values, explicit lease preservation/detachment, historical prefix continuation across current writes, exact-key
deletion and invalid-token HTTP 401. The CLI fixture uses literal UTF-8 argv keys and copied binary value files; it does
not qualify arbitrary NUL-containing CLI keys. Authored protocol cases separately exercise bounded byte admission.

The first native run exposed a real schema error: nested transaction KV headers contain only the revision, while the
outer header carries cluster/member/term. The repaired client validates these distinct roles and refuses mismatched
nested revisions or supplied nonzero authority fields. Both the first failure and the exact native diagnostic remain
recorded in provenance. This behavior also follows the pinned
[native transaction implementation](https://github.com/etcd-io/etcd/blob/0a173d0410a96d01091b484daae81365bbcde57e/server/etcdserver/txn/txn.go).

`tests/fixtures/etcd/independent.json` preserves the actual 247-byte gateway range envelope and complete six-byte CLI
original as base64 with SHA-256 hashes. The capture's cluster/member IDs and HTTP headers are disposable service
evidence, not publisher authentication or stable replay identity. This single-node proof does not qualify production
replication, TLS deployment, lease expiry timing, compaction recovery or durability after failures.

`bench/etcd.bench.ts` compares raw in-memory Fetch/JSON/base64 extraction with the typed client over these exact
captured bytes. The raw lane is a lower bound that omits lossless revision and exact-key/cardinality validation.
Full-byte/hash preflights precede timing. One quiet Node 26.13.0 ARM64 Linux run, limited to 1 GiB and one CPU with no
network or host mounts, measured means of 18.12 microseconds for the raw lower bound and 57.40 microseconds for the
validated client. Native Mitata distributions, input hashes and actual resource/exit receipts are retained losslessly
and recorded in provenance. Neither lane measures etcd, gRPC, quorum, network/TLS or bulk transfer; the fixed cost of a
six-byte fixture does not predict deployed service latency.
