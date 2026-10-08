# Tests borrowed from upstream projects

Run the retained cases against memory and the current host filesystem:

```sh
deno task test:upstream
deno task test:upstream:node
deno task test:upstream:bun
deno task test:upstream:browser
```

These tasks run without a TypeScript compiler pass. The dedicated Deno task grants only file read/write permissions and
keeps operation/resource leak sanitizers enabled. The browser task uses the existing Vite and Playwright infrastructure.
`deno task test`, the Node and Bun test tasks, and the normal browser task also include these suites. The checker tasks
include the adapted files for CI; the raw upstream snapshots are excluded from formatting and lint discovery.

The suite copies 37 Web Platform Tests callback bodies: 20 writable-stream cases, four file-handle lookup cases, and 13
synchronous read/write/truncate cases. It preserves the original test titles, inputs and byte oracles. A small
structural port replaces the WPT registration API. Each host case gets a fresh filesystem, and each browser case gets a
private OPFS namespace. Streams, writers, descriptors, pages, contexts and profiles are released by their acquiring
fixture, including when setup or an assertion fails. Cleanup attempts every release and retains the primary failure
beside cleanup failures.

Eight additional scenarios translate Node, Deno and Bun filesystem operations to the facade. They retain upstream
payloads and expectations, but their callback bodies are adaptations rather than copied WPT bodies. A DataView case adds
sentinel bytes around the original `hello` payload, and positive truncate cases add exact byte checks to upstream size
checks. The iterator failure case asserts the original producer reason through the facade's normalized error and then
checks that the filesystem remains usable. It does not require rollback of a native partial write.

