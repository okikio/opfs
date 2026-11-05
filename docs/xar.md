# Preview selected files in Apple-profile XAR archives

`openXar()` reads the compressed XML table of contents (TOC), builds a bounded file index, and then reads only selected
members from the archive's heap. It does not extract files to a host directory or follow links. The caller supplies a
stable byte source and keeps its resources available while the index is used.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openXar } from "@okikio/opfs/archive/xar";

export async function previewXar(bytes: ArrayBuffer, subtle: SubtleCrypto): Promise<Uint8Array> {
  const archive = await openXar(createBlobSource(new Blob([bytes])), { subtle });
  const entry = archive.entries.find((entry) => entry.type === "file" && entry.path === "hello.txt");
  if (!entry) throw new Error("hello.txt is absent");
  const preview = await archive.read(entry.id, { length: Math.min(entry.data?.size ?? 0, 128) });
  console.log(archive.toc, preview.archived, preview.extracted, preview.work);
  return preview.bytes;
}
```

The caller supplies `SubtleCrypto` explicitly for checksum verification; the library does not discover a global crypto
capability. An application can pass its native `crypto.subtle`. Without this capability, default TOC verification of a
checksummed archive fails clearly. `verifyToc: false` permits inspection with pending TOC evidence, and
`read(..., { verify: false })` permits pending member evidence. Code 0 TOCs and members without checksums need no crypto
capability.

The default read verifies every provided supported member checksum over its **complete** byte sequence. A 128-byte
preview can therefore read and hash a whole selected file. It does not read other files. Set `verify: false` explicitly
when selective stored ranges matter more than complete checksum verification. That result reports provided checksums as
`pending`, including for an empty range. Compressed members always decode fully to validate framing and declared size;
their prefixes do not provide compressed random access.

```ts
import type { ByteSourceType } from "@okikio/opfs/source";
import { openXar } from "@okikio/opfs/archive/xar";

