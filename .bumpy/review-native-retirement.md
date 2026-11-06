---
"@okikio/opfs": patch
---

### Retain native retirement failures and stop using consumed stage names

A failed host write used to lose its original reason when the file descriptor also failed to close. Other paths did the
opposite: source cancellation, OPFS staged abort and private-copy cleanup failures disappeared. Native writes now retain
the operation failure and every independently observed retirement failure. A sole reason keeps its exact identity;
multiple reasons remain in an `AggregateError`, including separate events that throw the same value. Reader EOF and
stored producer errors release the lock without manufacturing a second failure by cancelling an already-terminal stream.

For host copy, successful rename consumes the private stage name. Cleanup now skips that name instead of possibly
removing another entry recreated there. Link publication leaves the stage owned, so its removal is awaited and a real
removal failure rejects the copy. Destination bytes may already be visible when post-publication cleanup fails; retrying
a copy blindly would not establish what happened. Failed reservation never grants permission to remove a collision.

Browser OPFS positional writes also use the existing resource-local queue. For example, a close admitted after a write
waits for that write, and a later abort shares the same winning terminal action:

```ts
import { createOpfsDriver } from "@okikio/opfs/driver/opfs";

const driver = createOpfsDriver(await navigator.storage.getDirectory());
await driver.writeFile("/state.bin", new Uint8Array([0]), { mode: "replace" });
const file = await driver.openWritableFile!("/state.bin", { maxPendingBytes: 1024 });
const written = file.write(new Uint8Array([1, 2]), { at: 0 });
const closed = file.close();
console.log(file.abort("late cancellation") === closed); // true: close already won
await Promise.all([written, closed]);
```

The queue bounds accepted work on this file, not application publication across files. Ordinary operations after
terminal admission reject. A failed terminal action remains failed for repeated calls; queue settlement does not claim
successful native cleanup. Existing Node and Deno queues keep the same contract.

All native stream writers reject non-byte JavaScript chunks rather than silently omitting them. Genuine byte-array views
remain accepted. OPFS can abort its staged image before commit, whereas host replacement may already have truncated its
file before invalid input arrives. Neither path gains a provider-universal rollback or durability guarantee.

Authored controls use actual host stages and descriptors with injected independent faults, exact outside-entry bytes,
source lock state and held OPFS write/terminal actions. Structural OPFS controls prove the driver's ownership contract;
real browser behavior is a separate gate. No performance or fresh runtime result is inferred from these source changes.

Deno finite-range cancellation also waits for an admitted read after closing the descriptor. This prevents late
controller writes and early cleanup certification. A real close-induced read rejection remains retirement evidence,
rather than being filtered by an error name. Held-read controls distinguish descriptor close from read settlement and
preserve two independent failures even when their reasons are the same object.
