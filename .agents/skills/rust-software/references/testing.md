# Test the contract before measuring speed

Use the repository's Rust test owner and actual toolchain. Keep tests near the
owning capability. Unit tests may inspect a local algorithm; integration tests
must exercise the connected public operation. Doctests protect usable examples.
Do not replace the real host with a mock when host behavior is the question.

## Choose the smallest independent oracle

Compare exact bytes, events, spans, errors and order where the contract requires
them. Lengths and aggregate sums can hide missing content or wrong associations.
For optimized scanners, keep a simple scalar/reference implementation whose
logic differs from the candidate. Check both against hand-checked cases.

Use exhaustive small cases for finite state spaces and property tests for larger
ones. High-value properties include:

- identical semantic output for every partition of the same byte stream;
- scalar/SIMD equivalence across tails, alignment, values and feature selection;
- bounded retained state regardless of producer chunk size or fragmentation;
- no duplicate or missing overlapping matches at window joins;
- round trips and canonicalization laws with explicitly stated exceptions;
- exactly-once release and no late write after terminal cancellation;
- equivalent native/Wasm/FFI behavior, including malformed inputs and failures.

Do not encode the candidate algorithm again as the expected result. Keep shrunk
failures as regression inputs with the seed, tool version and error signature.

## Target specific hazards deliberately

| Surface | Cases that can expose the real failure |
| --- | --- |
| Bytes and text | Empty, NUL, invalid/incomplete UTF-8, multibyte split, CRLF |
| SIMD | 0/1/lane-1/lane/lane+1 lengths, misalignment, final-page tail |
| Arithmetic | Maximum allowed value, one over, checked index/length overflow |
| Framing | Late terminator, many reads before parsing, multiple frames per read |
| Concurrency | Cancel before/after publish, consumer exit, queue full, shutdown |
| Wasm memory | Growth, stale views, repeated allocate/free, failed allocation |
| FFI | Null/length combinations, wrong lifetime, caller ownership, panic path |
| Packaging | README/shader/schema/include input present in packaged/staged tree |

A test that merely calls a function does not establish its contract. An isolated
reproduction can prove a defect without building the whole application; state
that scope. A paused product build remains unrun when only an extracted module
was tested. Do not alter production imports to make a local environment green.

## Use safety tools for the risks they can observe

Use Miri on small supported ownership/unsafe tests. Its absence of errors does
not prove soundness, all interleavings, foreign libraries or machine intrinsics.
Use Loom for an isolated concurrency protocol when schedules/ordering matter.
Use fuzzing on parsers and ABI input validation with bounded work and retained
crashes. Sanitizers and platform tooling complement tests on real machines.
Record unsupported intrinsics or host APIs rather than suppressing the finding.

Keep native, browser and WASI execution rows separate. A portable test body can
be reused with different runners, but startup, import, event-loop and permission
semantics still need host tests. Nextest does not replace doctests automatically.

Before release, inspect the actual native library/Wasm/package and exercise a
clean consumer. Record passed, failed, skipped and blocked commands separately.
Keep performance checks separate from correctness; see [benchmarks](benchmarks.md).

Sources: [Cargo test](https://doc.rust-lang.org/cargo/commands/cargo-test.html),
[Miri](https://github.com/rust-lang/miri), [Loom](https://github.com/tokio-rs/loom),
[Rust fuzz book](https://rust-fuzz.github.io/book/),
[wasm-bindgen tests](https://wasm-bindgen.github.io/wasm-bindgen/wasm-bindgen-test/).
