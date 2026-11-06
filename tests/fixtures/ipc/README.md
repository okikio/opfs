# Arrow IPC native fixture

This fixture prepares native Arrow IPC images for a future reader. It does not add Arrow IPC support to the library. The
TypeScript recipe writes original columns, then Arrow C++ 20 writes a V5 file or stream and reads every batch back. The
recipe compares the returned columns with those originals before saving an evidence file. No project reader supplies an
expected value.

The 6 November 2026 qualification in `native/` passed all ten profiles. The final repeat used the corrected shared
supervisor and error-preserving temporary cleanup; its isolated receipt is `b08cc08f-c149-47dc-a3ae-7fe1f6d00547`. The
container ran offline with 1 GiB memory/swap, one CPU and 256 PIDs, was not OOM-killed and was removed after the
producer settled. The command below repeats that producer against separately admitted inputs. Keep each repeat's output
separate from this corpus and from older Arrow, Parquet or ORC evidence.

The later `native/repeat/` capture also passed all ten profiles after the cleanup flow was rewritten to pass lint while
preserving the original error beside a cleanup error. Its isolated receipt is `943cf8ea-38b7-4488-81cd-4e3553a57cdc`,
with the same offline resource limits, no OOM and completed container removal. The first capture stays unchanged; each
directory hashes its own exact native output.

```sh
node tests/fixtures/ipc/producer-run.ts --artifacts /native-input --output /evidence/ipc-new
```

Run from the repository root in the isolated Linux ARM64 qualification image with Node 26, a C++17 compiler and
`/usr/bin/prlimit`. `/evidence` must already exist; `ipc-new` must not exist. The wrapper creates that directory and
retains `independent.json`, `native.log` and `native-state.json`. A failed run must not be reported as qualified merely
because it left files behind. Use a new output path for another attempt.

`/native-input` is the existing offline Arrow 20 admission from [the Arrow artifact recipe](../parquet/RECIPE.md). It
must contain `arrow.whl`, `include/`, the admitted libraries and their receipt. This recipe rechecks the pinned wheel,
headers and libraries before compilation. It neither installs nor loads Python or the wheel's Python extension. The
shared admission currently requires both `libarrow.so.2000` and `libparquet.so.2000`; this separate IPC harness links
only `libarrow.so.2000`. No network access is needed after admission.

The exact native compile command is recorded in `independent.json`. Its shape is:

```sh
c++ -std=c++17 -O1 -Wall -Wextra -I /native-input/include tests/fixtures/ipc/native.cpp /native-input/libarrow.so.2000 -Wl,-rpath,/native-input -o /owned-temporary-folder/native
```

The recipe owns its temporary directory and removes it on success or failure. Each native command has a 120-second
timeout, a 4 MiB diagnostic limit and a 32 MiB file-size limit through the shared runner. The outer process group has a
180-second deadline and a bounded final cleanup join. Run it with the same isolated memory budget as the existing Arrow
qualifiers. Each authored column input and decoded column output is at most 1 MiB; batches have at most 64 rows, with at
most three batches per image. Final retained corpus bytes are capped at 16 MiB and JSON at 32 MiB.

## What the first corpus checks

Each image has six nullable fields: `i` (int32), `q` (int64), `d` (float64), `b` (boolean), `s` (UTF8) and `x` (binary).
Five scenarios run in both file and stream form, for ten images:

| Scenario         | Rows in each batch | Purpose                                                            |
| ---------------- | ------------------ | ------------------------------------------------------------------ |
| Schema only      | no batches         | A valid schema without records                                     |
| Empty batch      | 0                  | A record batch with no rows                                        |
| Mixed multibatch | 0, 17, 33          | Batch boundaries, nullable columns and non-byte-aligned validity   |
| All null         | 3, 0, 9            | Validity cannot be inferred from physical zero values              |
| No null          | 1, 33              | Present values and an empty validity bitmap are different concepts |

The authored originals retain full little-endian integer bytes, including int64 extrema and values beyond JavaScript's
exact-number range. Integers never pass through JSON numbers. Float64 comparison preserves signed zero and tests NaN,
infinities and subnormal values; it does not assert a particular NaN payload. UTF8 examples include multibyte
characters, a literal BOM and an empty string. Binary values include zero, non-UTF8 bytes and empty values. Separate
validity and offset bytes distinguish null from empty.

The native reader validates the complete schema, batch count, row counts and arrays. TypeScript compares every returned
validity byte and typed value, plus all variable-column offsets and payload bytes. File magic and modern stream
continuation/end markers receive small authored framing checks. V5 metadata and uncompressed writing are explicit native
writer options; those framing checks are not an independent complete IPC parser.

Arrow C++ owns both encoding and decoding here. This qualification establishes native same-library round trips against
authored originals, not independent two-engine interoperability or acceptance by an OPFS reader. There is no dictionary,
nested, compressed, legacy, unsigned or big-endian profile in this slice. Those remain separate work in
[the Arrow plan](../../../planning/storage/ARROW.md).
