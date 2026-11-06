# Preview BAM alignments without loading the whole file

BAM stores sequencing reads and their relationship to reference sequences. Use `openBam` to show the header and a small
prefix of alignments from a stable file or revision-pinned object. You do not need to create a filesystem, driver or
adapter. This is a dataset reader over the [byte-source contract](source.md).

Status: focused candidate tests passed on Deno, Node and Bun in receipt `e1990cbe-7cea-4255-8b5d-4089c5f6aa33`,
including complete original SAM comparisons. The public package entry is wired; installed-package consumers passed in
receipt `eb663979-e1bf-4c92-b91b-b10c3a770916`. Exact-head CI remains the delivery gate. Four native profiles do not
establish support for every BAM feature.

This complete function accepts a caller-owned immutable Blob and previews up to 20 records. Pass a revision-pinned
object source instead when the data lives remotely. Every source must declare its stability; a name alone does not prove
that its bytes will stay unchanged.

```ts
import { openBam } from "@okikio/opfs/dataset/bam";
import { createBlobSource } from "@okikio/opfs/source";

export async function preview(file: Blob, signal: AbortSignal) {
  const bam = await openBam(createBlobSource(file), {
    signal,
    maxSourceBytes: 8 * 1024 * 1024,
    maxRequests: 256,
    maxDecodedBytes: 8 * 1024 * 1024,
    maxOutputBytes: 8 * 1024 * 1024,
    maxTotalRecords: 100,
  });
  console.log(bam.header.text, bam.header.references);
  for await (const page of bam.records({ maxRecords: 20, pageRecords: 10, signal })) {
    for (const read of page.records) {
      const reference = read.referenceId < 0 ? undefined : bam.header.references[read.referenceId];
      console.log(read.name, reference?.name, read.position, read.sequence, read.qualities);
    }
    console.log(page.end, page.verification, page.work);
  }
}
```

## A compressed block is not a record

BGZF is a restricted gzip layout that divides compressed input into independently checked blocks. Each block contains at
most 64 KiB of compressed bytes and 64 KiB of decoded bytes. A BAM alignment record may cross several blocks. For
example, the native 160,000-base fixture places its one record across block boundaries. Stopping halfway through one
block would not produce a complete checked record.

```mermaid
flowchart LR
  Source[Stable exact-range source] --> Block[Read one complete BGZF member]
  Block --> Decode[Owned DEFLATE decoder]
  Decode --> Check[Check exact termination and CRC32 / ISIZE]
  Check --> Assemble[Assemble BAM header or record across blocks]
  Assemble --> Page[Return complete owned record page]
  Page --> Stop[Stop at preview count without probing the next record]
```

Opening reads the physical final marker, then enough blocks to parse the header and reference dictionary. Iteration
continues from that header position, decoding only the blocks needed for complete selected records. A small preview can
still decode an entire block containing later records. `work` exposes source bytes, requests, decoded bytes,
conservative output storage, BGZF blocks, DEFLATE blocks and record attempts. These counters describe the reader's work;
a foreign source must account for hidden transport work itself.

Every visited block has its complete raw-DEFLATE extent, CRC32 and decoded length checked before its bytes are used.
`verification: "checked-blocks"` does not claim that unread blocks are intact. CRC32 detects corruption; it does not
authenticate the source. The first profile also requires the canonical 28-byte marker at the physical end. This is a
restricted compatibility choice, not a universal BAM validity rule. An identical empty marker inside the file is skipped
as an empty block, and does not stop iteration or prove that the middle of the file is intact.

## Read pages and recognize why they stopped

`records()` starts a new iterator immediately after the header. `maxRecords` is deliberate selection, with a default of
20. `pageRecords` controls page size, defaults to 20 and accepts 1 through 256. A yielded page reports:

| `end`     | What the reader established                                                                  |
| --------- | -------------------------------------------------------------------------------------------- |
| `more`    | This page is complete; the iterator has not yet established EOF.                             |
| `preview` | The requested record count was reached. No next-record probe was performed.                  |
| `eof`     | The iterator reached the physical source boundary after checked blocks and complete records. |

A count equal to the true record count still reports `preview`, because establishing EOF would require more work. A
natural EOF can arrive as an empty terminal page after an earlier full page. `maxRecords: 0` returns an empty preview
page without reading any records. Breaking out of `for await` releases iterator ownership without closing the source. At
most one iterator may be active. Finish or return it before starting another.

