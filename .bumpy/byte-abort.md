---
"@okikio/opfs": patch
---

### Share one abort signal across composed byte-stream layers

Cancel a streamed host write through the filesystem API:

```ts
import { createFileSystem } from "@okikio/opfs";
import { createNodeAdapter } from "@okikio/opfs/adapter/node";

await using fileSystem = createFileSystem(createNodeAdapter({ root: "./data" }));
const controller = new AbortController();
const response = await fetch("https://example.com/export.bin", { signal: controller.signal });
if (!response.ok || response.body === null) throw new Error("Export body is unavailable.");
const writing = fileSystem.writeFile("/export.bin", response.body, { signal: controller.signal });
controller.abort(new Error("The export is no longer needed."));
try {
  await writing;
} catch (failure) {
  console.log(failure);
}
```

The facade and native driver can both receive that signal. Previously, each byte-stream wrapper registered its own abort
owner. A single caller abort during a held source pull could therefore produce an aggregate containing two filesystem
abort failures. Its cause became another wrapper's failure rather than the caller's original reason, even when the
native producer cancelled successfully. This also affected writes through actual mounted object storage.

A live first-party reader chain now owns an exact signal once. Adding the same signal through the facade, driver or
bounded materialization reuses the existing stream. Byte counters stay in the chain and continue observing admitted
bytes. Coverage follows private, exact stream identities; matching error messages, matching reasons and stream-shaped
objects cannot grant it.

Reusing coverage retains the existing producer's error context. For example, writing a stream opened for `/source` to
`/destination` with the same signal does not turn that producer's `read` abort into a second `write` abort. Destination
failures still belong to the destination operation; the source's physical failure keeps its source path and operation.

```text
caller signal → one byte-stream abort owner → native producer
                         ↑
                  byte observations
                         ↑
                 facade / driver reuse
```

A different signal remains an independent cancellation owner, including when both signals carry the same reason.
Likewise, an actual producer-read, cancellation, reader-release or listener-detachment failure remains observable beside
the caller abort. Equal values, including `null` and `undefined`, do not collapse independent events. Calling native
`AbortController.abort(undefined)` uses the platform's default abort reason; the error retains the actual
`signal.reason`.

Signal coverage expires when the owning chain starts retirement. A wrapper that has already completed at EOF cannot
claim active cancellation coverage for a new operation. Unsignalled raw streams still receive byte validation and owned
reader retirement. No public option or driver contract changes.

Reader terminal observation and signal-listener setup now belong to the acquired reader's transaction. Setup refusal
cancels and releases that reader; listener removal is attempted after the physical retirement promise is cached. A
borrowed method which installs a listener and then throws cannot skip rollback, and a throwing removal cannot leave the
terminal read pending. Independent cleanup failures remain ordered beside the setup or abort failure.

Maintained controls use genuine native streams, held producer pulls, exact signal identity, intermediate observers, EOF
and early retirement. They check actual cancellation counts and unlocked source readers before fixture rescue. Native
method instrumentation exercises setup, detachment and release failures without replacing the underlying lock or
cancellation semantics. This is an ownership correction, not a measured performance claim: repeated same-signal
composition avoids another reader/listener wrapper, while a genuinely different signal retains its existing cost.
Cancellation still joins the producer's real promise. A producer whose cancellation never settles has no invented
interruption or deadline guarantee.

A borrowed reader's `read()` refusal does not prove that its native producer stopped. The owner now uses actual
`reader.closed` settlement for terminal proof, so a borrowed read method which throws or rejects before native reading
still cancels and releases the acquired source. The same rule prevents a fabricated `done: true` result from skipping
retirement while native `closed` is still pending. A method which starts native reading and then throws also retires
that acquired reader; its real pending read settles through native cancellation.

Stored read and closed failures are correlated only when the invoked method is the exact captured local native read
capability. Borrowed and foreign read methods remain supported and are still invoked. When their failure and a native
closed failure both occur, cleanup retains both observations without guessing from equal reasons. Those observations can
describe the same physical source event; their presence does not certify two independent producer failures. This
conservative distinction preserves an unknown method's actual refusal beside an independently errored source. Native
method controls cover pre-effect refusal, a started native read, equal-valued cancellation/release faults and an unknown
EOF result; genuine foreign-realm failure coverage requires the separate browser lane.