export async function storedMember(source: ByteSourceType, subtle: SubtleCrypto): Promise<ByteSourceType> {
  const archive = await openXar(source, { subtle });
  const entry = archive.entries.find((entry) =>
    entry.type === "file" && entry.data?.encoding === "application/octet-stream"
  );
  if (!entry) throw new Error("No stored regular file is available");
  return archive.source(entry.id, { maxSourceBytes: 1_048_576, maxOutputBytes: 1_048_576 });
}
```

`source()` exposes exact ranges from stored ordinary files. It has a cumulative per-source budget and retains physical
provenance in an unambiguous JSON identity tuple when the original source has an identity. A source read does **not**
verify a whole-member checksum. Compose this source with another archive reader to preview an embedded stored archive.
Compressed member sources, link traversal, and a public decoded stream are deferred. `read()` returns a bounded buffer.

## Format profile and checksum scopes

The explicit `apple-v1` profile requires a 28-byte big-endian header and version 1. Header checksum codes 0/1/3/4 mean
none/SHA-1/SHA-256/SHA-512. Code 2 (MD5), other codes, and larger headers fail before TOC allocation. This is
deliberate: [historical XAR documentation](https://github.com/mackyle/xar/wiki/xarformat) gives code 3 a different
named-hash-header meaning. The implementation does not guess between these dialects. The Apple source pinned below and
native fixture headers establish this profile.

The TOC is zlib-compressed UTF8 XML. Its checksum covers the **compressed TOC bytes**, with the expected digest stored
at a TOC-declared heap extent. Header algorithm, XML algorithm, digest length, and extent must agree. The checksum
status is `verified`, `pending` when `verifyToc: false`, or `not-provided` for code 0. A matching checksum detects
inconsistency; it does not establish trusted authorship. Signatures and certificates are not verified.

Each entry exposes its declared checksum labels and hexadecimal values in `checksums`. Each member's `archived-checksum`
covers stored heap bytes. `extracted-checksum` covers decoded bytes. `read()` reports these separately, never combining
them into a claim about the entire archive. SHA-1 is supported for format interoperability and is not a modern
authenticity mechanism. Unknown member digest labels remain inert metadata; verification refuses them before member I/O.
Explicit `verify: false` leaves their status pending. MD5 verification is not implemented.

Heap `offset` and `length` identify stored bytes; `size` is the decoded length. Stored `application/octet-stream` data
requires equal stored/decoded lengths. Native XAR's `application/x-gzip` member encoding uses a **zlib** stream, not a
gzip container, and is decoded through the existing native compression module. Bzip2, LZMA, encryption, inline content,
and whole-heap transforms have no read implementation. Recognized transform declarations fail explicitly; this is not an
arbitrary XAR-extension interpreter. Unsupported member codecs can be indexed but cannot be read. No codec SDK or
fallback dependency is acquired.

File IDs and logical paths must be unique. Names are single UTF8 components; empty names, dot components, slash,
backslash, control characters, and encoded-name attributes are refused. Paths are metadata, never host destinations.
Only directories may contain nested file elements. Directory, symlink, hardlink and other type records can be inspected
but cannot be read as regular file content. Extended attributes have separately indexed names and heap extents; the
reader never applies xattrs, restores permissions/ownership, follows a URL, or fetches external content. Exact shared
heap extents can represent coalesced bytes; a physical range alone does not prove unique file ownership.

## Limits, work and resource ownership

| Policy               | Default | Implementation ceiling or meaning                                         |
| -------------------- | ------- | ------------------------------------------------------------------------- |
| `maxTocBytes`        | 1 MiB   | 8 MiB compressed TOC                                                      |
| `maxXmlBytes`        | 1 MiB   | 8 MiB decoded UTF8                                                        |
| `maxXmlTokens`       | 20000   | 30000 `<` tokens, admitted before XML tree creation                       |
| XML depth/attributes | 64/128  | Parser-enforced before admitting deeper elements/extra attributes         |
| `maxEntries`         | 10000   | Includes links/directories                                                |
| File nesting         | 32      | Logical directory depth                                                   |
| `maxPathBytes`       | 4096    | Complete UTF8 path; UTF16 preflight precedes encoding                     |
| `maxMetadataBytes`   | 4 MiB   | TOC UTF8 + full path UTF8 + 256/entry + 128/EA, a retained-index estimate |
| `maxVerifyBytes`     | 1 MiB   | 16 MiB per whole checksum input                                           |
| `maxMemberBytes`     | 16 MiB  | 64 MiB complete decoded member; complete stored inputs also cap at 64 MiB |

DTD/entity declarations and namespaces are refused. The existing `@std/xml` parser owns XML syntax and built-in entity
decoding. XAR's direct-child authority fields reject duplicates and nested scalar injection; an EA offset cannot become
a file offset through a descendant lookup. The compressed and decoded TOC lengths are admitted before allocation.
Markup-token and XML byte limits bound tree construction; metadata limits bound index admission. These are finite
policy/implementation limits, not exact JavaScript heap or CPU guarantees.

Every open/read uses `ArchiveLimitsType` source/request/decoded/output accounting. Opening policy is also cumulative
across subsequent reads. An explicit caller ledger can span nested readers. Aggregate source reservations precede
collection-buffer allocation. `decodedBytes` includes decoded material and complete checksum inputs; `outputBytes`
counts only returned preview bytes. Compressed reads retain a complete stored buffer and complete decoded buffer, then
copy the selected result. WebCrypto digest inputs require another bounded copy. Native codecs have opaque internal
buffers; limits admit output after native allocation and do not prove a native peak-memory ceiling.

Default whole-file checksum verification can exceed preview policy even for a tiny requested result. Raise the relevant
finite limit, use a smaller member, or explicitly select `verify: false`. Cancellation remains a failure, not checksum
success. Native codec readers and producer pipelines retire before the read settles; the original byte source is never
closed. Opening/read signals are borrowed; an explicit read signal overrides the opening signal. A source read combines
its captured signal with its per-read signal. Source methods, size, identity and stability are captured when opened.
Missing stability evidence requires explicit `allowUnverifiedSource: true` and does not become snapshot assurance.

## Independent evidence and remaining scope

[Fixture production](../tests/fixtures/xar/README.md) retains seven complete unmodified archives: six produced by native
Apple `xar 1.8dev` (stored/zlib with three SHA algorithms), plus a bsdtar-produced XAR. Python's independent
zlib/hashlib checks every TOC/member checksum and compares each decoded file with authored bytes. Native xar extracts
all fixtures and compares exact bytes. Installed bsdtar independently extracts the SHA-1 fixtures; it refuses Apple
SHA-2 archives as unrecognized, and those failed receipts remain recorded. This is local tool interoperability, not a
claim about every XAR implementation or deployed package installer.

The dialect source is Apple's immutable
[`archive.c` revision 3efbc308e3699a4ab8258fd769f5853bae91a2dc](https://github.com/apple-oss-distributions/xar/blob/3efbc308e3699a4ab8258fd769f5853bae91a2dc/xar/lib/archive.c),
SHA256 `aafad8b949b2dc555f141d8c281ec675cea9485bef2bb3ddbaa5415fe0f2c6f2`. Fixtures also preserve native header
receipts; installed Apple binaries are not claimed to be built from that exact source revision. Encrypted XAR, signature
trust, all historical dialects, package-install semantics, restoration and streamed compressed member random access
remain outside this profile.
