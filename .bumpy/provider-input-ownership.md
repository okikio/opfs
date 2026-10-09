---
"@okikio/opfs": patch
---

### Stop stalled upload input and preserve publication facts through cleanup

Upload a native byte stream without buffering the complete file:

```ts
import { createS3Client } from "@okikio/opfs/s3";

const accessKeyId = Deno.env.get("AWS_ACCESS_KEY_ID");
const secretAccessKey = Deno.env.get("AWS_SECRET_ACCESS_KEY");
if (!accessKeyId || !secretAccessKey) throw new Error("S3 credentials are required.");
const client = createS3Client({
  endpoint: "https://s3.amazonaws.com",
  bucket: "application-files",
  region: "us-east-1",
  credentials: { accessKeyId, secretAccessKey },
  concurrency: 2,
});
const response = await fetch("https://example.com/export.bin");
if (!response.ok || response.body === null) throw new Error("Export body is unavailable.");
const receipt = await client.put("exports/current.bin", response.body);
console.log(receipt.size, receipt.etag);
```

Previously, a failed admitted part could remain detached while the pool awaited the next producer chunk. That could
leave the write pending, emit an unhandled rejection, and prevent multipart cleanup. The operation now owns the ordered
scheduler and the native input reader. Every mapper receives immediate terminal handlers; a real mapper failure stops
input admission, interrupts the pending native read, and joins all admitted work. Consumer return has the same join
obligation. It does not abort already admitted provider requests.

```text
source order → at most one pending read → at most concurrency admitted/results
                         ↑                              │
                         └── actual mapper failure ─────┘
                                      │
                           native input interrupt
                                      │
                        join input + admitted work
                                      │
                    reader release + safe remote cleanup
```

Completed results waiting for their turn remain inside the bound and are yielded in source order. Azure block lists
therefore preserve bytes when network completion order differs. This keeps resident chunk/result counts bounded; it is
an ownership and correctness guarantee, not a measured speedup. A custom async iterator with an uninterruptible pending
`next()` cannot acquire this native-read guarantee merely by exposing `return()`.

All streamed byte chunks must be genuine `Uint8Array` views with readable backing storage. Detached and currently
out-of-bounds resizable views are refused; genuine empty views remain valid. Admission cannot prevent a caller from
detaching or resizing borrowed backing storage after the check. Buffer, subclasses, offsets and cross-realm byte views
are accepted. Strings, ordinary objects, DataView, other typed arrays and tag spoofs reject before they can silently
publish an empty/truncated object. Read EOF/error is actual terminal evidence. Conversion failure cancels a readable
source; release and cancellation failures remain independent, including repeated equal values.

The rejection records actual observed events. A sole producer or cleanup reason stays exact, including `undefined` and
`null`. Mapper-only failures remain an operation-owned `AggregateError`; independent source, mapper and retirement
failures all remain inspectable. No error name, human message or aborted flag grants new cleanup/retry authority.

S3 final publication records its own dispatch/refusal/unknown/acknowledged state. A foreign CommitError during staging
cannot suppress required multipart abort. Conversely an owned unknown completion wrapped beside reader-release failure
cannot grant abort, and a valid completion followed by release failure cannot become unacknowledged. Put and multipart
copy use this state. Azure also derives known HTTP refusal from its actually returned response, rather than a foreign
provider error class. No publication is automatically replayed.

Deno KV's streaming lane uses the same interruptible input. Failed unpublished-generation cleanup and reader-pin release
are retained beside the original operation fault. Repeated pin release joins one physical result; it cannot resolve
while the first release is held or has failed. Only an actually acquired absent generation record allows idempotent
missing-state cleanup. Lookup and schema failures stay visible, while the in-memory writer owner is always retired.

Cancellation and provider SDK calls still require their real promises to settle. This adds no invented cancellation
capability or timeout for arbitrary sources/mapper callbacks, and does not establish the cause of historical mapped
Docker gateway connection timeouts.

Multipart allocation now has the same ownership boundary. The client captures a validated `UploadId` before response
retirement; a reader-release failure cannot erase that known remote allocation. Streamed put and multipart copy drain
input/work and abort once, while direct `createUpload()` aborts a validated allocation that it could not successfully
transfer. Cleanup uses a fresh bounded signal, and independent abort failure remains beside the original retirement
failure. Missing, nested, repeated or unexpected allocation acknowledgements do not authorize a guessed identity.