The reference dictionary uses ordinal IDs. Names are descriptive data, never paths. Coordinates are zero-based, with
`-1` meaning absent; convert to one-based coordinates explicitly when displaying SAM-style positions. A virtual offset
is a `bigint` combining a compressed block offset and an in-block byte position. It is useful for diagnostics, but is
not an ordinary byte distance or a supported resume checkpoint.

A zero-length BAM sequence is returned as `sequence: null`. An all-255 quality field means missing quality and becomes
`qualities: null`, even when sequence is present. Mixed missing/nonmissing qualities are refused in this profile, as are
quality values above 93. Returned quality arrays own their storage and remain caller-mutable; later iteration cannot
change them. Header objects and the reference dictionary are frozen.

CIGAR operations describe how the read consumes query and reference positions. Their original order is retained.
Auxiliary entries also remain ordered and retain their wire encoding, including signed and unsigned integer widths. The
supported values are `A`, `c`, `C`, `s`, `S`, `i`, `I`, finite `f` and `Z`. The reader refuses `H`, `B`, unknown types
and the `CG` long-CIGAR convention before returning that record. A page containing an unsupported record fails rather
than silently dropping auxiliary data or yielding a partly decoded record.

## Keep selection and safety limits separate

`maxTotalRecords` is a lifetime safety limit, not the requested preview count. It defaults to 1,024 and stays charged
across restarted iterators. Source, request, decoded, output and block budgets also include opening, failed attempts and
previous iterations. Restarting an iterator cannot reset them. A caller-supplied archive ledger can further constrain
nested operations; the reader's own lifetime policy still applies.

Defaults include 64 MiB source and decoded work, 4,096 requests and BGZF blocks, 65,536 DEFLATE blocks, 8 MiB output
storage, 1 MiB header text, 4,096 header lines and references, 1 MiB record bodies, 1,024 reference-name bytes, 65,535
CIGAR operations and 256 auxiliary entries per record. These are separate policy dimensions. The implementation caps
configured header/record extents at 8 MiB, reference names at 65,536 bytes and compressed source extent at 48 bits for
virtual offsets. Output storage uses conservative admission rather than measuring the JavaScript heap.

An exhausted safety limit throws `ArchiveError` with `code: "budget-exceeded"`. Malformed grammar, unsupported profiles
and checksum mismatches use the corresponding archive error category. Original source failures retain their exact
reason. No automatic retry occurs. Increase a policy only after checking the failed location and work counters; a new
stable source and dataset start a new lifetime.

## Cancellation and ownership

Opening's `signal` owns opening only. Each iterator accepts its own signal. Aborting the opening controller after
`openBam` resolves does not cancel a later iterator. If both stages should stop together, pass the same signal to both
calls, as in the example.

The source is always borrowed. The reader never closes it on success, failure, abort or early return. It acquires no
stream reader and starts no background read. An outstanding `next()` awaits its current source operation; cancellation
requires a signal and a source that observes it. Synchronous DEFLATE checks cancellation at block boundaries and before
return, rather than claiming preemptive interruption.

## Evidence and remaining capabilities

The corpus is pinned at SHA-256 `4b18297001bdc669a16801340dcb7e5847c073a5aa577cd6baf0c59de5297ebf`. Native receipt
`86ab95db-79e3-4541-9095-0f171e5ae0f0` covers header-only, mixed mapped/unmapped, reference-free and 160,000-base
crossing-record originals. Samtools and HTSlib write and read the data, so this is independent of candidate code and
shares one native library. Candidate tests compare complete reconstructed SAM with those authored originals. Those
comparisons and the corruption, cancellation and lifetime controls passed in Deno, Node and Bun in receipt
`e1990cbe-7cea-4255-8b5d-4089c5f6aa33`.

Maintainers can run `deno task bench:bam` inside the bounded test runner. It checks the native fixture and original
sequence/qualities before timing three different workloads: native whole-file gzip decoding without BAM grammar, opening
plus an empty preview, and opening plus one complete 160,000-base crossing record. Labels include source bytes,
requests, decoded bytes and checked blocks. They explain where the work goes; the different workloads are not a
same-task speed comparison. Receipt `e5be0ba2-c7d8-404a-bcd7-a778847bb0ad` records the first passing benchmark run.

The [BAM plan](../planning/storage/BAM.md) keeps BAI/CSI regional queries, index/source binding, CRAM, writing,
resumable checkpoints, long CIGAR and remaining auxiliary types as separate work. This reader supplies a sequential
prefix preview, not indexed selection or alignment analysis.
