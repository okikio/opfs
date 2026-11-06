# Write ZIP files incrementally

`createZipStream()` exports files without buffering their complete contents. Pipe the returned stream into a temporary
file or staged upload, then publish only after successful EOF. An error or cancellation can leave a valid-looking ZIP
prefix that has no complete directory.

```ts
import { createZipStream } from "@okikio/opfs/archive/write";

const encoder = new TextEncoder();
const archive = createZipStream([
  { name: "notes/", kind: "directory" },
  { name: "notes/readme.txt", source: encoder.encode("hello\n") },
  { name: "empty.txt" },
], { maxArchiveBytes: 8 * 1024 * 1024 });

// Supply an application-owned staged destination. pipeTo owns its normal close
// and abort behavior; publish the staged object only after this promise resolves.
await archive.pipeTo(stagedDestination);
```

The application supplies `stagedDestination: WritableStream<Uint8Array>` and owns its publication and abandoned-file
cleanup. The writer itself does not open files, discover credentials, or start uploads. A caller can compose its output
with an encryption stream, but ZIP password encryption and resumable encrypted uploads are separate protocols.

## Format and size policy

This profile writes single-disk ZIP32 using uncompressed STORED members, UTF-8 names, CRC32, and signed data
descriptors. The local header sets general-purpose bits 3 and 11. It leaves the CRC and sizes zero until the member's
descriptor, then records measured values in the final central directory. Entries can have unknown lengths because finite
policies stop them before ZIP32 fields overflow. The profile follows the local-header, descriptor and central-directory
rules in [PKWARE APPNOTE 6.3.10](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT).

| Input or policy     | Default   | Effect                                                             |
| ------------------- | --------- | ------------------------------------------------------------------ |
| `size` on an entry  | Unknown   | When supplied, both premature EOF and excess bytes fail.           |
| `maxEntries`        | 10,000    | Maximum admitted directory entries; cannot exceed 65,534.          |
| `maxDirectoryBytes` | 16 MiB    | Combined central records and retained ancestor-name byte budget.   |
| `maxEntryBytes`     | 64 MiB    | Maximum stored content for one entry.                              |
| `maxArchiveBytes`   | 1 GiB     | Counts headers, payloads, descriptors, directory and end record.   |
| `maxChunkBytes`     | 64 KiB    | Maximum admitted stream chunk and emitted payload chunk.           |
| `maxNameBytes`      | 65,535    | Maximum UTF-8 filename bytes.                                      |
| `maxPathDepth`      | 64        | Maximum path components and ancestor-index work.                   |
| `maxSourceChunks`   | 1,000,000 | Maximum payload chunks across all entries, including empty chunks. |

Entry/archive/directory byte policies cannot exceed `0xfffffffe`. The `0xffffffff` and `0xffff` sentinels are reserved
for ZIP64 and are never emitted. Metadata records may exceed `maxChunkBytes`; their separate filename/directory limits
bound them. Stream producers can allocate an oversized chunk before the writer sees it; the writer rejects it before
copying or forwarding. Materialized bytes are split into chunks within policy. CRC32 detects accidental corruption; it
does not authenticate a sender or prevent malicious modification.

ZIP64, raw DEFLATE or other compression, multi-disk output, passwords, encryption headers, comments, arbitrary extra
fields, custom permissions and timestamp preservation are unsupported. This profile uses 1980-01-01 00:00:00 timestamps,
regular-file mode 0644 and directory mode 0755. It does not read a clock or inspect the host filesystem. Equal ordered
inputs produce equal output across chunk splits.

## Feed files lazily and stop safely

An async entries iterator can open each source only as it is needed:

```ts
import { createZipStream } from "@okikio/opfs/archive/write";
import type { ZipWriteEntryType } from "@okikio/opfs/archive/write";

async function* entries(): AsyncGenerator<ZipWriteEntryType> {
  yield { name: "report.txt", source: await openReportStream(), size: 4096 };
  yield { name: "events.jsonl", source: await openEventStream() };
}
const controller = new AbortController();
await createZipStream(entries(), { signal: controller.signal }).pipeTo(stagedDestination);
```

`openReportStream`, `openEventStream` and `stagedDestination` are application capabilities. The report source must
produce exactly 4096 bytes. The events source has an unknown length but still has the configured entry/archive limits.
Sources are `Uint8Array` or `ReadableStream<Uint8Array>`; async byte iterators are not accepted by this profile.

Creating the output stream does not acquire the entries iterator. The writer acquires it on the first pull, serializes
one entry at a time, and acquires a stream reader only after yielding that entry's header. The output queue has zero
high-water capacity: the writer does not read the next source chunk until the consumer asks for another payload.
Producer streams may have their own queues, which remain outside the writer's control. Admission copies each delivered
payload chunk before computing CRC and forwarding it, so later producer mutation cannot change queued output.
Materialized sources must remain stable until their entry has been consumed.

The writer owns the acquired reader and entries iterator. On successful entry EOF it releases the reader lock. On
failure or cancellation it cancels the active source, releases the lock, then returns the entries iterator. Sources in
unreached entries remain caller-owned. Native source-read errors are terminal and do not cause another cancel attempt.
Cleanup errors remain observable, including an aggregate of an abort and an independent cleanup failure. External abort
waits for owned cleanup before error delivery. An async entries iterator must settle pending `next()` and `return()`
calls; JavaScript cannot forcibly settle a non-cooperative promise. No completion or cancellation guarantee closes a
borrowed provider client.

## Name safety and interoperability

Names must be NFC relative paths separated by `/`. Directories explicitly use `kind: "directory"`, end in `/`, have zero
size, and have no source. Missing file sources represent empty files. The writer rejects duplicate lowercase keys,
file/directory conflicts, links and special kinds, traversal, empty path components, absolute paths, backslashes,
colons, controls, unpaired surrogates, trailing dots/spaces and reserved Windows device components. It rejects instead
of silently renaming. Lowercase comparison is the documented collision policy, not a claim to model every target
filesystem's Unicode case equivalence. A later extractor must enforce its own target-specific policy too.

`tests/zip-write.test.ts` covers split-invariant output, CRC, descriptors, empty files, UTF-8 names, pull behavior,
mutation, cancellation, cleanup failures, budgets and refused names. The independent fixture below feeds emitted ZIP
bytes to CPython's standard-library `zipfile`, which verifies authored payloads, CRCs, flags and descriptor fields:

```sh
deno task test:archive:interop
```

The recorded local run used CPython 3.9.6: four entries, 485 bytes, SHA-256
`1e57289da471b461adffde9d698cd648f03f9277b46f5fe6973310faf206b1d2`, with result `passed`. The consumer script is
independent of OPFS's reader and writer. This establishes that exact small STORED/descriptors workload; it does not
establish ZIP64, compressed output, every external extractor, throughput, peak process memory, or installed-package
compatibility.