Borrowed read-result fields now form one snapshot inside the pending read transaction. The owner reads `done` and
`value` once and returns a fresh plain result, so a getter cannot escape through a later native pull or supply one value
for validation and another for publication. A getter which aborts and then throws retains its later fault beside the
actual abort while the source still cancels and releases. Synchronous byte observation also retains a later fault when
the observer starts that same stream's retirement and then throws; the deferred cleanup owner consumes the fault without
waiting on the pull which is already joining retirement.

Delivery correlation applies only to an actual exact-native read or cancellation rejection. A successful read followed
by a field-getter fault is a different observation, and a borrowed cancellation method which fails before native
cancellation cannot certify delivery of an already-published source error. Unknown and foreign methods keep their
conservative observation semantics. Maintained controls use real acquired native readers, actual source error state,
reentrant getters and self-retiring observers, with resource receipts asserted before fixture rescue.

A byte observer can synchronously abort the signal and then return its chunk. Each source-bound observation layer now
checks the upstream owner's claimed terminal state before publication, so that chunk cannot escape after abort. The
layer joins its immediate upstream owner's cached physical outcome and releases its own reader. Joining only the deepest
producer would leave intermediate readers locked. An observer which aborts and then throws retains that later fault
beside the already-claimed caller abort; retirement never waits on the active pull which is itself joining cleanup.

Source binding requires the exact captured native `getReader` method invoked on the exact source. Borrowed acquisition
can deliberately return another stream's reader. Such an acquisition stops inherited signal coverage and private
upstream terminal propagation, while the actual reader still receives its own cancellation and release. Its bytes and
EOF remain authoritative even when the original source's private owner has already failed. A layer's own signal still
covers the reader it actually acquired. This distinction also prevents an unrelated native read or cancellation from
marking an original source's equal-valued error as delivered.

A source-bound native rejected read of an actual private owner error publication and the cached physical outcome refer
to the same owned event. Cleanup uses that publication receipt once. Other read/acquisition methods retain their actual
observations conservatively; equal reasons never grant correlation. Maintained controls include zero, one and thirty-two
observation layers, synchronous abort followed by return or throw, equal-valued native cancellation/release failures,
and borrowed acquisition from an unrelated native stream. They assert native locks and all intermediate readers before
rescue. These controls and the separate genuine browser-realm lane cover different authority boundaries.

Closed observation now needs its own native state receipt. The owner snapshots the declared `closed` accessor before
invoking it, then uses the captured local native getter only as a branded identity probe. The declared promise must be
that same native state promise and its invoked `then` must be the captured local native method. This probe neither
substitutes another promise nor bypasses a borrowed getter or read method. Missing native proof keeps a valid borrowed
capability usable, but a borrowed getter, replaced `then` or foreign capability cannot certify that the underlying
native source stopped. A fabricated closed fulfillment therefore cannot skip cancellation of a live acquired reader.

A proven native closed failure can correlate with an actual local native read failure or a source-bound private owner
publication. Other closed failures remain separate observations, including a borrowed promise which rejects during
reader release. Equal reason values never supply this proof. An unknown or foreign closed observation and read can still
describe the same physical fault; preserving both reports uncertainty rather than certifying independent source errors.
Direct source-bound native read or cancellation delivery has its own receipt and does not require a caller to observe
`closed` first.

The work returned by the declared closed subscription is also an acquired operation. A returned PromiseLike rejection
starts retirement or remains alongside a primary which has already started retirement. Cleanup observes that work
immediately and joins it after cancellation and reader release, so release-dependent subscription work can settle.
Synchronous subscription refusal is retained once; a rejection callback followed by a separate throw retains both actual
events. Returned work never certifies producer EOF. Native closed rejection caused only by releasing that proven native
reader is excluded; an unknown declared closed rejection during release remains observable.

