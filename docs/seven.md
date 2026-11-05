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

Opening reads the 32-byte signature and bounded next header. An encoded header also reads and fully decodes its bounded
metadata pack before names are available. It does not read packed file bodies. Names, empty files, directories, raw
attributes and modification times come from the validated decoded or plain header. A 7z “folder” is a coder graph; it is
unrelated to pathname directories. Entry IDs retain archive order and duplicate names remain distinct IDs. This API
neither extracts files nor supplies a filesystem projection. Names are untrusted archive metadata, including traversal
paths.

Payload reads support one coder, one packed input, one output and one unpacked substream: COPY (`00`) with no
properties, LZMA1 (`030101`) with five property bytes, or LZMA2 (`21`) with one dictionary property byte. COPY packed
and unpacked sizes must agree. Empty regular files are also readable. The local pure LZMA engine requires
`lc + lp <= 4`; see [codec limits and termination](lzma.md). Encrypted, solid, symbolic-link, reparse and special-file
payloads are not readable. Linear one-input/one-output coder graphs can be indexed; every binding must be in range,
connected and acyclic. Multiple-coder filters and other graph forms do not become readable merely because one coder is
LZMA. Unknown methods remain inert hex data and report encryption status `"unknown"`; no plugin or runtime SDK is
loaded.

An encoded header requires one supported LZMA coder, pack, folder and substream. Its packed extent must end exactly
where the outer next header begins. Its decoded bytes must fit the shared header-byte allowance and decoded-work ledger
before allocation. A decoded folder or substream CRC is mandatory and is verified before parsing or exposing names. A
packed CRC alone is insufficient. `headers.decoded` reports this metadata method and checksum evidence, separately from
the signature's `start` and outer `next` checks and from all file payload checks. Header verification cannot be disabled
by a member's `verify: false`. Encrypted or recursively encoded headers, additional streams, external metadata,
unsupported file properties, alternative coders, SFX prefixes, concatenation and bytes after the declared next header
are refused. This is a strict subset of 7z, not a general 7-Zip replacement.

## Integrity and bounded reads

Header CRC evidence is separate from payload evidence. Pack, folder and substream CRCs retain their original scopes in
`packs`, `folders`, `entries` and read `checks`. A single-substream folder digest is identified as inherited with
`crcSource: "folder"`. CRC32 detects accidental corruption; it does not authenticate an archive or its publisher.

`read(id, { offset, length })` defaults to `verify: true`. For COPY, a present digest makes it scan the entire selected
file in chunks up to 64 KiB while retaining only the requested output. For LZMA, verification always decodes the
complete member and checks exact output size and terminal state, even when no CRC exists. It reads no unrelated files.
This can cost much more than the output size. `verify: false` permits direct COPY range reads or a decoded LZMA prefix
and reports applicable checks as `pending`. LZMA must decode from the member's beginning to reach an offset; it is not
random-access decompression. A late range can therefore cost nearly a full decode. A decoder quantum can pass the
requested end before cancellation; source lookahead can also fetch more packed bytes than the prefix needs.
`decoding: "prefix"` reports incomplete compressed termination, while `"complete"` reports a complete decoder. This
field is absent on COPY/empty-file reads. No applicable digest reports integrity `none`, including ordinary empty-file
records without a stored digest. Missing digests are never interpreted as a zero digest. All applicable checks must
verify before reporting `crc32-verified`. Packed CRCs cover compressed source bytes; folder/substream CRCs cover decoded
bytes. They need not have equal values. The equivalence of all extents applies only to the single-stream COPY profile.

Each operation defaults to 64 MiB source bytes, 4096 requests, 64 MiB decoded bytes and 16 MiB output bytes. Opening
additionally admits at most 8 MiB of signature/next-header data plus logical retained name/method/property string bytes,
100,000 entries, 4096 folders, 4096 aggregate coders, 100,000 aggregate pack/substream records, 100,000 property records
and 64 KiB per UTF-16LE name including its terminator. These are logical work and record limits, not a JavaScript heap
or elapsed-time guarantee. Offsets, serialized integers and extent sums use exact BigInt checks before conversion to
safe JavaScript indexing. Opening byte limits also form a lifetime allowance across later reads. An opening `ledger`
remains active on every read; a different operation ledger adds admission and does not replace the opening ledger.
Passing the same ledger again does not double-charge it. Source requests, decoded work and selected output are each
charged once; discarded plaintext consumes decoded work, not selected-output allowance. Decoded work includes LZMA2
framing. The header-byte allowance includes outer, packed, decoded header extents and logical retained
name/method/property copies.

