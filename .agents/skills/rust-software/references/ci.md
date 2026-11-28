# Make CI prove the supported product

Use this page when adding or speeding up Rust CI.
Start from the package/artifact inventory and each customer's required behavior.
For each Rust artifact that promises Wasm, record its named artifact, host contract,
build command, and executable acceptance check. An excluded worker cannot count
as supported because a smaller core crate builds.

## Keep a small required path

| Lane | Evidence it owns |
| --- | --- |
| Inventory and configuration | Every manifest, maintained Cargo target, feature set, and required job is accounted for |
| Formatting and lint | Changed source follows the pinned formatter and relevant lint rules |
| Native behavior | Unit/integration/contract tests for affected code and its consumers |
| Wasm behavior | Actual required browser/WASI artifacts execute with the claimed host capabilities |
| FFI consumers | Real C/C++ and C# callers verify the exported ABI, ownership, errors, and cleanup |
| Package and release | Exact distributable contents, supported targets, and clean consumer behavior |

Separate compilation from execution in job names and reports.
Run native OS-specific code on Windows, macOS, and Linux where those contracts
are promised. Cross-compiling alone cannot establish OS behavior.
Browser Wasm, WASI Preview 1, and WASI Preview 2 need their own applicable runners.
Test scalar and accelerated artifacts; test unsupported-feature selection too.
Keep host build scripts/procedural macros distinct from target product artifacts.

Use the same Cargo/Mise task locally and in CI. Pin compiler, actions, tools,
native SDKs, and runners. Capture the effective versions and immutable source SHA.
Use `--locked`; make required jobs fail on missing prerequisites or zero test selection.
Keep clippy/static checking distinct from final linking and runtime checks.
Run doctests separately when using nextest, which currently does not run them.

## Reduce work by contract

Compute affected packages and reverse dependencies from Cargo metadata and the
actual target/feature graph. Include public consumers and integration owners.
Changes to shared manifests, lockfiles, compiler, generator, schemas, target flags,
or CI selection logic normally require broader validation.
Do not use filename suffixes alone to decide whether Rust behavior changed.
Retain a full supported matrix for release and a periodic check of selection logic.
When a required lane is legitimately unaffected, report that decision explicitly;
do not silently skip the aggregate gate or leave a required status pending.

Build a compatible test archive once and distribute it only when execution time
justifies sharding. See [sharding](sharding.md).
Cache source downloads and compatible compilation work with [cache rules](caching.md).
Cancel superseded PR runs when safe; preserve failures and required release work.
Give CPU-heavy tests, Cargo jobs, browser workers, and benchmark processes a shared
resource budget so concurrency does not multiply memory and cause throttling.

## Keep determinism meaningful

Pin fixture seeds and source corpora; do not depend on hash-map iteration order,
local timezone, locale, wall clock, network availability, or test order accidentally.
Test production overflow/panic/profile behavior where it affects results.
Distinguish identical logical output from byte-identical build artifacts.
Byte reproducibility also needs controlled paths, linker inputs, generated data,
timestamps, and environment. A passing lockfile check is insufficient.
Keep correctness gates on every relevant change. Use stable performance budgets
only where a representative workload and controlled runner support them.
Run fuzzing, Miri, sanitizers, broad dependency updates, and long benchmarks in
appropriate additional lanes; route relevant regressions back into fast tests.

CI completes when required jobs report on the exact revision, the artifact was
inspected and executed, and failed/skipped/blocked checks are explicit.
A successful upload, push, cache restore, or local build does not prove CI success.

Primary sources, reviewed 2026-11-26:
[Cargo CI guide](https://doc.rust-lang.org/cargo/guide/continuous-integration.html),
[nextest](https://nexte.st/),
[GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax),
[Cargo metadata](https://doc.rust-lang.org/cargo/commands/cargo-metadata.html).