| Source                                                                                                                                                   | Pinned revision                            | Retained behavior                                                                                                                                                                                                                                                                                                 | Adaptation and limits                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Web Platform Tests](https://github.com/web-platform-tests/wpt/tree/a143ac31cb4fb17f14b54a7103ebab5228bdf8d9/fs)                                         | `a143ac31cb4fb17f14b54a7103ebab5228bdf8d9` | Empty/blob/string/ArrayBuffer writes; append and explicit cursor commands; UTF-8 and line-ending byte sizes; zero-filled gaps; staged visibility and independent stream commits; writer locking; positive file creation/lookups; positioned and cursor-based sync reads/writes; shrinking and zero-filled growth. | Harness ownership replaces `directory_test` and `sync_access_handle_test`. TypeScript adds lexical loop declarations and removes unused bindings. TextEncoder absence fails rather than returning silently. Native negative-truncate exception assertions are omitted. |
| [Node v26.10.0](https://github.com/nodejs/node/tree/151845ab90d3926ceb36eedf1eade09619c3adc9/test/parallel)                                              | `151845ab90d3926ceb36eedf1eade09619c3adc9` | Selected `hello` byte views and DataView; 16 KiB `x` payload truncated to 1024 and then zero bytes.                                                                                                                                                                                                               | Callback overloads become explicit byte views or facade sync methods. Native overload and error-code conformance is not asserted.                                                                                                                                      |
| [Deno v2.9.7](https://github.com/denoland/deno/tree/0c071246a412575e07423263404a5d13e7ed6aa2/tests/unit)                                                 | `0c071246a412575e07423263404a5d13e7ed6aa2` | `Hello` append and replacement; stream replacement removes old trailing bytes; positive descriptor truncate grows to 20 bytes and shrinks to five.                                                                                                                                                                | `append` flags become facade write modes. Deno's negative-length clamp differs from the facade's range rejection, so it is excluded. Atomic exclusive `createNew` has no facade equivalent and is not claimed.                                                         |
| [Bun v1.3.14](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/test/js/node/fs/fs-promises-writeFile-async-iterator.test.ts) | `0d9b296af33f2b851fcbf4df3e9ec89751734ba4` | Byte iterator yields `2`, `Hello,`, `world!`; a producer throws `Error("good")`.                                                                                                                                                                                                                                  | Buffer chunks become Uint8Array chunks. The facade accepts byte iterators, not string-yielding iterators. Producer rejection is asynchronous and normalized; Bun's native synchronous throw matcher is not copied.                                                     |

`tests/upstream/provenance.json` records each upstream repository, exact commit, original file path, original file
SHA-256, original WPT callback SHA-256, retained path, case identity and adaptation. Inert `.txt` snapshots include the
original test files and complete upstream license files. WPT uses BSD-3-Clause; the selected Node/Deno/Bun project
sources use MIT. The full Bun and Node license files also describe dependencies that this suite does not copy. Readable
license copies are in `tests/upstream/licenses/`; the raw copies in `tests/upstream/original/` remain byte-exact.
`.gitattributes` prevents newline conversion of that raw tree. A cross-runtime provenance test checks every snapshot
hash and rejects missing, extra or non-regular snapshot files.

The runtime suite runs 75 positive cases per host: 30 memory cases and 45 native host cases. Memory has no synchronous
descriptor route, so the 13 WPT sync cases and two runtime sync scenarios run only on the native host adapter. Four
negative controls show that the harness rejects incorrect bytes, an incorrect UTF-8 byte size, a nonzero extension byte,
and unexpected native OPFS acquisition failures. The separate provenance case checks attribution, not behavior.

The browser suite executes the same WPT callbacks directly against native OPFS and through the facade. Its 150
Playwright tests cover three engines, two routes, 24 individual directory/writable cases and one 13-case sync batch per
route in a DedicatedWorker. Every engine uses a fresh task-owned persistent profile for each test. Each case owns its
page and UUID namespace, and the fixture deletes its profile after closing the context. Native acquisition and
retirement have the finite owner budgets described in [validation](validation.md#browser-tests-use-playwright).
Persistent storage is an explicit tested profile, not evidence for private or ephemeral browser contexts. A focused
macOS probe observed native WebKit `UnknownError` in a fresh ephemeral context, while a fresh persistent profile wrote
and read `foo🤘` with size seven. This is an observed deployment limitation, not API absence. The new suite skips only
absent APIs, explicit native policy denial, or absent worker sync exposure. Unexpected acquisition errors fail and
retain the native probe.

These cases prove selected byte and operation semantics. They do not certify native WebIDL object brands, structured
cloning, permission methods, the complete WPT corpus, POSIX permission flags, a host root security jail, or every native
exception category. The original WPT title about atomic close describes staged writable-stream visibility. It does not
turn native `writeFile()` or positional writes into transactions.

## Borrowed truncate benchmark

```sh
deno task bench:upstream:verify
BENCH_JSON=1 deno task bench:upstream
```

The benchmark adapts the valid branch of Node's pinned
[`benchmark/fs/bench-ftruncateSync.js`](https://github.com/nodejs/node/blob/151845ab90d3926ceb36eedf1eade09619c3adc9/benchmark/fs/bench-ftruncateSync.js).
Its original input is `Some content.`, its target length is four, and each sample performs 10,000 `truncate(4)` calls on
one preopened resource. Native Node, the Node driver, the Node adapter and the facade perform the same workload. The
facade uses `metrics: "none"` and `coordination: "none"`; acquisition and close remain outside timing. Each route first
proves size four and exact `Some` bytes with an independent read. The measured batch consumes one size result after its
loop.

Mitata distributions report nanoseconds per batch, not nanoseconds per individual truncate. Divide a batch duration by
10,000 only when explicitly presenting an estimated per-call cost. This is the cost of repeated truncation of a file
already four bytes long, including wrapper validation and host syscall costs. It measures neither useful byte
throughput, file growth, replacement, durable flush, nor directory creation. The original invalid-descriptor branch
catches every error; this adaptation omits that branch and propagates any error in a valid route. The verify task runs
byte oracles and cleanup without collecting timing. One-off raw results and diagnostics belong under ignored
`.tmp/reports/`.
