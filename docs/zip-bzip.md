# Preview BZip2 members in a ZIP archive

ZIP compression method 12 contains a BZip2 stream. `openZip()` can list its member and read a selected decoded interval
without extracting other files. This example returns at most 1 KiB and keeps separate finite allowances for the opened
archive and the current read.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openZip } from "@okikio/opfs/archive/zip";

export async function previewBzipZip(archiveBytes: ArrayBuffer, memberName: string, verify = false) {
  const archive = await openZip(createBlobSource(new Blob([archiveBytes])), {
    maxSourceBytes: 64 * 1024 ** 2,
    maxRequests: 4096,
    maxDecodedBytes: 128 * 1024 ** 2,
    maxOutputBytes: 16 * 1024 ** 2,
  });
  const member = archive.entries.find((entry) => entry.name === memberName);
  if (!member) throw new RangeError("ZIP member does not exist.");
  return await archive.read(member.id, {
    length: Math.min(1024, member.size),
    verify,
    maxDecodedBytes: 64 * 1024 ** 2,
    maxOutputBytes: 1024,
    bzip: {
      maxBlockBytes: 900000,
      maxMemoryBytes: 8 * 1024 ** 2,
      maxBlocks: 4096,
      maxSteps: 256 * 1024 ** 2,
      inputChunkBytes: 65536,
      outputChunkBytes: 1024,
    },
  });
}
```

`result.bytes` contains the selected plaintext. The source remains borrowed; no provider, native executable, SDK,
worker, registry or background connection is acquired. The production decoder is the same pure bounded kernel as
[`archive/bzip`](bzip.md). The example's `verify` parameter controls complete-member verification, not extraction to the
host filesystem. Parsed member names remain inert strings.

## Block checks and complete-member checks have different scopes

Method 12 accepts one non-randomized `BZh1` through `BZh9` stream inside the exact central-directory compressed extent.
Both the central and local version-needed values must be at least 4.6. Local names, flags, method and applicable
sizes/CRC must agree with the directory. Data-descriptor archives use central-directory sizes; this profile does not
independently validate descriptor bytes. Encrypted method 12, randomized blocks, concatenated streams, trailing whole
bytes and nonzero final padding are refused. Other supported ZIP methods keep their existing behavior.

Before returning a byte, the decoder reconstructs its entire BZip2 block and verifies that block's CRC. A small prefix
can therefore require much more work than its returned length. `result.codec.verifiedBlocks` reports the covering block
checks that passed. On an early prefix, `result.codec.integrity` and the ZIP `result.integrity` remain
`"checksum-pending"`: neither the BZip2 combined stream CRC nor the ZIP CRC over the full member has completed. For a
full member or `verify: true`, the reader consumes exact BZip2 EOF, checks its combined CRC, verifies the declared
decoded size and checks ZIP CRC32 before returning the selected interval. These results use `"checksum-verified"`. CRC
detects accidental corruption; it does not authenticate a publisher or prevent malicious modifications.

An empty BZip2 member still consumes its stream terminator and verifies both checks when read in full. A zero-length
prefix of a nonempty member returns no bytes and performs no BZip2 payload read; its checks remain pending.

## Work, memory and cancellation

The opening limits, ledger and abort signal remain authoritative for every member read. A per-read limit can narrow the
remaining allowance and cannot raise it. Additional ledgers and cancellation signals add authority. See the
[ZIP ownership contract](archive.md) for cumulative accounting and snapshot requirements.

`result.work.sourceBytes` and `requests` count local-header and compressed-member reads once. Internal codec output is
not charged as caller output: `outputBytes` counts only the selected returned interval. `decodedBytes` includes the
transformed BZip2 representation, the block verification pass, emitted plaintext replay and ZIP's plaintext scan/copy
pass. It can exceed both the member's declared size and the returned interval. `plan().decodedBytes` is a metadata lower
bound; it cannot know transformed-block costs before reading the stream. Execution can refuse a plan that looked
admissible when an exact block or work limit becomes known.

The `bzip` object exposes the kernel's optional block, memory, block-count, step, input/output quantum and `yield`
policies; its [documented defaults and hard ceilings](bzip.md) apply. A transformed block capacity is not a plaintext
limit because BZip2's final run-length expansion can be much larger. Typed scratch memory and caller-returned output
have separate limits. `result.codec.steps` and `memoryBytes` report kernel work and its typed-buffer accounting; they do
not claim a JavaScript heap ceiling, hard time deadline or consumer memory bound.

Prefix completion cancels the owned decoder reader and awaits its terminal result, including in-flight borrowed reads
and scheduling callbacks. Abort and provider failures remain observable; reader cleanup failures retain the primary
reason. The caller still owns the source. Opening/read options and kernel-policy values are captured before source
awaits, so replacing their fields does not change the admitted operation.

## Independent wire-format evidence

The retained historical producer `tests/fixtures/zip-bzip/create.py.snapshot` used Python `zipfile.ZIP_BZIP2` and
genuine 7-Zip method-12 output at levels 1 and 9. Python's forward-only writer supplies independent
bit-3/data-descriptor cases. Python `zipfile`, 7-Zip and libarchive each extract and compare every original byte. The
native producer sometimes chooses STORED for tiny or empty inputs; those entries are recorded as method 0, rather than
counted as BZip2 proof. The six archives contain twenty genuine BZip2 members, including empty streams and
multiple-block data.

Current fixture tooling is `tests/fixtures/zip-bzip/create.ts`. It produces genuine 7-Zip archives and separately
labelled authored descriptor framing over their unchanged native compressed extents. Both 7-Zip and libarchive compare
complete member bytes. These new native-only profiles do not recreate or relabel the historical Python profiles. An
explicit `--output` destination is required, and the retained corpus and its historical receipt stay unchanged until a
maintainer reviews a new run.

The fixture provenance records tool/package versions, producer/fixture hashes and the exact reviewed
[PKWARE APPNOTE 6.3.10](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT) bytes. The native programs are
test-only producers/consumers and are never imported or installed by the library. Authored mutation tests separately
cover block/footer corruption, ZIP CRC mismatch, truncated/concatenated extents, version/encryption refusal, budgets,
captured policy, cancellation and byte-at-a-time packed input.
