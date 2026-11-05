# Preview stored files in an LHA archive

`openLha()` lists physical members and reads bounded ranges from ordinary `-lh0-` stored files. The source stays owned
by its caller. The reader does not extract paths, execute a self-extracting stub, or mount a filesystem.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openLha } from "@okikio/opfs/archive/lha";

export async function preview(bytes: ArrayBuffer, signal?: AbortSignal): Promise<Uint8Array> {
  const archive = await openLha(createBlobSource(new Blob([bytes])), {
    maxSourceBytes: 64 * 1024 * 1024,
    maxDecodedBytes: 64 * 1024 * 1024,
    maxOutputBytes: 16 * 1024 * 1024,
    maxRequests: 4096,
    ...(signal === undefined ? {} : { signal }),
  });
  const entry = archive.entries.find((entry) => entry.readable);
  if (!entry) throw new Error("No supported stored member exists.");
  const result = await archive.read(entry.id, { length: Math.min(1024, entry.size) });
  console.log(entry.name, entry.headerIntegrity, result.integrity, result.work);
  return result.bytes;
}
```

The default read scans the whole selected member to verify its file CRC16, even when the returned preview is only a
prefix. It uses chunks of at most 64 KiB and retains only the requested output. Set `verify: false` for an exact partial
range without scanning the rest. That result reports `integrity: "pending"`. A full selection still verifies CRC16,
including when `verify` is false. Zero-length previews follow the same rule; a verified preview of a nonempty file must
still scan its contents. An empty member has CRC16 zero and needs no payload request.

CRC16 detects accidental corruption. It does not authenticate an author, filename, timestamp, or archive. Header checks
and payload checks have separate scopes. `headerIntegrity` reports the verified base-byte sum, common header CRC16, or
both; it never substitutes for the payload result.

## Supported records and names

The initial profile accepts header levels 0, 1, and 2. Level 0/1 base headers require their byte sum. Level 2 requires a
common-header CRC16 extension. A present common CRC is checked over the complete header with its own two-byte field
considered zero. The file CRC16 is required in every supported header.

Level 1's serialized skip size includes its extension chain. The reader subtracts exactly those extension bytes before
admitting the stored payload extent. Level 2's size is the complete serialized header size. Both chains must terminate
within their declared bounds. Duplicate extension types are refused. The common CRC, filename, directory and Unix mode
extensions have explicit interpretations; bounded comment, time, owner and group extensions remain opaque. Unknown or
structural extensions, including multivolume and 64-bit size overrides, are refused. Level 0 permits its conventional
12-byte Unix suffix; other suffix layouts are unsupported.

`entries` preserves physical record order and assigns numeric IDs. Duplicate names do not overwrite members. Names are
inert metadata. Level 1/2 directory separator byte `0xff` displays as `/` in the default decoder; level 0's legacy path
separators remain literal. `rawName` and `rawDirectory` return fresh owned copies of their original bytes. The default
name decoder accepts ASCII only. Other encodings require an explicit `decodeName(bytes, role)` callback. It receives a
separate owned copy, so changing its input cannot change retained header evidence. Its output remains subject to the
name byte limit. The caller owns the chosen encoding interpretation.

The reader can list framed records using the known `-lh1-` through `-lh7-`, `-lzs-`, `-lz4-`, and `-lz5-` method tags,
but refuses their payload reads. The historical method `-lz4-` is unrelated to modern LZ4 frames. Directory `-lhd-`
records must have zero stored and logical size. Unix special-file modes remain unreadable metadata. No symlink, device,
permission, owner, timestamp, or archive path is applied to a host filesystem. This subpath does not provide a
filesystem view or a compressed-method decoder.

This strict physical profile requires exactly one final zero byte at EOF. It does not accept concatenated archives,
arbitrary trailing padding, damaged-header recovery, self-extracting stubs, header level 3, absent legacy file CRCs,
split volumes, encryption, or unrecognized platform suffixes. A level-2 header whose low length byte is zero is examined
as a header when more bytes remain; it is not silently mistaken for the final one-byte trailer.

## Budgets, source stability and nesting

Opening captures the source's size, identity, stability and bound read method before the first await. Later mutations to
the descriptor or option object cannot change that authority. Accepted stability values are `immutable`, `provider`, and
`caller`. Otherwise the caller must explicitly choose `allowUnverifiedSource: true`. Identity alone proves neither
stability nor authenticity. The reader copies provider scratch views before another read or foreign callback can reuse
them. Returned payload bytes and raw metadata views are owned by their recipient.

Opening byte/request limits persist across indexing and later reads. Each read also has fresh finite operation limits,
and can add another aggregate ledger. Reusing the same ledger at open and read charges it once. A nested member source
retains opening authority, its own finite cumulative limits, any additional ledger, and all supplied abort signals.
Independent calls run independently; an aggregate ledger is the coordination mechanism for their total work.

`member(id)` is useful when the selected stored file is itself an archive:

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openLha } from "@okikio/opfs/archive/lha";
import { openZip } from "@okikio/opfs/archive/zip";

export async function inspectNested(bytes: ArrayBuffer) {
  const archive = await openLha(createBlobSource(new Blob([bytes])));
  const entry = archive.entries.find((entry) => entry.readable && entry.name.endsWith(".zip"));
  if (!entry) throw new Error("No stored ZIP member exists.");
  const nested = await openZip(archive.member(entry.id, {
    maxSourceBytes: 16 * 1024 * 1024,
    maxOutputBytes: 8 * 1024 * 1024,
    maxDecodedBytes: 16 * 1024 * 1024,
    maxRequests: 2048,
  }));
  return nested.entries;
}
```

