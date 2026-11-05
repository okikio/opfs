# Inspect a CPIO archive and read one file

Use a stable byte source to list an uncompressed SVR4 CPIO archive, then read one regular file. Listing reads headers,
encoded names and padding, and skips ordinary payload extents. It does not extract files or create host links.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openCpio } from "@okikio/opfs/archive/cpio";

export async function preview(archiveBytes: ArrayBuffer): Promise<void> {
  const archive = await openCpio(createBlobSource(new Blob([archiveBytes])), {
    maxSourceBytes: 4 * 1024 * 1024,
    maxRequests: 4096,
    maxDecodedBytes: 4 * 1024 * 1024,
    maxEntries: 10000,
    maxNameBytes: 65536,
    maxMetadataBytes: 1024 * 1024,
  });
  const entry = archive.entries.find((entry) => entry.name === "report.txt");
  if (entry?.kind === "file") {
    const preview = await archive.read(entry.id, {
      length: Math.min(4096, entry.size),
      maxSourceBytes: 16 * 1024 * 1024,
      maxDecodedBytes: 16 * 1024 * 1024,
      maxOutputBytes: 4096,
    });
    console.log(preview.bytes, preview.integrity, preview.dataEntryId, preview.work);
  }
}
```

`archiveBytes` is an application-supplied `ArrayBuffer`. A Blob source declares immutable bytes. Other sources must
declare `stability` or the caller must explicitly accept mutation risk with `allowUnverifiedSource: true`. An identity
string alone does not establish stable contents. Reopen a changed source instead of mixing offsets from an old index
with new payloads. The source remains borrowed; the archive does not close it or acquire persistent resources.

## Supported profile and entry identity

`openCpio()` accepts `070701` (newc) and `070702` (the historically named CRC profile). Numeric fields must contain
exactly eight hexadecimal digits. The reader requires a `TRAILER!!!` record with no payload, zero alignment bytes, and
only zero bytes after the trailer. It validates that tail within source/request budgets. This is a strict single-archive
profile: binary/odc CPIO, compressed input, concatenated archives, optional-trailer initramfs buffers and arbitrary
padding are unsupported. It is not an initramfs unpacker.

Names must be nonempty UTF-8 with one or more terminal NUL bytes. Interior NULs are refused. Raw entry IDs and duplicate
names remain distinct. Names are metadata, not trusted filesystem paths; traversal, absolute names and collisions need
an explicit policy before any filesystem projection.

Entries expose their original `mode`, ownership IDs, Unix-second `mtime`, inode, device pair and link count.
Directories, symbolic links, devices, FIFOs and sockets can be listed. Only regular-file payloads can be read. Symlink
targets are not loaded, followed or resolved, and special objects are never created.

Hard-linked regular files share `(deviceMajor, deviceMinor, inode)`. The index resolves that group only after the
complete scan because the payload can be on the last entry. `storedSize` remains the physical record's byte count;
`size` is the resolved logical file size, and `dataEntryId` names the physical data owner. A group with all zero-sized
records represents an empty file. A group with multiple nonempty records or disagreeing link count/mode/ownership/time
fails with `unsupported-profile`; the reader does not silently choose one copy. A link count may include names outside
this archive, so the reader does not require all declared links to appear. No host hard links are created.

## Reading costs and integrity

`read(id, { offset, length })` requires an exact logical range. Its returned byte array is bounded by `maxOutputBytes`.
For newc, integrity is always `none`: headers and payloads have no content checksum. For CRC, `verify` defaults to
`true`: the reader scans the entire data-owner extent in at most 64 KiB chunks, checks the unsigned byte sum modulo 2³²,
and retains only the requested interval. Thus a three-byte preview can read a large member, but it never scans unrelated
member bodies. `maxSourceBytes` and `maxDecodedBytes` admit that complete work before any output allocation. If the cost
is too large, increase the limits or explicitly select `verify: false` for an unchecked range with integrity `pending`.

`byte-sum-verified` covers the returned range's complete physical data-owner payload. It does not verify alias-header
fields, other member payloads, publisher identity or authenticity. The CRC profile's sum is not CRC32 and is weak
against intentional modification. Even matching sums do not make content safe to execute.

Default per-operation limits are 64 MiB requested source bytes, 4,096 source requests, 64 MiB inspected/decoded bytes,
and 16 MiB returned bytes. Opening also defaults to 100,000 entries, 64 KiB per encoded name, and 1 MiB cumulative
encoded names, including the trailer. Returned `work` separates source bytes, requests, inspected bytes and output
bytes. Indexed payload extents skipped by the parser are not counted as read. Alignment and the entire zero tail are
counted. `maxEntries` limits retained ordinary headers; the required trailer is separate. Use `createArchiveLedger()`
and the same `ledger` across open/read calls or nested readers when repeated calls must share an aggregate limit.
Counters describe requested archive extents, not opaque transport work inside a custom source.

Pass an `AbortSignal` to open/read. Each admitted source read receives it, and cancellation is checked again after
acquisition, including empty member reads. There is no background worker or promise to retire after the operation
settles. Original source failures keep their identity. Format, checksum and resource failures use `ArchiveError` codes;
applications can choose a different supported profile, reopen a stable source, reduce output, or explicitly raise a
budget.

## Browse admitted entries through the filesystem

```ts
import { createFileSystem } from "@okikio/opfs";
import { createBlobSource } from "@okikio/opfs/source";
import { createArchiveLedger, openCpio } from "@okikio/opfs/archive/cpio";
import { createCpioAdapter } from "@okikio/opfs/view/cpio";

