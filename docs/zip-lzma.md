# Preview EOS-required LZMA members in ZIP

ZIP compression method 14 stores a short property prefix followed by raw LZMA1 data. The reader can return selected
plaintext without extracting other members. This profile requires the ZIP end-of-stream (EOS) flag; no-EOS and encrypted
method-14 variants remain explicitly unsupported.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openZip } from "@okikio/opfs/archive/zip";

export async function previewLzmaZip(archiveBytes: ArrayBuffer, memberName: string, verify = false) {
  const archive = await openZip(createBlobSource(new Blob([archiveBytes])), {
    maxSourceBytes: 64 * 1024 ** 2,
    maxRequests: 4096,
    maxDecodedBytes: 128 * 1024 ** 2,
    maxOutputBytes: 16 * 1024 ** 2,
  });
  const member = archive.entries.find((entry) => entry.name === memberName);
  if (!member) throw new RangeError("ZIP member does not exist.");
  const result = await archive.read(member.id, {
    length: Math.min(1024, member.size),
    verify,
    maxOutputBytes: 1024,
    maxDecodedBytes: 64 * 1024 ** 2,
    lzma: {
      maxDictionaryBytes: 8 * 1024 ** 2,
      maxMemoryBytes: 16 * 1024 ** 2,
      maxDecisions: 64 * 1024 ** 2,
      maxSteps: 128 * 1024 ** 2,
      inputChunkBytes: 65536,
    },
  });
  if (result.codec?.kind === "lzma") {
    console.log(result.codec.termination, result.codec.dictionaryBytes, result.codec.decisions);
  }
  return result;
}
```

The decoded interval is `result.bytes`. Member names stay inert; this API does not write paths or mount an archive. The
source remains borrowed. The decoder uses the existing pure [`archive/lzma`](lzma.md) kernel, with no native executable,
SDK, registry or provider acquired by production code.

## Exact wire profile and integrity scopes

Both central and local version-needed values must be at least 6.3. The local and central flags must agree, and general
purpose bit 1 must be set, meaning an EOS marker is present. The packed extent begins with two producer SDK-version
bytes, a little-endian two-byte property size and the property bytes. The initial supported property size is exactly
five: one LZMA literal/position property and four little-endian dictionary-size bytes. The SDK-version bytes identify
the producer; they are not used as a decoder capability or minimum-version guess. The raw kernel's property, dictionary,
range-state, match-history and exact-extent rules apply.

The property prefix and raw packed extent are separately bounded against the member's central-directory compressed size.
Local names, method, flags and applicable sizes/CRC must agree with that directory. Data-descriptor archives use
central-directory sizes; descriptor bytes are not independently verified. Unknown property lengths, encrypted method 14,
no-EOS flag profiles, truncated streams and trailing raw bytes are refused. The implementation does not infer
`.lzma`-alone framing from a ZIP method number.

LZMA1 has no standalone checksum. `result.codec.integrity` is therefore `"none"`, even after its structural end marker
has been validated. Its `termination` is `"pending"` on an unfinished prefix or `"end-marker"` when the exact raw stream
completed. A small member can complete while producing the chunk containing the requested prefix, so structural
completion can be known even when the ZIP CRC remains pending.

The ZIP `result.integrity` is `"checksum-pending"` for a selected prefix. A complete member or `verify: true` consumes
the EOS marker, validates exact packed EOF and decoded size, and checks ZIP CRC32 before returning the selected bytes.
An empty member still requires a valid framed raw stream and EOS. A zero-length prefix of a nonempty member does not
decode plaintext; it may still read the bounded property prefix. CRC detects accidental corruption, not a publisher's
identity or malicious tampering. Neither headers nor names are authenticated.

## Costs, limits and cancellation

LZMA decodes from the beginning; a late interval can require replaying a large prefix. Opening limits and the opening
ledger cover cumulative directory/read work, while each read has fresh limits that can only narrow the remaining
allowance. Per-read ledgers and abort signals add authority; they do not replace the opening owners. See the
[ZIP ownership contract](archive.md) for snapshot stability and lifetime policy.

Source bytes and requests count the fixed local header, name/extra fields, nine-byte property prefix and raw packed
reads once. Internal decoder output is not caller output: `work.outputBytes` counts only the selected returned bytes.
`work.decodedBytes` includes kernel work plus ZIP's plaintext scan/copy pass and can exceed the member's size.
`plan().decodedBytes` remains a metadata lower bound, not a promise of exact decode cost or a heap bound.

The optional `lzma` policy forwards only dictionary bytes, typed memory, range decisions, CPU steps, source request
quantum and scheduling callback. The [kernel defaults and hard ceilings](lzma.md) apply; ZIP retains ownership of format
properties, expected size, EOS policy, signals and byte ledgers. The returned LZMA evidence reports admitted dictionary
capacity, actual decisions and CPU steps. These counters do not promise hard elapsed time, total process memory or
consumer-retained memory.

Each read owns its decoder reader. Prefix completion cancels it and joins terminal settlement, including borrowed reads
and scheduling callbacks. Provider, cancellation and independent cleanup failures remain observable. Terminal errors
observed through both the stream and `finished` are one decoder event, not two separate failures. Options and codec
policy are copied before source awaits; property bytes are copied before a later read can reuse source scratch.

## Independent evidence

`tests/fixtures/zip-lzma/create.py` defines native Python `zipfile.ZIP_LZMA` and 7-Zip producers and a forward-only
Python writer for data descriptors. Python and 7-Zip consume every original byte in all sixteen members; libarchive also
matches every nonempty original. The four archives contain twelve actual LZMA members. The receipt records actual
method/flags, producer SDK bytes, property bytes, dictionary capacity, tool/package versions and hashes. Tiny entries
that a native producer stores without compression are recorded as method 0 and are not LZMA proof. Producer and consumer
programs are test-only and are never installed or invoked by the library.

Libarchive 3.6.2 refuses the two genuine Python LZMA empty members with exit code 1 and `lzma unknown error 10`, while
Python and 7-Zip accept their complete empty outputs. Those exact refusals are retained as diagnostics, not counted as
libarchive parity. Every other consumer failure is fatal to fixture production. The requested `seven-1m` producer
setting actually emits a 262144-byte dictionary; the receipt preserves that observed capacity. The `seven-64k` case
declares 65536 bytes and returns 230017 original bytes, exercising dictionary wrap.

The reviewed wire grammar is [PKWARE APPNOTE 6.3.10](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT),
sections 4.4.3.2, 4.4.4 and 5.8. Exact reviewed-byte provenance accompanies the fixtures. Authored mutations separately
test property/header admission, EOS flag refusal, truncation, size/CRC disagreement, resource limits, cancellation and
policy capture. These mutations do not establish native no-EOS interoperability.

## Use the same archive through a read-only filesystem

The generic ZIP view uses these codecs through `archive.read()`. Its default selected read verifies the complete member
CRC, so selecting seven bytes can still require decoding the entire file. Set `verify: false` explicitly when a
checksum-pending preview is acceptable. BZip2 and LZMA kernel caps can be configured on the view as well as byte limits.

```ts
import { createFileSystem } from "@okikio/opfs";
import { createBlobSource } from "@okikio/opfs/source";
import { openZip } from "@okikio/opfs/archive/zip";
import { createZipAdapter } from "@okikio/opfs/view/zip";

