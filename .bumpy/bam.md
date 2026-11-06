---
"@okikio/opfs": minor
---

Preview complete BAM alignment records through bounded, independently checked BGZF blocks.

The optional `@okikio/opfs/dataset/bam` entry borrows a stable byte source, reads its header and ordinal reference
dictionary, then yields owned record pages. A record can cross compressed blocks. Every visited block has its exact
DEFLATE extent, CRC32 and decoded length checked before its bytes contribute to a record.

```ts
import { openBam } from "@okikio/opfs/dataset/bam";
import { createBlobSource } from "@okikio/opfs/source";

export async function preview(file: Blob, signal: AbortSignal) {
  const bam = await openBam(createBlobSource(file), { signal });
  for await (const page of bam.records({ maxRecords: 20, signal })) {
    console.log(bam.header.references, page.records, page.end, page.verification, page.work);
  }
}
```

`maxRecords` is a deliberate preview count. Reaching it reports `preview` without probing an unread record, even when
that count equals the true total. A separate lifetime policy bounds source, requests, decoded/output work, records and
block attempts across opening and restarted iterators. Checked blocks are corruption evidence, not authentication or
verification of unread records. The canonical physical final marker is a required first-profile restriction; an interior
empty marker is not EOF.

The source always remains caller-owned. Opening's signal applies only to opening; pass the same signal to iteration when
both stages should share cancellation. Returned quality arrays own their bytes and remain caller-mutable. Missing
sequence and missing quality are explicit null values. Ordered scalar auxiliary entries retain wire encodings;
unsupported auxiliary values and long-CIGAR `CG` records fail before partial output escapes.

See the [BAM guide](../docs/bam.md) for coordinates, page endings, limits, recovery and native proof boundaries.
Regional BAI/CSI queries, CRAM, writing, checkpoint resume and remaining auxiliary profiles are not included. Focused
candidate tests passed on Deno, Node and Bun; installed-package and exact-head CI gates remain separate delivery checks.
