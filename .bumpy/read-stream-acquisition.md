---
"@okikio/opfs": patch
---

### Own buffered reads before publishing their stream

Value-oriented backends, such as memory and record stores, expose a file as one materialized stream chunk. Previously
`openReadStream()` returned while an internal asynchronous `start()` was still reading the record. A caller abort could
reach both that pending adapter read and the returned stream wrapper, producing two synthetic aborted failures from the
same facade request.

The open promise now owns that materialization before publishing the stream. Opening a missing or malformed buffered
file rejects the open promise rather than publishing a stream whose first read discovers the acquisition failure. After
successful opening, one stream owner observes caller cancellation. Native streaming remains incremental and does not
materialize the body.

```ts
import { createFileSystem, FileSystemError } from "@okikio/opfs";
import { createMemoryAdapter } from "@okikio/opfs/adapter/memory";

await using fs = createFileSystem(createMemoryAdapter(), { coordination: "local" });
await fs.writeFile("/state.bin", Uint8Array.of(17, 31), { parents: true });
const controller = new AbortController();
const source = await fs.openReadStream("/state.bin", { signal: controller.signal });
const reader = source.getReader();
try {
  controller.abort("screen closed");
  await reader.read();
} catch (reason) {
  if (!(reason instanceof FileSystemError) || reason.code !== "aborted") throw reason;
  console.log(reason.cause); // "screen closed": one cancellation observation
} finally {
  reader.releaseLock();
}
```

Cancellation before opening reaches no adapter operation. Cancellation during a buffered read waits for that acquired
operation to settle, then refuses publication. An actual adapter rejection retains its own cause; checking a later
signal state does not replace it. When a native stream arrives after cancellation, the facade retires it once and joins
physical cancellation before rejecting. A failed retirement remains beside the acquisition failure in the normalized
aggregate cause, including an independently observed equal-valued, null or undefined failure.

This changes the buffered route's publication boundary, not its memory cost: it still materializes the selected range
and exposes one chunk, with no added byte copy. Open metrics now count a successful buffered acquisition only after that
materialization succeeds. Caller options are captured once and cancellation is checked before the next option or adapter
effect. Existing optimization switches continue to select native versus materialized routes.

An arbitrary backend that does not settle cannot be preempted by an AbortSignal. Opening and retirement may therefore
remain pending while the borrowed backend owns physical work. This change does not claim provider atomicity, a memory
ceiling, or a new cleanup-observer API.
