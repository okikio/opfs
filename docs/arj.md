# Preview STORED files inside an ARJ archive

Use `openArj` to inspect a stable single-volume archive and return selected file bytes without extracting host files.
This is the optional `archive-arj` catalog profile. It supports STORED members; it does not implement ARJ's historical
compressed, encrypted, multivolume, or recovery features.

```ts
import { openArj } from "@okikio/opfs/archive/arj";
import { createBlobSource } from "@okikio/opfs/source";

export async function preview(archiveBytes: ArrayBuffer) {
  const archive = await openArj(createBlobSource(new Blob([archiveBytes])), {
    maxEntries: 1000,
    maxHeaderBytes: 1024 * 1024,
    maxSourceBytes: 32 * 1024 * 1024,
    maxDecodedBytes: 32 * 1024 * 1024,
    maxOutputBytes: 1024 * 1024,
  });
  const entry = archive.entries.find((value) => value.kind === "file" && value.readable);
  if (!entry) return undefined;
  const result = await archive.read(entry.id, { length: Math.min(256, entry.size) });
  return {
    name: entry.name,
    comment: entry.comment,
    bytes: result.bytes,
    integrity: result.integrity,
    physicalBytesRead: result.work.sourceBytes,
  };
}
```

The default read checks the complete selected member's CRC32 before returning its prefix. For a 10 MiB STORED member and
a 256-byte preview, this reads and checks 10 MiB in chunks of at most 64 KiB and allocates only the selected 256-byte
result. The source implementation may own additional buffering. This is not authentication: a person who changes the
archive can also recompute its CRCs.

For an exact range with no full-member scan, pass `verify: false`. A partial result then reports `integrity: "pending"`.
A complete selection always verifies CRC32, even when that option is false. An unselected suffix corruption therefore
causes a default prefix read to reject, while a partial unverified read cannot detect it. Header CRC32s are mandatory
and independent of this option. Source failures retain their error identity; format/policy errors use
`ArchiveError.code`.

## Inspect metadata and nest a reader

`archive.name` and `archive.comment` describe the main header. `entries` contains one record per physical member,
including directories. IDs identify physical records, not decoded names: duplicate names are preserved. Each entry
exposes its physical header/payload offsets, original/stored sizes, raw method, host, mode and timestamp integers,
header CRC evidence and readability. Raw timestamp and mode values are not interpreted as UTC or POSIX values. `rawName`
and `rawComment` getters return independent byte copies. Names remain inert even if they contain separators, dot
components, or absolute-looking text. No API maps them into host paths or opens links.

The default decoder accepts ASCII only. `decodeName(bytes, role)` can supply a specific encoding interpretation for
names and comments; it receives an owned copy. Return a NUL-free string. Both raw bytes and decoded UTF-8 size must fit
`maxNameBytes`. No implicit codepage guessing, filename normalization or newline conversion occurs. ARJ text-type
payloads remain their exact archived bytes.

A member can supply the byte-source contract to another parser:

```ts
import { openArj } from "@okikio/opfs/archive/arj";
import { openZip } from "@okikio/opfs/archive/zip";
import { createBlobSource } from "@okikio/opfs/source";

export async function inspectNested(archiveBytes: ArrayBuffer) {
  const archive = await openArj(createBlobSource(new Blob([archiveBytes])));
  const entry = archive.entries.find((value) => value.name === "nested.zip" && value.readable);
  if (!entry) return [];
  const nested = await openZip(archive.member(entry.id, {
    maxSourceBytes: 4 * 1024 * 1024,
    maxDecodedBytes: 4 * 1024 * 1024,
    maxOutputBytes: 1024 * 1024,
  }));
  return nested.entries.map((value) => value.name);
}
```

The wrapper borrows the original source and derives identity from the captured physical extent, never the filename.
Partial nested reads do not prove a complete ARJ CRC. A nested parser's own checks do not authenticate the enclosing
archive. There is no archive resource to dispose; the caller still owns the original file, client, or other provider
resource. Closing a caller-owned resource can make later reads fail.

## Budgets and cancellation persist

Opening captures source methods, size, identity and stability, options, decoder, and external ledger methods before its
first suspension. A source must declare `immutable`, `provider` or `caller` stability, or the caller must explicitly opt
into `allowUnverifiedSource: true`. Identity alone proves neither stability nor authenticity. No stability label makes
caller-mutated bytes safe.

The opening byte/request allowances cover both indexing and all later reads. Read options add per-operation allowances;
they do not replace the opening allowances. A member wrapper adds its own lifetime allowances. External opening, member
and read ledgers compose with these owners, charging the same original ledger object once. Reservations precede
allocation and source I/O, including known full-member scans. They are not refunded after later refusal or failure.
Source counts are requested archive extents, not a promise about a provider's network traffic. Decoded work includes
checked/discarded bytes. Output counts the selected returned bytes. Directory indexing produces no payload bytes.

Defaults are 100,000 entries, 8 MiB aggregate serialized header bytes, 65,535 bytes for one basic header body, and 4,096
bytes per raw/decoded field. Shared archive limits default to 64 MiB source, 64 MiB decoded, 16 MiB output and 4,096
requests. Caller limits are finite nonnegative safe integers. They are admission policies, not hard heap, wall-clock or
scheduler guarantees. Headers and name snapshots can require multiple bounded copies; verified payload reads retain at
most one 64 KiB source extent plus the selected output, excluding provider-owned buffers.

Opening, member and per-read abort signals compose. Checks occur before effects, after foreign ledger callbacks, after
awaited reads and before result return. Cancellation is cooperative: a source must observe its signal for prompt I/O
retirement. The reader does not close a borrowed provider to force cancellation.

## Exact supported profile

Require physical signature `60 EA` at offset zero and a main header followed by a mandatory zero-size end header at EOF.
There is no SFX scanning, concatenation, trailing padding or repair. Basic header CRC32s, fixed-field bounds and both
NUL-terminated strings must validate. Supported fixed-prefix sizes are 30 or 34 for the main header, 30 or 46 for file
records. Unknown layouts and minimum decoder revisions newer than 11 refuse explicitly.

Only ordinary binary/text and directory kinds are indexed. Method 0 requires stored size equal to original size;
directories require zero payload. Known methods 1–4 can be indexed with checked physical extents but cannot be read. A
native producer may choose method 0 for small inputs even if method 1 was requested, so support is decided by each
actual record's method.

Any nonzero extension header refuses opening. Those extensions can carry UNIX special-file or other structural semantics
and are not silently discarded. Encrypted, continued, multivolume, chapter, backup, secure/recovery, dual-name, label
and UNIX special profiles refuse. Main/file flag meanings are checked separately. This is a selected implementation
profile, not complete ARJ conformance.

The grammar is grounded in the historical upstream open-source ARJ 3.10.22 serialization/reader and an immutable
independent XADMaster reader. No normative published ARJ specification was established during this work.
[Fixture provenance](../tests/fixtures/arj/provenance.json) records actual sources, package identities, original byte
oracles and proof limits; native tools are test-only and are never a library dependency.

The [focused benchmark](../bench/arj.bench.ts) records cold indexing, a native Blob range baseline, full/prefix CRC32
scans, a pending exact range, and cold open plus read. Full-original-byte preflight precedes timing. For its genuine
65,537-byte member, a verified 37-byte selection reads 65,537 bytes in two requests, while a pending 37-byte selection
reads 37 bytes in one request. These are distinct integrity contracts, not a universal speed comparison.
