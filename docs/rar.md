# Preview stored files in a RAR5 archive

Use original RAR5 file headers to list an archive, then read a selected interval without extracting files to the host.
This profile reads regular STORED members. Compressed, encrypted and redirected entries remain visible with explicit
read restrictions. It does not mount an archive or follow names as paths.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { createArchiveLedger, openRar } from "@okikio/opfs/archive/rar";

export async function preview(blob: Blob): Promise<Uint8Array | undefined> {
  const archive = await openRar(createBlobSource(blob), {
    maxHeaders: 4096,
    maxHeaderBytes: 4 * 1024 * 1024,
    ledger: createArchiveLedger({
      maxSourceBytes: 32 * 1024 * 1024,
      maxRequests: 4096,
      maxDecodedBytes: 32 * 1024 * 1024,
      maxOutputBytes: 65536,
    }),
  });
  const entry = archive.entries.find((item) => item.readable && item.name.endsWith(".txt"));
  if (!entry) return undefined;
  const result = await archive.read(entry.id, {
    length: Math.min(entry.size, 4096),
    maxSourceBytes: 16 * 1024 * 1024,
    maxDecodedBytes: 16 * 1024 * 1024,
    maxOutputBytes: 4096,
  });
  return result.bytes;
}
```

For a member with a CRC32 field, the default read checks its **entire payload before returning any selected bytes**. A 4
KiB prefix can therefore scan a much larger file. The scan uses at most one 64 KiB source request at a time and retains
only the selected output. The result reports `integrity: "crc32-verified"`, including when an empty member's declared
CRC is verified. A missing CRC produces `"not-provided"`; this reader does not invent a checksum.

Set `verify: false` to request only the exact selected extent. CRC-present results then report `"pending"`, even if the
selected interval happens to be the complete member. `verify: true` means check the available CRC, not require that a
missing CRC exist. CRC32 detects accidental corruption; it provides no authentication of content, names or publisher
identity. A BLAKE2sp extra record is opaque metadata and is not verified by this profile.

## What the index establishes

`metadata: "header-crc32-verified"` means that every original physical header visited by the scan passed its header CRC.
The parser checks the signature at byte zero, a single main header, bounded file/service record framing, all
extra-record envelopes and the final end header. Integer arithmetic remains exact; an unsafe size or offset is refused
before it can become an allocation or source request. RAR permits overallocated variable-length integers, so this reader
accepts them within the format's three-byte header-size and ten-byte/64-bit integer limits.

Each entry has a physical header-offset `id`, its literal UTF-8 name, source `offset`, `packedSize`, declared `size`,
`sizeKnown`, attributes, host, method, codec version, encryption/dependency flags, extra-record type identifiers and
read restrictions. Duplicate names remain distinct entries. Directory, redirection and special-file entries are never
treated as readable regular files. Separators, traversal components and RAR's special Unix byte-name mapping remain
inert strings; there is no filesystem projection or extraction API in this subpath.

Quick-open caches can contain names different from the original headers. This parser **never uses those caches** for
listing or reading. `services` counts structurally framed service headers, including comments and quick-open records.
Their payloads are skipped by exact bounded extents, not fetched, decoded or checksum-verified. Locator offsets are
opaque metadata, never navigation authority. Optional extra-record bodies are also opaque; the parser validates their
framing and unique types, not every extension's semantic grammar. Unknown file extra types disable member reads rather
than silently granting a new storage interpretation.

## Supported physical profile and refusals

The readable member profile requires method 0, codec version 0 or 1 with supported flag widths, a known unpacked size
equal to the packed extent, and an ordinary Windows/Unix regular file. There must be no encryption extra, redirection,
split-volume or preceding-file dependency. No dictionary or compression decoder is allocated.

The index can describe compressed and file-encrypted members but refuses their reads. A solid main archive, volume set
or encrypted headers prevent opening this profile. RAR4, a self-extracting prefix, unknown block types, duplicate extra
types, and bytes after the end header are also outside this profile. The official format permits an SFX prefix and
trailing information; their refusal is a deliberate inspection limit, not a statement that those archives are invalid.
Recovery data, signatures, service payloads, BLAKE2sp hashes and optional extension bodies are not validated.

## Budgets, source lifetime and cancellation

The source is borrowed and must describe stable bytes. `immutable`, `provider` and `caller` stability evidence is
preserved; an identity alone does not establish stability or authentication. `allowUnverifiedSource: true` explicitly
accepts an unverified custom source and reports that fact. The source descriptor and opening options are captured before
the first asynchronous request. The reader neither closes nor cancels the borrowed source.

Default index policies allow 100,000 physical headers, 8 MiB of aggregate encoded headers and 1 MiB of retained UTF-8
file names. Individual headers cannot exceed the format's three-byte size field. These policies supplement the ordinary
per-operation defaults: 64 MiB source bytes, 4096 requests, 64 MiB decoded work and 16 MiB output. Opening limits also
create an aggregate lifetime ledger retained by all subsequent reads. An additional read ledger joins the opening
ledger; passing the same ledger does not double-charge it.

Decoded work includes interpreted header bytes, a logical 16-byte charge before retaining each extra type, a logical
96-byte entry/name/type-index charge, and payload bytes processed by reads. These are admission units, not exact
JavaScript heap measurements. Output limits bound the selected owned buffer, independently of the whole-member CRC scan.
Payload source bytes and request counts are known and reserved before that buffer is allocated. Reservations are not
refunded if a later dimension, source operation, checksum or cancellation fails. Underlying source/provider work outside
requested extents needs its own physical accounting.

Opening and per-read signals are combined. Cancellation is checked before admission, between serial requests and before
the public result returns; a rejected source operation retains its own error. The checksum loop is synchronous within
each bounded chunk and does not promise a hard cancellation deadline. No archive resources require disposal.

## Evidence and maintenance

The primary grammar is RARLAB's [RAR5 technical note](https://www.rarlab.com/technote.htm). The pinned source hash,
fixture/archive hashes, exact producer/consumer versions and commands are in
[`tests/fixtures/rar/provenance.json`](../tests/fixtures/rar/provenance.json) and the adjacent inert receipt.

The historical executed producer remains byte-for-byte inert `tests/fixtures/rar/create.py.snapshot`.
[`create.ts`](../tests/fixtures/rar/create.ts) is the current project-owned port, not the producer of those existing
fixtures. It has not yet run. Its [instructions](../tests/fixtures/rar/README.md) require separately reviewed native
tools and a new qualification receipt; the port does not download a vendor executable or renew trial authorization.

An explicitly authorized, one-time vendor RAR 7.23 trial invocation produced STORED and quick-open/comment archives.
Native 7zz's forced RAR5 reader and macOS libarchive independently consumed every original file and matched complete
bytes, including empty, Unicode, 150,123-byte and unrelated 1 MiB members. Libarchive extraction names are retained with
an explicit NFC lookup mapping for the authored Unicode name; the archive parser itself does not normalize names.
Compressed, encrypted, solid, volume and symbolic-link archives are genuine producer refusal controls, not claims that
their codecs were implemented. Host 7zz refused the newer compressed member; the diagnostic log is retained.

The vendor executable and downloaded package are not distributed, imported at runtime or installed by CI. The fixture
producer requires explicit local tool paths and is not an ongoing trial-based test dependency. Authored header controls
cover malformed framing, optional records, noncanonical integer encodings, limits, traversal names, missing CRC,
unselected corruption, snapshot capture and cancellation. These tests establish this selected profile, not full RAR
conformance or adversarial authentication.