export async function previewZipFile(archiveBytes: ArrayBuffer, path: string) {
  const archive = await openZip(createBlobSource(new Blob([archiveBytes])), {
    maxSourceBytes: 64 * 1024 ** 2,
    maxRequests: 4096,
    maxDecodedBytes: 128 * 1024 ** 2,
    maxOutputBytes: 16 * 1024 ** 2,
  });
  const fs = createFileSystem(createZipAdapter(archive, {
    maxOutputBytes: 1024,
    maxDecodedBytes: 64 * 1024 ** 2,
    lzma: { maxDictionaryBytes: 8 * 1024 ** 2, maxSteps: 128 * 1024 ** 2 },
    bzip: { maxMemoryBytes: 8 * 1024 ** 2, maxSteps: 256 * 1024 ** 2 },
  }));
  try {
    return await fs.readFile(path, { at: 0, length: 1024 });
  } finally {
    await fs.close();
  }
}
```

View construction validates its full namespace before exposing files; links, collisions and unsafe paths are refused. It
captures configured limits and nested codec-policy values. Mutating the original options later cannot raise those caps.
Filesystem cancellation signals still reach the archive, and the opening signal retains authority over every view read.
Closing the filesystem closes the view, while the archive and its source remain borrowed and usable by their original
owner. The filesystem returns bytes; callers needing codec/CRC evidence use the direct archive result.
