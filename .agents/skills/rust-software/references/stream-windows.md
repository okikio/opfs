# Make results independent of transport chunk boundaries

Use this for streamed bytes, rolling statistics, parsers, framed messages, or
large-data scans. A read buffer, logical record, SIMD block, and rolling window
are different units. Name the unit and its final-partial-input behavior first.

## Specify state before choosing a buffer

Write the carry state, consumed offset, emitted output, maximum retained data,
and finalization rule. Define empty input, incomplete input, malformed data,
EOF, short reads, interruptions, cancellation, and backpressure. Use checked
offset/length arithmetic, including on 32-bit Wasm. Validate zero-width windows
before calling APIs that panic for them.

For a fixed byte pattern of length `m`, carrying at most `m - 1` prior bytes
can preserve cross-chunk matches, provided duplicates and absolute offsets are
handled correctly. An automaton such as KMP can retain prefix state instead.
For grammar parsing, escaping, nesting, or variable-width records, a fixed
overlap is not automatically sufficient: preserve the parser's actual state.

For rolling windows, define whether partial windows count, how eviction works,
and which order produces output. Floating-point rolling sums can drift; test
error bounds and long-duration behavior, and select compensation/recomputation
when the product accuracy requires it.

## Consume bytes exactly once

`BufRead::fill_buf` exposes the current borrowed buffer; process what is usable,
then `consume` exactly that amount after the borrow ends. Do not retain a slice
across refill/reuse. `Read` may return less data than requested. A single read
does not promise a complete record or complete file.

Bound record size and total work before buffering until a delimiter. Rust's
buffered delimiter readers explicitly warn that a sender can avoid sending
that delimiter indefinitely. Apply byte/time budgets and cancellation at the
appropriate owner; do not turn EOF and a size-limit rejection into one result.

Use a ring or `VecDeque` when its FIFO access fits. Account for both slices of a
wrapped deque. Making it contiguous can move data; measure that cost rather
than hiding it behind a "zero-copy" claim. A SIMD block must never load beyond
the initialized range, even if spare capacity or a guard page happens to exist.

## Test segmentation as a property

For short fixtures, enumerate every partition and compare full output with a
whole-input oracle. Include empty chunks between real chunks. For larger data,
save randomized partition seeds and include lengths around SIMD/block/record
sizes. Compare positions, ordering, duplicates, final state, and errors, not
only counts or output lengths.

Required fixtures include repeated/overlapping delimiters, CRLF split between
bytes, embedded NUL, high-bit bytes, split multibyte UTF-8, invalid/truncated
UTF-8, absent delimiters, oversized records, wraparound, and EOF at every state.
For concurrent producers, additionally test bounded queues and cancellation
while partially consumed data is retained.

For a byte-matching probe, enumerate partitions and overlapping matches on the
required hosts. That establishes the tested matcher contract, not an HTML
parser or arbitrary streaming grammar. Test the real parser separately.

## Sources

- [Read contract](https://doc.rust-lang.org/std/io/trait.Read.html)
- [Buffered reads and delimiter limits](https://doc.rust-lang.org/std/io/trait.BufRead.html)
- [Deque representation and operations](https://doc.rust-lang.org/std/collections/struct.VecDeque.html)
- [Incomplete UTF-8 suffixes](https://doc.rust-lang.org/std/str/struct.Utf8Error.html)


Read the [reproducible evidence requirements](evidence-index.md) before relying on a research observation.