export async function browse(archiveBytes: ArrayBuffer): Promise<void> {
  const ledger = createArchiveLedger({
    maxSourceBytes: 64 * 1024 * 1024,
    maxDecodedBytes: 64 * 1024 * 1024,
    maxOutputBytes: 1024 * 1024,
  });
  const archive = await openCpio(createBlobSource(new Blob([archiveBytes])), { ledger });
  const fileSystem = createFileSystem(createCpioAdapter(archive, {
    ledger,
    maxSourceBytes: 16 * 1024 * 1024,
    maxDecodedBytes: 16 * 1024 * 1024,
    maxOutputBytes: 4096,
  }));
  try {
    for await (const entry of fileSystem.readDir("/")) console.log(entry.name, entry.kind);
    const preview = await fileSystem.readFile("/report.txt", { at: 0, length: 4096 });
    console.log(preview);
  } finally {
    await fileSystem.close();
  }
}
```

`archiveBytes` is the application's `ArrayBuffer`. Construction validates the entire namespace before any payload read.
It refuses symbolic links, devices, FIFOs, sockets, duplicate paths, traversal, absolute paths and file/directory
collisions instead of silently dropping or replacing them. Applications can explicitly select a subset of indexed
entries before constructing a view, but that selection is their policy. Implicit parent directories are synthesized.
Resolved regular-file hard-link aliases remain regular virtual files; their reads use the same data owner without
creating host links.

The adapter provides stat/list/read only. Writes, removal and directory creation fail before consuming input. Reads past
EOF return an empty range; selected lengths clamp to the remaining logical file size. By default CRC prefixes still
verify the complete data-owner payload, even an empty range at EOF; a small returned range does not make verification
cheap. `verify: false` explicitly chooses unchecked ranges, and newc always has no content checksum. The filesystem
returns bytes without the archive reader's integrity/work result; use `archive.read()` when the application needs that
evidence. This view is buffered and makes no member-streaming claim. Closing it leaves the borrowed archive and source
usable. Cancellation uses the filesystem's `aborted` failure with the original signal reason as its cause.

## Format sources and independent evidence

The
[Linux kernel buffer-format description](https://www.kernel.org/doc/html/latest/driver-api/early-userspace/buffer-format.html)
explains SVR4 fields, alignment, additive checksums and late hard-link payloads. Its broader initramfs grammar is
intentionally outside this reader's profile. The
[libarchive CPIO producer tests](https://github.com/libarchive/libarchive/blob/master/libarchive/test/test_write_format_cpio_newc.c)
provide a second primary implementation reference; no upstream source is copied into production.

`tests/fixtures/cpio/create.py` invokes an independent installed `cpio` executable. Fixture JSON records its version,
command, archive digest, complete archive bytes, and full expected file payloads derived from input files. Corruption
fixtures in the test are labelled adaptations, not independent producer evidence. Runtime checks and package/type gates
provide different evidence; a source fixture pass does not establish installed-artifact behavior or real provider
performance.

The committed producer set includes bsdcpio 3.5.3 / libarchive 3.7.4 newc and GNU cpio 2.13 newc/CRC. GNU fixtures came
from Debian bookworm's `cpio` package `2.13+dfsg-7.1` for arm64 in a disposable bounded runner. The
[producer receipt](https://github.com/okikio/opfs/blob/69790448d046ea3316867f658f86b7c0357a7199/tests/fixtures/cpio/provenance.json)
pins the script and JSON file digests, commands, package version and exact archive digests:

| GNU profile | Archive SHA-256                                                    |
| ----------- | ------------------------------------------------------------------ |
| newc        | `93898c55a3055ebe922c8a2a87ac0c03828c0209beed5cd84be022f301dff03d` |
| CRC         | `71bfe57ecc34a7ce71ff213e07498e0894ec37df3e17c6d8c48443d388835e3b` |

The local base image ID in the receipt is not publicly pullable and does not pin the complete producer environment after
apt installs. Host inode/device numbers and symlink times can change regenerated archive bytes. The digests identify
these exact fixtures; full-payload expectations come from the original input files. Tests check every regular-file byte
from all three producer/profile combinations, including GNU's last-data hard links and CRC corruption beyond a selected
prefix. An altered alias checksum also demonstrates that content verification does not authenticate alias headers.

`bench/cpio.bench.ts` compares native Blob prefix reads with cold index, warm unchecked ranges, warm verified prefixes
and cold-index-plus-read operations. It uses the genuine GNU corpus's small binary member and 128 KiB member, checks
full payloads before timing, and labels source/decoded/output bytes and integrity differences. The native baseline omits
archive parsing, budgets and verification. Untimed preflight validates benchmark inputs and work counts; it does not
establish latency, throughput, retained memory, scaling or remote-provider performance.
