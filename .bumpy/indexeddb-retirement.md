---
"@okikio/opfs": patch
---

### Join IndexedDB transactions before publishing their result

An IndexedDB request can succeed before its transaction commits. The driver now installs terminal observation before
object-store and request effects, and waits for the actual transaction `complete` or `abort` event. This applies to
`get`, `set`, `delete`, direct-child listing, and the transaction-backed file write. Reads and listings release their
transaction observation before returning stored values to the caller.

```ts
import { createFileSystem } from "@okikio/opfs";
import { openIndexedDbAdapter } from "@okikio/opfs/adapter/indexeddb";

const adapter = await openIndexedDbAdapter({ name: "project-files" });
await using fs = createFileSystem(adapter);
await fs.writeFile("/notes.txt", "Remember the transaction boundary.");
console.log(await fs.readTextFile("/notes.txt"));
// Remember the transaction boundary.
// Disposing fs releases the database handle opened by openIndexedDbAdapter.
```

The native transaction still supplies atomic replacement and same-store serialization for the driver's read-modify-write
file operations. These changes add lifecycle accounting; they do not turn several independent facade calls into one
transaction. They also do not promise strict disk flushing in every browser. `complete` acknowledges commit under the
browser's selected durability policy. See the
[IndexedDB transaction lifecycle](https://w3c.github.io/IndexedDB/#transaction-lifecycle) and
[durability options](https://w3c.github.io/IndexedDB/#enumdef-idbtransactiondurability), currently specified in the
IndexedDB 3.0 Editor's Draft.

A bubbling request `error` event is not sufficient to declare that the transaction aborted: the application can cancel
that event and let the transaction commit. The exported `committed(transaction)` helper now waits for actual `complete`
or `abort` and preserves caller-installed event attributes. `result(request)` acknowledges the request and also releases
its event observation; it does not acknowledge commit on its own.

```ts
import { committed, result } from "@okikio/opfs/driver/indexeddb";

const opened = indexedDB.open("native-records", 1);
opened.onupgradeneeded = () => opened.result.createObjectStore("entries");
const db = await result(opened);
try {
  const transaction = db.transaction("entries", "readwrite");
  const done = committed(transaction); // Install terminal observation before mutation.
  await Promise.all([result(transaction.objectStore("entries").put("hello", "greeting")), done]);
  // A successful request has now been followed by actual commit.
} finally {
  db.close();
}
```

`result(request)` also accepts a native request whose event already finished. It installs observation, reads the
declared `readyState` once, and admits the final `error` and, on success, `result` fields. That completed-state receipt
belongs to this acquired request; replay of its terminal event acknowledges the receipt without reading the fields again
or adding the same failure twice. A field getter that throws is an admission fault, not proof that the native request
failed. A transaction or internally opened database owner still joins its actual later terminal observation and retains
separately observed faults. The standalone helper acknowledges only the acquired request's observable result, including
a declared shadowed error field; it does not prove commit or own interruption of a caller's request.
`committed(transaction)` must be installed before terminal dispatch because native transactions have no equivalent
completed-state replay field.

### Keep the original failure when retirement also fails

Native APIs can be wrapped by application instrumentation. A wrapper can install a listener and then throw, or throw
while removing it. The driver reserves removal before each setup effect and attempts every reserved removal once. If
listener installation is refused, it also tries the declared `on*` event channel, preserves its prior handler and
receiver, and restores the original handler and own descriptor during retirement. The same native `Event` delivered
through both channels is one receipt; equal error values from different effects are separate observations.

A setup or operation failure triggers an attempted transaction abort. The abort event with null native transaction error
acknowledges that rollback; it is not an invented second failure. A separately observed request or transaction error,
abort-method refusal, handler fault, or removal failure is retained. One failure rejects with that original value;
several reject with an `AggregateError` in observation order, including actual null and undefined values. Its primary
remains available to filesystem error normalization.

An abort method that refuses before its native effect can leave a transaction or upgrade free to commit; connection
closure is not rollback of an already committed schema. A removal failure after successful commit does not mean that the
write was rolled back. Check the operation's actual storage outcome before retrying a write that failed during
retirement. Caller cancellation is checked at admission and recorded before abort is attempted; a reentrant options
getter cannot publish a new write after that cancellation was claimed.

The fallback also observes explicit PromiseLike work returned by its saved handler. It joins that work after physical
terminal observation, listener removal and unpublished connection closure. This is package retirement ownership, not a
claim that native event dispatch awaits async handlers. A handler that never settles can hold this cooperative join; it
must not await the very operation whose retirement is waiting for it. Plain return values remain inert, and the original
value still reaches native event dispatch, including false for cancellation. Callback rejection and a separate then
getter or invocation failure remain separate observations. The ownership boundary is the saved handler's returned
PromiseLike settlement and the direct then invocation. The invocation's own return value is outside that settlement
protocol and is not recursively followed. The first requested settlement adopts its resolved value:
`resolve(heldPromise)` keeps the join pending until that promise settles. A later resolve or reject cannot replace that
choice, while an actual synchronous then invocation throw is retained separately. The native fallback controls hold a
nested promise, verify that listener retirement and unpublished connection closure already occurred, and then release or
reject the nested promise before the operation settles.

An internally opened database remains unpublished until schema upgrade, open completion, observation retirement and
driver construction succeed. An upgrade failure attempts abort of the acquired upgrade transaction; a construction
failure closes the unpublished database handle. Each package-owned abort or close is attempted once, including when a
borrowed method performs its effect and then throws. A late open success following refused observation closes the
exposed handle rather than publishing a driver.

There is an operational limit when both declared observation channels refuse setup. The driver can attempt transaction
abort and retain best-effort hooks, but an open request has no cancellation API before its upgrade transaction is
acquired. An immediately rejected open Promise cannot certify the physical retirement of an unobservable pending request
or deliver a later cleanup failure through that same Promise. A borrowed capability that never exposes its terminal
outcome has no invented timeout or alternate native bypass. Injected databases remain caller-owned unless
`disposeDatabase` transfers ownership.

The maintained browser controls use actual IndexedDB databases, requests, transactions and AbortController signals. They
check original stored values after rollback, committed replacements, terminal event receipts, preserved handlers, all
removal attempts, raw equal-valued failures and unpublished connection closure. Source formatting and lint are separate
from those runtime controls; this note makes no timing, throughput or cross-browser pass claim.
