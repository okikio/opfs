# Storage ownership and publication

Start with the ordinary filesystem API. A file replacement copy preserves an existing destination until the new body is
ready; structural replacement of an existing tree requires an explicit application decision.

```ts
import { createFileSystem } from "@okikio/opfs";
import { createDenoAdapter } from "@okikio/opfs/adapter/deno";

const fs = createFileSystem(createDenoAdapter({ root: "./data" }));
try {
  await fs.writeFile("/draft.txt", "new result");
  await fs.copy("/draft.txt", "/published.txt", { overwrite: true });
  console.log(fs.inspect().adapter.publication);
} finally {
  await fs.close();
}
```

The following host guarantees require the admitted primitives for the configured root. The default native profile
assumes an ordinary volume; known mounted-client modes need an explicit [host profile](host.md). A declared unsupported
strong route rejects before metadata or staging. Explicit host `preserve:false` copy selects a direct writer and can
expose partial destination changes; it never retries a failed strong route.

`copy()` and `move()` validate the source before changing an existing destination. Native host copy reserves a random
sibling with exclusive creation, copies into it, and publishes by rename when overwriting or by hard link for
no-replace. An emulated host copy uses an exclusively reserved sibling and the same preserving rename route. A native
copy error therefore cannot truncate the previous destination. These routes avoid JavaScript materialization when native
copy is enabled. Emulation follows the selected stream/buffer limits and retains a staging file until publication.
Temporary cleanup after a failure is best effort; interrupted processes can leave owned staging files requiring explicit
application recovery. Names are random siblings, so a maximum-length destination name does not grow into an invalid
staging name.

A directory contains multiple publications. Replacing an existing tree, or changing a file into a directory, requires
`preserve: false` to choose best-effort recursive removal and copy. The default rejects this request with
`not-supported`. Use application-owned generation directories and a publication record when a multi-file result needs a
coherent revision. This file-level contract does not imply atomic multi-file publication.

`overwrite: false` rejects an observed destination. For independently racing owners, `exclusive: true` requests an
admitted atomic no-replace route. Host file copy supports it through hard-link publication. Portable host rename cannot
express it and rejects before mutation. Generic record/object fallbacks remain cooperative unless a stronger route is
explicitly advertised. `plan({ operation: "copy", path, destination, overwrite, preserve, exclusive })` evaluates those
requirements without storage I/O; a plan cannot establish whether a live destination currently exists.

Native publication facts can report `unsupported`; this does not forbid an explicitly admitted facade fallback.
No-replace facts are operation-specific. The aggregate uses the weakest admitted native operation and is unsupported
when none is admitted. A hard link alone does not establish copy no-replace: owned stage reservation and preparation
must also be admitted.

`inspect().adapter.publication` distinguishes copy and move preservation, operation-specific no-replace support, and
acknowledgement durability. Host mutation acknowledgement does not fsync both data and directory entries. Calling a
positional resource's `flush()` is useful but is not a universal crash-durable rename protocol. Provider guarantees are
also scoped to their own operation; see [publication receipts](s3.md) and [Azure upload behavior](azure.md).

## Positional resource ownership

One open resource orders complete writes, truncates, flushes, and its winning close or abort. The caller can use the
usual sequential style without configuring a scheduler:

```ts
const file = await fs.openWritableFile("/draft.bin", { create: true });
try {
  await file.write(new Uint8Array([1, 2]), { at: 0 });
  await file.truncate(2);
  await file.flush();
  console.log(file.inspect?.());
} finally {
  await file.close();
}
```

Default admission is 64 MiB of pending write buffers and 64 ordinary operations per resource. Options `maxPendingBytes`
and `maxPendingOperations` change these safety limits. Invalid limits reject before opening storage. Capacity rejection
reports `too-large` before admission; await existing work and retry. Retain the caller's buffer unchanged until its
write settles. The queue does not clone every large payload or establish an application-wide memory budget.

The first close or abort has a reserved terminal slot even when data admission is full. It waits for accepted work,
invokes the native terminal operation once, and releases the facade's file lock afterward. Later terminal calls await
that same result. A failed ordinary operation does not silently discard later accepted operations. Native error recovery
and application publication remain the caller's concern. Media staging/publication queues and cross-process storage
coordination retain their separate ownership; this resource queue cannot replace either.

