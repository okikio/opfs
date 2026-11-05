# Preview files inside an ISO image

An ISO reader follows one explicitly selected directory tree and reads selected file ranges. It does not mount the
image, execute boot records, or resolve names against the host filesystem.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openIso } from "@okikio/opfs/archive/iso";

export async function preview(image: ArrayBuffer): Promise<Uint8Array | undefined> {
  const archive = await openIso(createBlobSource(new Blob([image])), {
    namespace: "joliet",
    maxEntries: 10000,
    maxDirectoryBytes: 1024 * 1024,
    maxSourceBytes: 2 * 1024 * 1024,
    maxRequests: 1024,
  });
  const file = archive.entries.find((entry) => entry.kind === "file" && entry.size > 0);
  if (!file) return undefined;
  const result = await archive.read(file.id, {
    offset: 0,
    length: Math.min(file.size, 4096),
    maxSourceBytes: 4096,
    maxDecodedBytes: 4096,
    maxOutputBytes: 4096,
    maxRequests: 1,
  });
  return result.bytes;
}
```

`namespace: "primary"` is the default. It keeps ASCII identifiers literally, including `;1` version suffixes. Joliet
selects a supplementary descriptor with a recognized UCS-2 escape sequence and decodes UCS-2BE names. It rejects odd
byte lengths and surrogate code units; this is not a UTF-16 extension. Multiple recognized Joliet trees are refused
rather than silently choosing one. Names from different trees are never merged or used to infer identical file
identities. Each ordinary directory record receives its own `id`, even when file extents are shared. `parentId: -1`
means an entry directly under the selected root. Structural self/parent records are validated and omitted from entries.
Names are inert components. Consumers must apply their own safe projection policy before using them in another
namespace.

## Supported image profile

The reader accepts one volume in a single-volume set with 2048-byte user-data sectors and 2048-byte logical blocks. The
descriptor sequence begins at sector 16 and must contain a primary descriptor and terminator. Both-endian numeric copies
must agree. Declared extents must fit both the selected volume and captured source size. Primary and selected volume
geometry must agree. The reader follows directory records; path-table extents are checked, but path-table contents and
sort order are not semantically cross-validated. This is a bounded preview profile, not full ECMA-119 conformance
certification.

Rock Ridge remains an explicitly unsupported namespace. Primary mode does not interpret SUSP/Rock Ridge system-use
bytes, POSIX types, alternate names, symlinks, relocation or compressed-file extensions. Its file bytes are the physical
ISO extents, not a promise of a Rock Ridge logical file. An ISO file representing a symlink in an ignored extension is
never treated as a host link. Choose a reader implementing that extension if those logical semantics are required.

Interleaving, extended attribute records, associated/record/protected files, multi-extent files and volume sets are
refused. Raw 2352-byte optical sectors, alternate session offsets, UDF trees, host mounting and writing are outside this
profile. Boot descriptors, volume partition descriptors and unknown supplementary trees do not activate another parser.
An image containing additional filesystem structures can still expose this selected ISO tree; no validation of those
other structures is implied.

The default parent-record policy is strict. Genuine xorriso 1.5.4 Joliet output in the fixtures records the nested
folder's parent extent as that folder itself. Independent consumers can extract its files, but this reader refuses its
inconsistent parent extent by default. For this specific compatibility case, explicitly pass
`{ namespace: "joliet", jolietParent: "ignore-extent" }`. The returned `parents.policy` and bounded `parents.mismatches`
record the physical record offset, declared extent and expected parent extent, all in byte offsets. This option relaxes
only parent extent equality. The parent ID, directory kind, record framing, both-endian fields, declared size and
in-volume extent still require validation. Parent pointers never drive traversal; the actual child records and
visited-directory checks continue to define the selected graph. This is an observable compatibility policy, not a claim
that ignored parent records conform to the standard. Primary mode cannot use the option.

## Bounds, cancellation and nested readers

Indexing reads descriptors and directory sectors, without reading ordinary member payloads. It validates record sector
boundaries, padding and self/parent relationships. Directory aliases/cycles are refused before queueing another
traversal. The defaults are 64 descriptors, 100,000 entries, depth 64 (root zero), 8 MiB of queued directory extent
bytes and 1 MiB of retained UTF-8 name bytes. These bounds also cap the traversal queue and retained index. Ordinary
identifiers fit the one-byte directory record length field; no unbounded filename allocation occurs.

The opening archive work limits also form a lifetime ledger across indexing and subsequent reads. Per-read limits can
add a stricter operation bound; they cannot bypass that opening ledger. Defaults are: source 64 MiB, 4096 requests,
decoded 64 MiB and returned output 16 MiB. Directory bytes count as decoded metadata. Each retained parent mismatch
additionally reserves 24 output-accounting bytes before allocating its three-number record; directory/entry bounds also
cap the number of retained mismatches. Reads reserve returned/decoded work and the complete aggregate source/request
admission before allocating the selected buffer, without a second aggregate source/request charge during the read loop.
They then acquire exact source chunks of at most 64 KiB. `integrity: "none"` means this filesystem format supplies no
file checksum or authentication. A successful range read is not evidence of a trustworthy publisher.

`member(id, limits)` returns a borrowed exact-range `ByteSourceType` for nested archive readers. It retains the same
captured parent source identity/stability and physical extent, never a filename-derived identity. One shared ledger
bounds all reads through that member source, while the opening lifetime ledger remains in force; passing a ledger also
allows aggregate limits across indexing and nested readers. Nested logical reads may be charged by both layers because
each performs its own work; this is not a physical network-byte measurement. Aggregate reservations are not refunded
after a later failure. Opening, member-level and per-read signals combine; a later signal cannot override an aborted
opening lifetime. Cancellation stops subsequent reads and preserves source failures. The caller retains ownership of the
source and its provider; the reader opens no host resources.

## Independent evidence

The test-only producer script creates genuine xorriso and genisoimage primary/Joliet images. It compares complete
original payloads through `isoinfo` and independent libarchive extraction. Payloads include empty files, Unicode and
space-containing names, a nested directory, binary data and a 1 MiB unrelated file. The reader's source counters
separately check that indexing does not acquire ordinary payload extents. The genuine xorriso Joliet case requires the
explicit parent compatibility policy above; its strict refusal remains a regression test. Producer tools are not runtime
dependencies. Signed Debian bookworm packages used here were `xorriso` 1.5.4-4, `genisoimage` 9:1.1.11-3.4 and
`libarchive-tools` 3.6.2-1+deb12u5 on arm64. The producer records isoinfo's actual Latin-1 display bytes/encoding and
libarchive's extracted-name mappings rather than assuming either tool preserves every native identifier. The complete
image retains the original UCS-2 bytes.
[The fixture provenance](https://github.com/okikio/opfs/blob/1458d6d/tests/fixtures/iso/provenance.json) pins producer
script, fixture JSON and each image hash; its local base image is not a publicly pullable complete-producer pin.

The profile follows [ECMA-119](https://ecma-international.org/publications-and-standards/standards/ecma-119/), with
explicit comparison of the 1987 baseline and sixth edition (2025). Joliet character-set selection follows the
Microsoft-authored 1995 specification faithfully reproduced in Annex C of the sixth edition. Rock Ridge support is not
inferred from the base reader or these fixtures.
