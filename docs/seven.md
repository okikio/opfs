# Preview a 7z archive

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { createArchiveLedger, openSeven } from "@okikio/opfs/archive/seven";

export async function preview(archiveBytes: ArrayBuffer): Promise<Uint8Array | undefined> {
  const ledger = createArchiveLedger({
    maxSourceBytes: 16 * 1024 * 1024,
    maxRequests: 512,
    maxDecodedBytes: 16 * 1024 * 1024,
    maxOutputBytes: 4096,
  });
  const archive = await openSeven(createBlobSource(new Blob([archiveBytes])), { ledger });
  console.table(archive.entries);
  const file = archive.entries.find((entry) => entry.kind === "file" && entry.readable);
  if (!file) return undefined;
  const result = await archive.read(file.id, { length: Math.min(file.size, 4096), ledger });
  console.log(result.integrity, result.checks, result.work);
  return result.bytes;
}
```

Opening reads the 32-byte signature and bounded next header. It does not read packed file bodies. Names, empty files,
directories, raw attributes and modification times come from an unencoded header. A 7z “folder” is a coder graph; it is
unrelated to pathname directories. Entry IDs retain archive order and duplicate names remain distinct IDs. This API
neither extracts files nor supplies a filesystem projection. Names are untrusted archive metadata, including traversal
paths.

Payload reads support a single COPY coder with no properties and exactly one unpacked substream. Packed and unpacked
sizes must agree. Empty regular files are also readable. Compressed, encrypted, solid, symbolic-link, reparse and
special-file payloads are not readable. Linear one-input/one-output coder graphs can be indexed; every binding must be
in range, connected and acyclic. Other graph forms fail rather than presenting partially validated entries. Unknown
methods remain inert hex data and report encryption status `"unknown"`; no codec or plugin is loaded.

Encoded or encrypted headers fail with `unsupported-profile` after both header CRCs have been checked. Their names are
unavailable. Additional streams, external metadata, unsupported file properties, alternative coders, SFX prefixes,
concatenation and bytes after the declared next header are refused. This is a strict subset of 7z, not a general 7-Zip
replacement.

## Integrity and bounded reads

Header CRC evidence is separate from payload evidence. Pack, folder and substream CRCs retain their original scopes in
`packs`, `folders`, `entries` and read `checks`. A single-substream folder digest is identified as inherited with
`crcSource: "folder"`. CRC32 detects accidental corruption; it does not authenticate an archive or its publisher.

`read(id, { offset, length })` defaults to `verify: true`. If a digest exists, it scans the entire selected COPY file in
chunks up to 64 KiB while retaining only the requested output. It reads no unrelated files. This can cost much more than
the output size. `verify: false` reads just the requested extent and reports applicable checks as `pending`. No
applicable digest reports integrity `none`, including ordinary empty-file records without a stored digest. Missing
digests are never interpreted as a zero digest. All applicable pack/folder/substream checks must agree before reporting
`crc32-verified`.

Each operation defaults to 64 MiB source bytes, 4096 requests, 64 MiB decoded bytes and 16 MiB output bytes. Opening
additionally admits at most 8 MiB of signature/next-header data plus logical retained name/method/property string bytes,
100,000 entries, 4096 folders, 4096 aggregate coders, 100,000 aggregate pack/substream records, 100,000 property records
and 64 KiB per UTF-16LE name including its terminator. These are logical work and record limits, not a JavaScript heap
or elapsed-time guarantee. Offsets, serialized integers and extent sums use exact BigInt checks before conversion to
safe JavaScript indexing. A shared ledger prevents resetting work allowance between opening and reading.

The source is borrowed and never closed. Its read function, size, identity and declared stability are captured at open.
Source stability must be declared, or the caller must explicitly pass `allowUnverifiedSource: true`. Identity alone
proves neither stability nor authenticity. Read cancellation reaches source reads and is checked before allocating
output. Source errors and cancellation reasons propagate. No background jobs, native bindings or runtime dependencies
are installed. `mtime` is a bigint Windows FILETIME value (100 ns since 1601), not Unix milliseconds.

## Interoperability evidence

`tests/fixtures/seven/create.py` invokes genuine 7-Zip 26.02 from signed Debian package
`7zip 22.01+really26.02+dfsg-0+deb12u1` and independent `bsdtar` from `libarchive-tools 3.6.2-1+deb12u5`, arm64. COPY,
LZMA2, solid and encoded-header fixtures were extracted by bsdtar and every payload compared to the original binary
input. Encrypted fixtures record consumer failure and are used only for metadata/refusal tests; they do not establish
independent decryption support.

The receipt pins producer script, JSON and individual archive hashes. The local producer base was
`opfs-cab-tools:20261105`, image ID `sha256:205a6b2ff80a9c72b8d3df0e9abc98970fde7edbbfcca91967bcf9a153e3bc79`. Package
installation mutates that image; this is neither a public pullable full-producer pin nor a claim of bit-for-bit
reproducibility. The script records commands and tool versions. Its test-only executable dependencies do not enter the
library dependency graph.

The parser follows the primary [7z format description](https://github.com/ip7z/7zip/blob/main/DOC/7zFormat.txt) and
[method registry](https://github.com/ip7z/7zip/blob/main/DOC/Methods.txt). It does not copy decoder code from the SDK.