Node and Deno synchronous reads set the cursor to the actual post-read file position, including EOF beyond the end. A
zero-byte read at offset 99 in a four-byte file leaves the cursor at four. Asynchronous Deno writes serialize their seek
and full native write as one resource operation. Convenience handle `seek()` and `truncate()` enter the same
`WritableStream` writer as `write()` and reject after abort, close, or stream failure.

## Physical host entries

Host structural operations use no-follow entry identity. Removing a directory link unlinks it rather than removing the
target's children. Recursive removal enumerates physical entries, including links and foreign kinds. `emptyDir()`
requires an ordinary directory and snapshots its direct children before deletion. A structural path with a stable link
ancestor rejects. Portable directory listing rejects entries it cannot represent instead of silently hiding them.

These checks do not establish a security sandbox against a hostile process swapping paths between checks and native
calls. Use trusted roots and an application or operating-system isolation policy for that boundary. Ordinary host byte
reads can retain native symlink behavior.

## Deno KV generation leases

The convenience adapter retains its concrete driver, so maintenance and live retention are reachable without
constructing a second owner:

```ts
import { createFileSystem } from "@okikio/opfs";
import { createDenoKvAdapter } from "@okikio/opfs/adapter/deno-kv";

const db = await Deno.openKv("./data.sqlite");
const adapter = createDenoKvAdapter(db, { prefix: "reports" });
const fs = createFileSystem(adapter);
try {
  await fs.writeFile("/report.bin", new Uint8Array(100_000));
  console.log(adapter.driver.maintenance); // configured policy, no I/O
  console.log(await adapter.driver.probe()); // live retained partition bodies
  let cursor: string | undefined;
  do {
    const result = await adapter.driver.collect({ ...(cursor === undefined ? {} : { cursor }) });
    cursor = result.cursor;
  } while (cursor !== undefined);
} finally {
  await fs.close();
  db.close(); // borrowed by default
}
```

The v3 physical namespace is `${prefix}:v3`. A generation has a durable owner token and state:

```text
writing --manifest CAS--> published --replacement/removal CAS--> retired
   |                                                         |
   +--------------- expiry/abort claim CAS -----------------+
                                  |
                              reclaiming
                                  |
                               reclaimed --retention CAS--> absent
```

Every immutable part insertion checks the writing state version, an absent part key, and aggregate accounting in one
transaction. Publication checks the original logical entry and new generation; retiring the predecessor shares that
transaction. Reader pins check the logical entry and published generation together. A collector claims only an eligible
state with zero admitted pins, then deletes parts while checking that claim and adjusting retained-byte accounting. Only
the claim's version change fences a suspended writer. A transaction prepared before a local deadline can commit after it
when no competing state change intervenes. Expiry is eligibility for revocation, not a timer that can remotely cancel a
transaction.

Defaults are 60-second writer/reader leases, 64 readers per generation, and 64 transaction retries. Supported readers
check the lease before and after each physical body fetch, renew while active, and release on completion/cancel. A
reader paused beyond its deadline can fail with `locked` and must reopen the logical file. Arbitrarily paused readers
are not promised indefinite retention. Bytes already delivered into a consumer's queue cannot be revoked.

A pin counter equals present admitted pin records, including expired pins until transactionally pruned. Pin records have
no database TTL. Create checks an absent token; release/prune checks a present matching token and the generation version
before decrementing once. Applied-but-unacknowledged operations reconcile using the same attempt identity. When
acquisition or cleanup cannot be reconciled, the driver retains its token, reports the failure, exposes `pendingReaders`
through `probe()`, and lets explicit maintenance retry cleanup. Collection can also recover expired records after a
process crash. Unknown publication is reconciled only through its own durable generation state, never by blindly
deleting a possibly published body.

When publication cannot prove its own outcome, `DenoKvCommitError` preserves the original failure in `cause` and reports
`effect: "unknown"`. Inspect the logical entry before choosing recovery; an automatic replay can replace a competing
publication. Inline replacement and deletion have no durable generation receipt, so a lost acknowledgement also stays
unknown. This error is exported from the Deno KV driver and adapter entrypoints.

