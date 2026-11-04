---
"@okikio/opfs": patch
---

Request normalization also preserves the event that owns the failure. A concrete quota or permission rejection keeps
that category when caller cancellation is observed beside it, including equal-valued observations. An owned preparation
abort winner keeps `aborted` when its terminal observer fails; the complete aggregate stays in `cause`. Borrowed
aggregate shapes cannot grant that cancellation category.

### Keep storage failures and resource retirement failures inspectable

A rejected operation can have two distinct failures: the write or copy fails, then retiring its input or private stage
also fails. The caller now receives both events. Filesystem normalization keeps the primary category, such as `aborted`
or `not-supported`, and retains the complete owned aggregate as its cause.

```ts
import { createFileSystem, FileSystemError } from "@okikio/opfs";
import { createMemoryAdapter } from "@okikio/opfs/adapter/memory";

const fs = createFileSystem(createMemoryAdapter(), { maxBufferedWriteBytes: 2 });
const source = new ReadableStream<Uint8Array>({
  pull(controller) {
    controller.enqueue(Uint8Array.of(1, 2, 3));
  },
  cancel() {
    throw new Error("The application producer failed to retire.");
  },
}, { highWaterMark: 0 });
try {
  await fs.writeFile("/video", source);
} catch (error) {
  if (error instanceof FileSystemError) {
    console.log(error.code, error.operation, error.path);
    if (error.cause instanceof AggregateError) {
      for (const failure of error.cause.errors) console.error(failure);
    }
  }
} finally {
  await fs.close();
}
```

This value-store example exceeds the configured byte limit and also fails producer cancellation. The primary category
remains `too-large`; its cause exposes both events. A source that retires successfully leaves only the primary failure.

The category comes from the actual primary event recorded by this library's release owner. An arbitrary aggregate's
first error or `cause` does not grant that authority. Separate events remain separate even when both reject with the
same Error object, `null`, or `undefined`. An explicitly supplied undefined cause also remains an own property; omitting
the constructor argument leaves the cause absent.

Cause presence follows the native Error contract in both compiled JavaScript and runtimes that strip TypeScript. The
declaration adds no runtime field. A supplied cause uses Error options, including `undefined`, so the property is
non-enumerable instead of appearing in ordinary object keys. This matters when diagnostics distinguish an omitted cause
from an explicitly observed undefined rejection.

Record write admission now waits for input cancellation even when the configured mode or policy rejects the write.
Native facade writes join their exact byte owner after failed driver acquisition. Byte metrics use the same owned stream
lifetime instead of a detached transform pipeline. None of these paths can report retirement complete while their
physical cancellation is still pending.

The streaming copy fallback has the same rule. After acquiring a readable source, failure to acquire the destination
writer retires that source and waits for cancellation. A simultaneous caller abort and a producer cancellation failure
remain independently inspectable beside the destination failure.

Recursive copy and directory clearing join every admitted sibling before releasing their tree lock. A traversal can
reject with `undefined` or `null`; either value is a real failure, rather than evidence of success. Independent siblings
that reject with the same value remain two events. Delivery of one recorded child failure through the bounded queue's
race does not invent a third event. These operations are still partial mutations, so a caller must inspect the tree
before retrying after failure.

Repeated facade `close()` and asynchronous disposal calls now join the same adapter disposal outcome. A second close
cannot succeed while the first physical disposal is pending or after it failed. Closing stops new facade admission;
callers retain ownership of returned streams and file resources. Settle their work before closing a facade configured
with `disposeAdapter: true`.

Byte admission also distinguishes a genuinely empty view from a detached or resized out-of-bounds view. Both invalid
views can report zero `byteLength`, which previously let a host stream writer skip them as empty input. The shared check
uses intrinsic typed-array validation before native mutation; it reads no payload and makes no copy. The
[ECMAScript typed-array contract](https://tc39.es/ecma262/multipage/indexed-collections.html#sec-%typedarray%.prototype.at)
defines that backing-store validation. A caller still owns later mutations of borrowed buffers. Host replacement can
truncate before consuming input, so rejecting an invalid view does not promise rollback of the old file.

Preserving copy also distinguishes an owned stage from its old pathname:

```text
reserve private stage → copy bytes → move stage to destination
       │                    │                    │
       └── failure ─────────┘          successful move consumes the stage
       retire owned stage                         leave old name alone
       keep cleanup faults              a new entry there has a different owner
```

When publication fails, cleanup removes the retained stage and reports independent removal faults alongside the copy
failure. When a move succeeds, the stage has been consumed. A later entry at its old name belongs to someone else and
must not be removed by this operation. These rules preserve existing destination bytes on the declared preserving route;
they do not add transactions across unrelated adapters or protection against every external filesystem race.

Behavior controls hold rejected-input cancellation open, retain null and undefined cleanup reasons, inspect primary
categories and all causes, and recreate an entry at a consumed stage name. They also require the original destination
bytes to survive failed publication, hold destination-rejection cancellation and disposal open, and retain independent
concurrent and traversal failures. Passing these controls establishes those scenarios; final runtime, browser and
provider gates exercise the complete composed routes.