This adds native identity checks and one observer-work receipt per acquired reader. No new measurement or performance
threshold is claimed. Borrowed subscription work which never settles can hold cooperative retirement even after the
reader has been released; the library cannot invent a way to interrupt that work. Maintained controls cover false closed
fulfillment, proxy forwarding, native read/closed correlation, independently rejected observer children,
release-dependent children, late declared closed rejection and equal-valued read/closed/child events. They assert actual
cancellation, release and unlocked readers before fixture rescue; runtime and type gates assess these controls
separately.

Read and cancellation delivery also snapshot data-method provenance before declared access. A borrowed getter can
release its receiver, acquire a different reader on the same source, delete itself and return a native method. Invoking
that method on the old released reader can then reject independently of the original closed observation. Looking up the
descriptor after that getter, or checking only that the source is locked again, would grant false correlation. Only an
own exact native data method or the immediate local native prototype's exact data method grants this receipt; accessors
and unknown prototype chains remain invoked and keep conservative observations. The closed accessor follows the same
before-invocation rule, so deleting itself cannot turn borrowed effects into native state proof. Controls exercise
release, reacquisition and self-deleting getters. They distinguish the actual acquired reader's retirement from a
separate replacement reader deliberately retained by the fixture, and release that separate capability explicitly.

Delivery eligibility is monotonic for an acquired reader. Before invoking an unknown accessor or borrowed read/cancel
method, the capability gives up stored-event correlation. Restoring a native method later cannot restore that proof: the
earlier effect may already have exposed or released the reader. The declared closed promise's `then` also needs native
data-method provenance captured before access; a getter returning native `then` cannot grant native state authority. A
never-observed `closed` adds no requirement to a direct pure native call. Controls restore instrumented local prototype
getters and methods before a later public call, then check that an original private failure remains undelivered and that
separate released-reader faults remain observable. Unknown prototype intermediaries cannot advertise a native descriptor
as proof of their actual property lookup effects.

Iterable byte inputs use the same cancellation ownership principle. A borrowed iterator result can expose fallible
`done` and `value` getters, and even looking up `next` can run user code. Previously, a getter which cancelled the
stream and then threw could lose its fault because cleanup tracked only the earlier `next()` promise. A getter which
cancelled and returned could also cause another field access or an attempted late enqueue after cancellation.

The iterable owner now reserves its pending transaction before `next` lookup. That transaction includes actual `next`
settlement and one snapshot of each admitted result field. It checks cancellation after method lookup, settlement,
`done` and `value`, so a terminal winner prevents another borrowed effect or byte publication. Actual EOF reads `done`
only; an unused EOF `value` is not accessed and an already completed iterator needs no early-exit `return()`.

```text
next lookup / call → actual settlement → done → live value → byte validation → publish
          │                    │           │        │
          └──────── cancellation owns admitted effects ────────┘
                                      ↓
                         return() + pending snapshot outcome
```

Cancellation still attempts `return()` once and joins the admitted next/result transaction. It does not await the active
pull which is itself waiting for cleanup. A late next rejection, or a getter which cancels and then throws, therefore
remains in cancellation cleanup beside an independent `return()` failure. Equal values, including rejected `undefined`,
remain separate events. Consumer cancellation itself closes the native read; its cleanup promise carries these actual
retirement failures. A held arbitrary next or return promise remains cooperative and can keep cleanup pending; no
deadline or interruption capability is invented.

Finite controls cancel from method lookup, method invocation, `done` and `value`, with both return and throw outcomes.
They check each admitted field once, no post-cancel field access, actual iterator return counts, late rejection
retention and explicit consumer-reader release. Separate positive controls cover real EOF and a never-pulled iterator.
This changes ownership and publication behavior without introducing a new public iterator protocol or a performance
claim.

A native identity probe can fail by returning a rejected promise as well as by throwing. Its actual promise is now
observed immediately through the captured native settlement method, without looking up another borrowed `then`. A
different probe promise grants no declared closed authority and adds no invented source failure to the operation. The
caller's real read, declared closed and cleanup outcomes remain authoritative. Maintained controls retain exact native
rejection objects and their event order rather than assuming that every platform uses the same error subclass for reader
release; scoped descriptor instrumentation restores the complete original descriptor in `finally`.