Nested partial reads provide exact stored bytes; they do not establish the enclosing file's whole-member CRC. Read that
member with verification when this evidence is required. A derived source identity, when one exists, includes the
captured physical archive identity and extent, never the filename. No source resource is disposed by the reader.

Default index bounds are 100,000 entries, 8 MiB of serialized headers, 64 KiB per complete header, 1,024 extensions per
member, and 4,096 raw name/directory and decoded UTF-8 name bytes per member. Existing archive work defaults are 64 MiB
source bytes, 4,096 requests, 64 MiB decoded work and 16 MiB returned output. Metadata reads and retained decoded names
charge decoded work; payload checks charge every scanned byte. Exact partial reads charge only their selected payload
extent. Known payload source/request costs and returned output are reserved before selected-buffer allocation or source
I/O. Reservations are not refunded after a later refusal or source failure.

These are logical work and representation limits, not exact heap or time guarantees. Header assembly can temporarily
retain several copies of one bounded header. CRC computation uses a fixed eight bit steps per byte and no global table.
A verified range retains its selected output plus one at-most-64-KiB provider chunk. Foreign source and decoder
callbacks own any extra allocation or work they perform. Abort is checked before work and after each awaited source
result; the reader does not interrupt or dispose the provider itself. Provider and callback errors retain their original
identity.

## Format and independent evidence

The historical
[LHa author header document](https://github.com/jca02266/lha/blob/16619b066b189ef289bb8b07b37d1c38d550da99/header.doc.md)
is the header-layout reference. It is not a modern standards-body specification. Independent
[Lhasa header semantics](https://github.com/fragglet/lhasa/blob/75ed83559f23e9538e0045c62f53f77ab03d03d6/lib/lha_file_header.c)
clarify extension accounting and common CRC scope. Their source is reference-only; this reader and bitwise CRC
recurrence are authored locally. Exact source digests and native fixture receipts belong beside the fixtures.

The signed Debian producer created three genuine JLHA archives, with six original ASCII-named files at each header
level. JLHA, Lhasa, 7zip and libarchive extracted into separate owned temporary directories. All four tools produced the
exact expected file sets and every original payload byte, including empty files and a 230,017-byte member. The candidate
reader was not imported by the producer. The fixtures and [provenance receipt](../tests/fixtures/lha/provenance.json)
retain package versions, signed artifact hashes, source pins, original byte digests and negative diagnostics.

The installed JLHA level-0 writer has its own 100-byte header ceiling. Its initial 98-byte pathname required a 122-byte
header and was refused. The successful level-0 fixture uses a 58-byte pathname and 82-byte header; levels 1/2 retain the
98-byte pathname. This is a constraint of that exact native writer, not a universal LHA format limit. A second producer
attempt exposed progress text in JLHA's print-to-stdout mode. The final byte oracle reads actual extracted files instead
of stripping output. Neither failed attempt produced an accepted fixture.

Native filenames in these fixtures are ASCII. Non-ASCII callback behavior, special Unix modes, malformed envelopes and a
256-byte level-2 header are separate authored controls, not native platform/encoding compatibility claims. The
independent CRC16/ARC `123456789 = 0xbb3d` vector also checks the payload recurrence. The benchmark compares cold
indexing, full verification, verified and deferred suffix previews with a preindexed native Blob range. Its baselines
have different checksum semantics; a single local run does not establish a general speed advantage.