`collect()` defaults to one hour of retirement grace and reclaimed-state retention, 10,000 part deletions, 20,000
state/part records scanned, and 1,000 pin records scanned per pass. It returns counts and an opaque continuation when a
bound stops the scan. Continue that cursor before starting another complete scan to avoid starving later paths. Listing
batches can observe concurrent mutations, so repeated complete passes are still needed for liveness. A zero grace does
not bypass writer ownership or reader pins. Part accounting is credited only when physical deletion commits; generation
capacity is credited only after the reclaimed state is removed.

Per-pass bounds do not bound total garbage when maintenance stops. Optional `maxRetainedBytes` and `maxGenerations`
provide atomic admission limits for partition bodies and generation records, including retained and reclaimed revisions.
All drivers sharing a namespace must use the same limits. Full admission fails with `quota-exceeded`; run maintenance or
move to a deliberately larger-policy namespace. These limits exclude inline records, provider serialization overhead,
and other application namespaces. Without limits, applications own aggregate quota and maintenance scheduling. Shared
accounting introduces a namespace transaction contention point; no throughput improvement is claimed.

`readOnly` prohibits logical mutations and collection. Partition reads still require private pin/accounting mutation; it
is not a promise of a physically write-free database session. Injected KV implementations must preserve strong exact
reads, atomic version checks, and native ordered tuple listing. These guarantees are grounded in
[Deno KV operations](https://docs.deno.com/deploy/kv/operations/) and
[ordered key space](https://docs.deno.com/deploy/kv/key_space/). Local runtime and fault-model tests do not establish
remote-service availability, clock synchronization, or provider-universal durability.

**Migration:** stop legacy writers, export the visible logical files with the old version, and import into a fresh
prefix with v3. Then switch consumers and explicitly retire the old namespace. A v3 owner refuses a prefix containing
legacy logical entries. Old generation-time collectors and v3 writers must never maintain the same physical layout.
There is no automatic destructive migration, hidden background timer, or caller-supplied generation resume API.

## Bridge identity and namespace ownership

```ts
import { createKeyValueBridge } from "@okikio/opfs/bridge/kv";

const kv = createKeyValueBridge(fs);
await kv.set("a::b", "exact empty segment");
await kv.set("a:b", "different key");
console.log(kv.inspect().namespace);
await kv.clear(); // owned values only; unrelated filesystem files remain
```

The generic bridge preserves exact JavaScript strings: empty keys/colon segments, percent/tilde literals, separator-like
characters, paired Unicode, and lone UTF-16 code units remain distinct. A canonical directory codec stores each value in
a private `value` leaf. Canonical re-encoding rejects foreign aliases and malformed encoded names during listing/clear.

The default root is `/.opfs-kv`, marked as `opfs-kv-v2`; `/` is rejected. First mutation claims an empty dedicated area;
a nonempty area lacking the marker requires explicit migration or another root. Reads and clear do not claim an unmarked
area. Clear snapshots valid logical membership and removes only owned leaves, retaining the format marker, foreign files
and malformed directories. Empty encoded directories can remain after removal. The namespace is exclusive among
cooperating owners; the marker is not a lock against an outside filesystem writer.

The unstorage bridge applies the ecosystem's key normalization before this exact codec. Repeated colons and slashes
therefore have unstorage's intentional normalized identity. `foo:` clear/list targets descendants while retaining the
exact `foo` value; generic `keys("")` targets the exact empty-key hierarchy, and generic `keys()` lists the owned area.
Inspect the chosen root and format before connecting a reverse bridge. Legacy default-root data needs an explicit export
and import into the dedicated area; clear never performs that migration.

Object adapters similarly reject a provider key that is both a file and a directory prefix, such as `a` with `a/b`.
Stat/list/write/remove report the ambiguity and preserve both physical objects. Resolve the provider layout explicitly
before using it as a canonical filesystem. Significant name whitespace remains identity; transport-normalized dot
segments are rejected before dispatch. Pure adapter plans translate virtual paths and prefixes to the actual provider
route, including disabled native stream/copy paths. A deterministic plan is admission guidance, not a live permission,
quota, existence, or connectivity probe.

Collection decides pin expiry from the exact pin version used by its deletion transaction. An expired listing snapshot
cannot authorize deletion after a concurrent renewal. Explicit reader release remains separate: its owner can release an
unexpired pin, and present-pin CAS still decrements the count exactly once. A lease deadline is local eligibility; only
changed state versions fence a previously prepared transaction. A renewal dispatched late can therefore succeed when no
collector claim changed its checked versions, and collection must retain that renewed record.
