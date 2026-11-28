# Cache repeated work without trusting stale results

Use this page when reducing local or CI compilation cost.
Measure download, restore, compile, link, test, and upload time separately.
A cache is useful only when its saved work exceeds transfer and maintenance cost.

| Cache | Reuses | Does not establish |
| --- | --- | --- |
| Cargo registry/Git download cache | Dependency sources | Compiled artifacts or test success |
| Per-worktree Cargo output | Compatible local build state | Correctness after arbitrary directory sharing |
| Compiler cache such as sccache | Supported compiler outputs keyed by inputs | Final link reuse or runtime validation |
| CI artifact archive | One recorded build's selected outputs | Compatibility with another target or trust context |

Use separate writable build output for divergent worktrees.
Do not substitute cache hits for builds, packaging checks, or tests.
Cargo's target and intermediate build directories may be configured separately;
separating final artifacts alone does not prove shared intermediates are safe.

## Configure keys and trust

For compiled CI state, distinguish OS/architecture, compiler identity, target,
profile, feature set, flags, lockfile, native SDK/linker, and relevant generator inputs.
Separate dependency-source caches from source-sensitive compiled output.
Let the compiler/cache owner fingerprint source inputs; broad restore prefixes
are candidates for reuse, not proof that current source has been compiled.
Measure cache size, hit/miss reasons, restore/save time, and eviction pressure.
Keep credentials, signing material, and private runtime data out of cache paths.

Use least cache permissions for the workflow's trust level.
Do not execute untrusted PR code in a privileged workflow that can write caches
later consumed by release jobs. Verify current GitHub `cache-mode` semantics.
Pin Actions to reviewed commit SHAs and keep the runner version compatible.
Keep artifact downloads tied to a known producing workflow/revision and hash.

## Respect sccache's Rust limits

The inspected sccache Rust documentation excludes compiler invocations that
call the system linker, including `bin`, `cdylib`, `dylib`, and procedural macros.
Incremental crates are uncached by default; `SCCACHE_ALLOW_INCREMENTAL=1`
allows those invocations but still bypasses their cache.
The distinct `SCCACHE_ALLOW_INCREMENTAL=cache` mode caches incremental outputs.
A hit does not refresh incremental state, so a later edited rebuild may be slower.
Explicit `CARGO_INCREMENTAL=1` and a profile default produce different keys;
incremental compilation is not distributed. Compare both modes on the real graph.
Path normalization can reuse embedded paths from another checkout. Evaluate
`SCCACHE_BASEDIRS_VERBATIM_ENV_DEPS=CARGO_MANIFEST_DIR,CARGO_MANIFEST_PATH`
for crates that embed them. Untracked procedural-macro filesystem or environment
reads can defeat correct reuse. These are source-reviewed limits, not a cache test.
Do not promise that `RUSTC_WRAPPER=sccache` caches an entire release build.

Compare incremental local builds with compiler-cache builds on the actual graph.
Do not disable local incremental work everywhere merely to make a CI cache work.
Pin cache tools; record cache statistics and failures in the same evidence as timing.
An unavailable cache should fall back to a correct build, not bypass a required gate.

Mr Boxington is another opt-in candidate. Its 1.31.0 release retains private
incremental state and separate worktree targets while reusing eligible outputs.
Validate changed/reverted source, generated inputs, links and actual host artifacts
before adoption. Treat scheduling, managed targets and remote caching as separate
capabilities. Recent fixes do not certify a product graph.

## Verify cold operation too

Run a clean-cache build periodically and for relevant toolchain/build-system changes.
Check that generated files and system dependencies were not supplied only by cache.
Ensure a lockfile change, target change, or generator input change invalidates the
relevant work. Keep source downloads available for `--locked --offline` checks
only when an offline contract is actually promised.
Cache cleanup needs an owner and disk budget; it must not race active worktrees.

Primary sources, reviewed 2026-11-26:
[Cargo build cache](https://doc.rust-lang.org/cargo/reference/build-cache.html),
[sccache Rust caveats](https://github.com/mozilla/sccache/blob/1c7b8fcfd7b5a38d680b2bf8bf76f05902a6e33a/docs/Rust.md),
[mbx 1.31.0](https://github.com/jdx/mr-boxington/releases/tag/v1.31.0),
[GitHub caching](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).
