# Preview stored WARC blocks

`openWarc()` indexes uncompressed WARC 1.0 and 1.1 records. You can list capture metadata and read a selected byte range
without retrieving every stored block. The record's numeric `id` is its position in this file. A WARC record ID or
target URI can occur more than once and never replaces another entry in the index. WARC specifies globally unique record
IDs; preserving a duplicate does not certify its semantic validity.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openWarc } from "@okikio/opfs/archive/warc";

export async function preview(warcBytes: ArrayBuffer): Promise<void> {
  const archive = await openWarc(createBlobSource(new Blob([warcBytes])));
  const record = archive.entries.find((entry) => entry.type === "response" && entry.readable);
  if (record) {
    const preview = await archive.read(record.id, { length: Math.min(record.size, 1024) });
    console.log(record.recordId, record.fields, preview.bytes, preview.integrity); // integrity: "none"
  }
}
```

The application supplies `warcBytes: ArrayBuffer` from a file, download or another storage source. The reader borrows
the source and never closes it. A multi-range index requires the source's `stability` declaration, as supplied by
`createBlobSource()`, or explicit `allowUnverifiedSource: true`. An identity string alone does not establish stability.
If accepting unverified bytes, the caller accepts that the index and later reads can refer to different contents.

The stored block can include an embedded HTTP status line, headers and body. `Content-Length` in the WARC header counts
that complete block in **bytes**. Embedded HTTP lengths and delimiter-like bytes never establish record boundaries. The
WARC `Content-Type` describes the block, such as `application/http`; it is not the captured HTTP entity's media type.
The reader never executes archived content, follows a URL, creates a path, decodes HTTP transfer/content encoding, or
claims that a partial block is a complete web page.

## Interpret the index and failures

The index preserves ordered field names and unfolded values. Only surrounding ASCII space/tab is trimmed; continuation
lines join with one space. Core singleton fields repeated with any casing fail. Repeated `WARC-Concurrent-To` fields and
unknown extension fields remain ordered. Unknown extension repeatability is not guessed. Duplicate record IDs remain
separate ordinals. Version-specific URI values, dates and encoded words remain uninterpreted strings. Required fields,
record ID bracket/scheme shape, field syntax, UTF-8, exact byte extents and CRLF framing are checked; this is not a
complete ISO semantic validator of dates, URI schemes, per-type required fields or RFC 2047 encoded words.

`readable: false` marks revisit records, segmented records, continuation records and unknown record types. Their
metadata is available, but `read()` and `verifyBlock()` reject them with `unsupported-profile`. No reference resolver or
segment assembler is installed. A `truncated` value records a producer's capture-truncation marker. Even a verified
block can be only a captured prefix of the original resource.

Gzip, including concatenated per-record gzip members, ARC, WACZ and other wrappers are unsupported. ARC has its own
descriptor and framing rules; support remains pending and is not implied by WARC support. Decompressing an entire file
outside this API requires the application's own finite input/output and decompression policies.

A malformed length, missing field, invalid header or separator fails with `invalid-archive`. Recognized gzip/ARC
signatures, an unsupported version line or unsupported selected content fail with `unsupported-profile`. Policy failures
use `budget-exceeded`, digest mismatches use `checksum-mismatch`, and caller range mistakes use `RangeError`. Source and
crypto failures retain their original errors. An `AbortSignal` reaches every source read and is checked after hashing;
WebCrypto hashing itself cannot be interrupted. No bytes from a cancelled read are returned.

## Verify a bounded complete block

Digest checking is optional and explicit. Supply the application's crypto capability:

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openWarc } from "@okikio/opfs/archive/warc";

export async function verify(warcBytes: ArrayBuffer, subtle: Pick<SubtleCrypto, "digest">): Promise<void> {
  const archive = await openWarc(createBlobSource(new Blob([warcBytes])));
  const proof = await archive.verifyBlock(0, { subtle, maxVerifyBytes: 1024 * 1024 });
  console.log(proof.integrity, proof.algorithm, proof.work); // stored-block-digest
}
```

This checks `WARC-Block-Digest` over the complete stored block only. The accepted verification profile is `sha1:` or
`sha256:` followed by canonical uppercase, unpadded RFC 4648 Base32. Unsupported or missing digest representations fail
verification without making the record unindexable. A payload digest is preserved but **never verified**: an HTTP
entity, revisit reference or assembled logical payload may differ from the stored block. A matching hash detects
corruption; it does not authenticate the archive or its author. SHA-1 support exists for archival interoperability, not
security trust.

WebCrypto's digest API is not a streaming hash. Verification materializes the entire block and makes a fixed local copy
for crypto admission. `maxVerifyBytes` defaults to 1 MiB and cannot exceed 16 MiB. Temporary memory can include the
source result, the local copy and the crypto implementation's internal storage. Verification counts internal block bytes
as `decodedBytes`; it returns no payload and records `outputBytes: 0`. A normal `read()` charges both decoded and
returned output bytes. Both operations charge source bytes and requests before source acquisition. Share a `ledger`
across open, read and verification calls to enforce an aggregate work allowance.

Opening defaults to 10,000 records, 64 KiB per header, 8 KiB per physical line, 128 fields per record and 4 MiB
cumulative header bytes. Lookahead reads at most 1 KiB at a time; it can include a prefix of a block, and those bytes
count as source work. Large blocks are otherwise skipped by offset. Header bytes count as decoded work. General archive
defaults are 64 MiB source bytes, 4,096 requests, 64 MiB decoded bytes and 16 MiB returned output per operation. These
independent policies can stop an operation before its record-count ceiling. The index retains objects and strings
proportional to admitted metadata, not the sizes of skipped blocks. These are implementation/caller safety policies, not
WARC limits.

The framing and field policy follows the primary
[WARC 1.0 specification](https://iipc.github.io/warc-specifications/specifications/warc-format/warc-1.0/) and
[WARC 1.1 specification](https://iipc.github.io/warc-specifications/specifications/warc-format/warc-1.1/). Fixture
provenance and reproduction instructions live in `tests/fixtures/warc/README.md`. Independent producer evidence covers
the saved fixtures; authored corruptions exercise refusal and budget behavior rather than full WARC conformance.