Materialized S3/Azure `put()` uses intrinsic byte admission too, so a genuine cross-realm `Uint8Array` no longer falls
through to stream acquisition. S3's public `uploadPart()` and the internal materialized part/block routes validate
readable backing before dispatch. Genuine empty views remain valid; detached and out-of-bounds views with the same
reported zero byte length reject instead of silently uploading an empty value. Buffer, subclasses and offset views
retain their exact bytes. This keeps the existing byte/stream union and raw request BodyInit contract; it adds no
BufferSource redesign, automatic retry or measured speed claim.

The scheduler also keeps iterator protocol completion separate from operation success. A rejected `next()` contains the
complete joined input/mapper/retirement outcome. Closing that already-completed iterator returns native `done: true`
instead of replaying the delivered failure. Otherwise consumers such as affected native `Array.fromAsync`
implementations can repeatedly call `return()` after each rejection and spin without delivering the original error.
Concurrent terminal calls during physical shutdown still join that real outcome; only later completed-protocol calls
avoid its replay. Every `return(value)` awaits its own supplied value, and a rejected value or a later `throw(reason)`
remains a fresh caller event. No original failure is erased, no cleanup is retried, and protocol completion is not proof
that the earlier write succeeded. The discriminator bounds close attempts while checking the complete original failure
independently.

Body admission also validates the native readable branch before applying an optimization refusal. A plain object or
`getReader`/`cancel` pretender no longer enters Azure disabled-block cleanup and creates a second synthetic cancellation
error. Both clients inspect the native stream brand without reader acquisition or bytes; foreign native prototypes
remain accepted where the runtime preserves the intrinsic native brand. A copied prototype which destroys the runtime
brand is not evidence of cross-realm support; maintained browser controls use actual iframe realms. Azure's disabled
real stream still awaits its one actual cancellation and retains an independent fault. S3's actual `delayedMultipart`
true/false modes share this admission; there is no invented multipart-disable option. Polyfills without native Web
stream slots are outside this byte/native-stream union, and raw request BodyInit is unchanged.

Low-level `request()` uses the same native stream admission for one-shot replay and Fetch duplex. A native stream with a
foreign prototype therefore still receives one attempt, including a retryable HTTP response. Azure Shared Key also
requires its explicit `content-length`; a changed prototype cannot bypass that signing requirement. These checks do not
consume the stream. The returned raw response still belongs to the caller.

Materialized shared-buffer and resizable-buffer byte views now receive a fixed ordinary byte copy before provider
hashing, signing and dispatch. Fetch BodyInit must accept the transmitted backing store, so genuine shared bytes must
not become an uncertain publication solely because Deno refuses their original backing. Fixed offset views over clean
local backing with its native prototype and no own metadata avoid this additional copy. Foreign, custom-prototype and
own-metadata backing also receives a clean wire copy because hosts can inspect its ordinary properties. A copy from
concurrently modified shared memory is not an atomic snapshot; the caller owns synchronization. This is a correctness
cost at the wire boundary, not a claim that all borrowed input is immutable.

Byte-range metadata now has the same native authority as byte admission. A genuine `Uint8Array` can have its own
`byteLength`, `buffer` or `byteOffset` property, and subclasses can replace `subarray` or iteration. Previously a
readable two-byte view with a shadowed zero length could send two native bytes while S3 signed the empty payload, Azure
prepared `content-length: 0`, and both clients returned a zero-size receipt. Chunking and buffered limits could also use
that false length. Admission alone was therefore insufficient.

The clients, byte owner, collector and chunker now capture the readable range through native getters and create a plain
fixed-length byte view before counting, slicing, observing or signing. Clean local fixed backing stays borrowed without
an extra byte copy. Shared, resizable, foreign, custom-prototype and own-metadata backing receives its clean fixed wire
copy before limits, credentials and publication receipts, so a credential callback cannot resize the source and change
the acknowledged size afterward. The copy is not a synchronization primitive for concurrent shared-memory writers.

```ts
const bytes = Uint8Array.of(7, 8);
Object.defineProperty(bytes, "byteLength", { value: 0 });
const receipt = await client.put("shadowed.bin", bytes, { size: 2 });
console.log(receipt.size); // 2: the native two-byte range owns length, hash and receipt.
```

Materialized filesystem `ArrayBufferView` inputs keep their raw-byte range, including `DataView` and other typed arrays.
Streamed chunks and materialized provider `put()` retain their narrower genuine `Uint8Array` contract; this adds no
accepted input kinds. Native unreadable backing still rejects. The ordinary fixed view remains borrowed: applications
must keep its bytes and backing valid while an operation uses them. These controls prove specific payload, limit and
receipt behavior; they do not claim an immutable snapshot of all borrowed input or a measured performance gain.
