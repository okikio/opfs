# Preview numeric ORC columns

A preview decodes one physical numeric column from the complete streams of each
intersecting stripe, then returns the requested rows and a separate validity
mask. It does not create an SQL engine or require a native runtime dependency.

```ts
import { openOrc } from "@okikio/opfs/dataset/orc";
import { createByteSource } from "@okikio/opfs/source";

export async function preview(bytes: ArrayBuffer) {
  const dataset = await openOrc(createByteSource(new Uint8Array(bytes)), {
    maxSourceBytes: 64 * 1024 * 1024,
    maxDecodedBytes: 64 * 1024 * 1024,
    maxOutputBytes: 1024 * 1024,
    maxFooterBytes: 1024 * 1024,
    maxSelectedStreamBytes: 8 * 1024 * 1024,
    maxRows: 100,
  });
  const column = dataset.columns.find((column) => column.supported);
  if (!column) throw new Error("No physical numeric column is available.");
  const result = await dataset.read(column.id, {
    offset: 0,
    length: Math.min(100, dataset.rows),
  });
  return {
    name: column.name,
    values: result.values,
    validity: result.validity,
    stripes: result.stripes,
    work: result.work,
  };
}
```

`createByteSource` owns its input snapshot. A custom `ByteSourceType` remains
borrowed: the reader captures its size, identity, stability and read method, but
never closes it. Provider or caller stability must keep every subsequent range
in the same physical snapshot. An identity alone does not establish that
contract. `allowUnverifiedSource: true` is an explicit escape hatch, without a
consistency or authentication guarantee.

## What this profile interprets

The file must have a three-byte ORC header, version 0.11 or 0.12, generic
compression NONE, and a flat STRUCT root. BOOLEAN, BYTE, SHORT, INT, LONG, FLOAT
and DOUBLE leaf columns are eligible. BOOLEAN returns 0/1 bytes; signed integer
widths select the corresponding typed array; LONG returns exact bigint. IEEE
values use little-endian wire storage and JavaScript numeric semantics. NaNs
need not retain their original payload bits.

A column's `supported` field describes schema eligibility. Each selected stripe
must also use DIRECT encoding and only the supported PRESENT/DATA stream roles.
Integer DIRECT uses RLEv1. DIRECT_V2, dictionary encodings, generic compression,
nested schemas, encryption, dates, timestamps, strings and decimal conversion
are outside this profile. Unsupported flat leaf types can be listed, but their
values cannot be read. No checksum or authenticity evidence is fabricated:
`integrity` is always `"none"`.

Null entries have zero output slots and `validity[index] === 0`. Test the mask
before interpreting a slot; zero itself can be a valid value. An absent PRESENT
stream means every row is present. A selected read validates complete selected
column streams, including run terminals and decoded counts, even when the
requested row range is a small prefix. It does not acquire unrelated column
bodies. Stripe footers and index geometry are metadata, not evidence that other
column values are well formed.

## Geometry, authority and cost

The opening footer supplies bounded stripe declarations. Stripe physical ranges
must be disjoint, contiguous, and cover exactly the body between the header and
metadata tail. This initial profile has no authority for arbitrary inter-stripe
padding. Serialized stream extents must account exactly for each selected
stripe's index and data sections. Row counts must sum to the file declaration.

The specification prose counts header plus body in `contentLength`; the official
C++ writer subtracts `headerLength`. The reader accepts these two exact
equations and exposes `contentLengthBasis` as `"header-and-body"` or `"body"`.
Neither convention relaxes physical stripe bounds. No third convention is
inferred.

Opening byte/output/request limits remain aggregate authority across later
reads. A read's additional ledger and limits can narrow that authority. Passing
the same external ledger at opening and reading does not charge it twice.
Reservations are not refunded after a later failure. All selected stream source
bytes and requests, decoded work and returned output are admitted before output
allocation or selected-body I/O. Stripe footer I/O occurs first to discover
those costs. This is not an exact JavaScript heap accounting guarantee.

A read can retain the selected PRESENT and DATA buffers, their decoded scalar
state and owned result arrays. `maxSelectedStreamBytes` bounds aggregate
selected buffers per call; `maxRows` bounds returned rows, while `maxSteps`
separately bounds expanded full-stripe work. File and stripe footer bytes,
stream counts, strings, nesting and conservative retained descriptor allowances
have separate caps. `dataset.work` is opening-only work; each result reports its
own read work. The opening signal remains authoritative; a read signal adds
cancellation. Foreign budget callbacks are checked for abort immediately after
each call. Native source reads can settle after cancellation; the reader waits
for the borrowed read and checks abort before returning output.

## Format sources and evidence

The grammar is pinned to Apache ORC Format v1.1.1 commit
[`0a48af85a6c067fdd681f2dbacc35f0b05a46715`](https://github.com/apache/orc-format/tree/0a48af85a6c067fdd681f2dbacc35f0b05a46715),
including `specification/ORCv0.md`, `specification/ORCv1.md` and
`src/main/proto/orc/proto/orc_proto.proto`. Scalars use Protobuf last-one-wins
semantics. Interpreted child messages are repeated; encryption message presence
refuses immediately, including when followed by another empty instance. Unknown
binary fields are bounded opaque data, not recursively invented message trees.

The little-endian IEEE interpretation and body-only content length are checked
against official Apache ORC C++ release 2.1.2 commit
[`e955e2bb5a0c3c9a0bb24a9039405ecea1878444`](https://github.com/apache/orc/tree/e955e2bb5a0c3c9a0bb24a9039405ecea1878444),
`c++/src/ColumnReader.cc` and `c++/src/Writer.cc`. These are
specification/reference inputs, not copied production implementations. The
[fixture provenance](https://github.com/okikio/opfs/blob/codex%2Frelease-2026-10-06/tests/fixtures/orc/provenance.json)
retains source digests, the admitted PyArrow wheel, original notices and native
execution receipts. Eighteen genuine files cover both versions, 0/37/8192 rows
and nonnullable/mixed-null/all-null data. Every supported column is compared
against the complete original typed values and masks, including exact bigint,
NaN and signed zero. Selected ranges cross native stripe boundaries. The modern
integer DIRECT_V2 cases remain explicit refusal controls.

The native writer and reader share Apache C++ ORC through PyArrow 20.0.0. This
checks real wire and original-value interoperability against the separate
TypeScript reader; it does not compare two independent native ORC engines.
Authored wire tests remain separate grammar controls, including the alternate
content-length equation.

## Measure preview work

[bench/orc.bench.ts](https://github.com/okikio/opfs/blob/codex%2Frelease-2026-10-06/bench/orc.bench.ts)
separates cold footer indexing, warm seven-row previews that cross two stripes,
a warm full integer column, and cold open plus preview. The selected profile
decodes complete column streams in intersecting stripes, so a seven-row result
can cost substantially more than seven values. Labels retain source bytes,
requests, decoded work and returned bytes. A raw already-decoded Blob slice is a
copy lower bound: it has no footer, null mask or stream decoding and is not an
equivalent ORC implementation.

The harness checks all eighteen native originals and refusal controls before
sampling. Fixture loading and original-value checks are outside timing; fresh
opening is included only in cold lanes. It uses finite aggregate benchmark
allowances, serial calls and the existing Mitata report path. ORC datasets own
no native resources and expose no disposal operation. No timings, retained-heap
measurement or performance comparison have been established by adding this
harness.
