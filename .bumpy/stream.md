---
"@okikio/opfs": patch
---

### Wait for owned byte-stream retirement

An aborted file write now waits for its acquired producer cancellation and reader release before reporting its terminal
failure. Previously the wrapper could report an abort while native cancellation was still pending, and a second cleanup
request could return before that cancellation completed. Internal byte consumers now join one retirement result.

```ts
import { createFileSystem, FileSystemError } from "@okikio/opfs";
import { createMemoryAdapter } from "@okikio/opfs/adapter/memory";

await using files = createFileSystem(createMemoryAdapter(), { coordination: "local" });
const controller = new AbortController();
let cancelled = false;
const source = new ReadableStream<Uint8Array>({
  pull() {
    controller.abort("stop this write");
  },
  cancel() {
    cancelled = true;
  },
}, { highWaterMark: 0 });

try {
  await files.writeFile("/report.bin", source, { signal: controller.signal });
} catch (error) {
  if (!(error instanceof FileSystemError)) throw error;
  console.log(error.code, cancelled, source.locked); // aborted true false
}
```

When cancellation or reader release also fails, the filesystem error keeps its primary category, such as `aborted`, and
its cause retains all independently observed failures. Equal-valued failures from separate actions are still separate
events. Actual native EOF or read failure releases the reader without issuing a second cancellation that only repeats
the stream's stored error. A caller-owned reader lock is never taken by operation cleanup.

Streamed and async iterable write chunks must be genuine `Uint8Array` values, including when no signal is supplied.
Invalid JavaScript chunks reject and retire the acquired producer instead of being silently skipped. Materialized
`ArrayBufferView` inputs still use their raw byte range. Buffered fallback writes preserve their existing
`maxBufferedWriteBytes` policy and await producer retirement before reporting `too-large`; the payload limit is not an
RSS limit, and the completed buffer can coexist with retained chunk views.

Cancellation remains cooperative. A Web reader's `cancel()` promise joins physical cleanup even when the Web stream
closes pending reads earlier. An async iterator whose pending `next()` never settles cannot be interrupted merely by
queuing `return()`. This change adds no arbitrary cleanup deadline. Applications do not need a new option or internal
reader API; the internal reader and metrics owners share this lifecycle on their behalf.