The optional `lzma` object on opening and reading accepts `maxDictionaryBytes`, `maxMemoryBytes`, `maxDecisions`,
`maxSteps`, `maxChunks`, `inputChunkBytes`, and an injected `yield` scheduler. Opening codec policy is inherited;
operation fields can override it. Defaults and hard ceilings match [the raw decoder](lzma.md). These CPU and memory
limits apply to each decode, while archive ledgers aggregate logical byte work across operations. A prefix still pays
for every model reset and preceding decoded byte. The reader retains the selected output plus bounded codec state, not a
complete decoded file. Encoded metadata is an explicit bounded full materialization.

The source is borrowed and never closed. Its read function, size, identity and declared stability are captured at open.
Source stability must be declared, or the caller must explicitly pass `allowUnverifiedSource: true`. Identity alone
proves neither stability nor authenticity. The opening signal remains active for later reads, combined with any
operation signal. Read cancellation reaches source reads and is checked before allocating output. LZMA stream
cancellation and its terminal promise are joined before returning or failing, including a provider failure that arrives
while an abort waits. Source errors and cancellation reasons propagate. No background jobs, native bindings or runtime
dependencies are installed. `mtime` is a bigint Windows FILETIME value (100 ns since 1601), not Unix milliseconds.

## Interoperability evidence

`tests/fixtures/seven/create.py` invokes genuine 7-Zip 26.02 from signed Debian package
`7zip 22.01+really26.02+dfsg-0+deb12u1` and independent `bsdtar` from `libarchive-tools 3.6.2-1+deb12u5`, arm64. COPY,
LZMA1, LZMA2, solid and encoded-header fixtures were extracted by bsdtar and every payload compared to the original
binary input. Encrypted fixtures record consumer failure and are used only for metadata/refusal tests; they do not
establish independent decryption support.

The receipt pins producer script, JSON and individual archive hashes. The local producer base was
`opfs-cab-tools:20261105`, image ID `sha256:205a6b2ff80a9c72b8d3df0e9abc98970fde7edbbfcca91967bcf9a153e3bc79`. Package
installation mutates that image; this is neither a public pullable full-producer pin nor a claim of bit-for-bit
reproducibility. The script records commands and tool versions. Its test-only executable dependencies do not enter the
library dependency graph.

The parser follows the primary
[7z format description](https://github.com/ip7z/7zip/blob/e5431fa6f5505e385c6f9367260717e9c47dc2ee/DOC/7zFormat.txt) and
[method registry](https://github.com/ip7z/7zip/blob/e5431fa6f5505e385c6f9367260717e9c47dc2ee/DOC/Methods.txt). It does
not copy decoder code from the SDK.

## Benchmark workload

`deno task bench:seven` preflights complete fixture bytes and selected intervals before sampling 29 workloads. COPY
compares exact preindexed Blob reads with unchecked/CRC previews and cold indexing. LZMA1, LZMA2 and encoded-header
LZMA1 profiles compare warm prefix decoding with complete-member CRC decoding at an early and late offset. Names record
actual source, decoded and selected-output bytes, plus prefix termination. The compressed lanes have no independent
native-codec timing baseline and establish no speedup claim. Cold indexing of compressed headers includes their full
metadata decode.

Warm samples share one index with an explicit finite sampling allowance of 64 GiB source/decoded work, 1 GiB returned
bytes and ten million requests; each read keeps its ordinary default operation limits. This permits repeated samples
without disabling the production lifetime-budget contract. Local Node 26.13.0 on arm64 macOS completed all workloads; CI
retains raw Mitata JSON. Timings describe these fixtures and host, not every archive size or runtime.
