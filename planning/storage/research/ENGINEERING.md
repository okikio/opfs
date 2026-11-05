# Engineering contract for the expansion

Apply these requirements to every implementation slice in PLAN.md. They cover source, extension APIs, documentation, comments, formatting, tests, benchmarks, packaging and evidence. This is an implementation specification; no production refactor or benchmark result is delivered by this planning update.

## Pure decisions and explicit effects

Separate deterministic work from resource acquisition. Binary record parsing, path/name decisions, offset arithmetic, format tables, index construction and budget/precondition planning consume explicit values and return values or structured failures. They must not fetch, inspect environment variables, read a clock, generate random material, mutate a registry or consult host state behind the caller's back.

Opening a source, obtaining credentials, generating salt, checking a quota, decoding through a native codec, writing a checkpoint and publishing bytes are effects. Put them in named owners with explicit inputs, AbortSignal and disposal. Supply clocks/randomness when they affect a reproducible test or decision; acquire cryptographic randomness from an explicitly selected secure capability in real operation. Do not replace it with seeded test randomness in production.

Use immutable tables/constants where useful; keep caches, parser cursors, compression/encryption state and queues private to an opened instance. Local state is appropriate for incremental work. Do not pretend an incremental parser or hasher is stateless: specify ownership, reset/finalization and whether a borrowed input buffer may be retained. No mutable process-wide backend, codec, credential or worker singleton.

The goal is traceable effects and a small unused dependency graph. `globalThis.Deno` is still ambient runtime access; changing spelling does not make I/O pure. Standard language/Web API primitives are not application-owned mutable global state, but their availability and effects still belong to the host boundary when material.

## Runtime acquisition and the Node function

Node's `process.getBuiltinModule(id)` was added in Node22.3.0 and20.16.0. It synchronously resolves actual built-ins and returns undefined for an unrecognized module. OPFS's current `NodeBackend` already calls it inside its constructor for fs, fs/promises and stream. This is an existing successful optional-loading boundary, not a missing feature to introduce. Its constructor may create the configured root, so import safety and construction purity are separate claims.

A read-only probe in this planning session ran on Node26.13.0: the loader and `node:fs` were available and an unknown ID returned undefined. This proves that local call only, not every runtime's behavior or bundle tree shaking. [Node documentation](https://nodejs.org/api/process.html#processgetbuiltinmoduleid).

For new host-dependent code, provide a portable operation accepting the narrow filesystem/codec/runtime capability it uses, and an explicit host factory that resolves that capability at construction or first use. A guarded `globalThis.process?.getBuiltinModule` or `globalThis.Deno` access belongs only there. Avoid repeated ambient lookups inside parser loops. Deno, Node and Bun host-specific semantics remain explicit; do not flatten away safe publication or descriptor behavior.

Use static imports inside an explicitly host-only subpath when they are the clearest contract and do not leak into portable imports. Use the built-in loader for a synchronous optional host need, or dynamic import for an actual asynchronous optional selection. Do not hide statically known unconditional dependencies behind opaque loaders to claim tree shaking. Neither `getBuiltinModule` nor dynamic import is a sandbox, a security scanner, or proof that unused code disappears. Test the produced graph and fresh-process imports.

Inventory existing host globals and captured native intrinsics before changing them. Refactor only the affected boundary, with parity tests for current lifetime and publication behavior. The Node driver already uses the desired mechanism; Deno's existing direct calls and stream brand/receipt rules need deliberate treatment rather than a broad text replacement.

## File structure and public boundaries

Continue the existing `src/` model. The following are proposed owners, not files that already exist:

| Location | Responsibility |
| --- | --- |
| `src/source.ts` | Public revision/replay source contract and construction decisions. |
| `src/transfer.ts` and focused private transfer files | Session/checkpoint orchestration; keep provider session protocol in its client. |
| `src/archive/zip.ts`, `src/archive/tar.ts` | Public archive operations. |
| `src/archive/zip/record.ts`, `index.ts` | Private record parsing and member-offset index; index here means the data index, not a barrel. |
| `src/codec/<codec>.ts` | Codec contract/binding; explicit dictionaries and framing profile. |
| `src/crypto/<envelope>.ts` | Named envelope/profile operations; no umbrella that imports all envelopes. |
| `src/view/<format>.ts` | Read-only filesystem projection over opened archive/vault/repository. |
| `src/driver/<service>.ts`, `src/adapter/<service>.ts` | Existing native-driver and translation owners. |
| `src/bridge/<ecosystem>.ts` | Actual reverse ecosystem contract. |
| `tests/` plus bounded fixture/corpus metadata | Public contract, protocol, parser, extension and runtime cases following current repository conventions. |
| `bench/` | Discoverable workload-driven benchmarks using current Mitata/reporting owners. |
| `docs/` | Consumer guides, extension tutorial, exact profile/capability references and troubleshooting. |

Do not create an oversized `core`, a global plugin registry, runtime forks, or vague `common`/`manager` directories. Do not migrate all existing monofiles merely to match this table. Split when independently changing parsing, indexing, lifecycle or protocol knowledge justifies it. Generic new mechanics belong in the current utility workspace only when independently useful and compatible with its stronger programming model.

Expose explicit subpaths in Deno and npm artifacts. Keep internal packed layouts, generated corpora, native SDK code and runners out of root exports. The existing `scripts/schema.ts` generation owner remains authoritative for schema type output; do not hand-edit generated `_schema_types.ts` as a substitute. New repository tasks follow `.mise/tasks/` and existing Deno ownership rather than a second task framework.

## Data-oriented design with measurable reasons

The main transforms are bytes → bounded records → member index → selected extents → codec/authentication units → caller output. For each, record cardinality, bytes read/touched/copied, retained lifetime, hot fields, request count, chunk size and cancellation waste.

Begin with stable, inspectable records. For large ZIP directories, consider a compact index of offsets, lengths, method/flags and name spans, with cold comments, extra fields and source evidence separate. Keep 64-bit values lossless using BigInt or a checked representation; do not silently narrow ZIP64 into Uint32Array. A name index must define duplicate/case/Unicode policy before optimizing lookup.

Use DataView/typed views to parse bounded byte regions, but validate extents before constructing them. Zero-copy views borrow backing storage and may retain a huge input buffer; copy only the retained spans when that reduces total retention. Document whether callbacks may keep an entry or chunk. Avoid exposing pooled objects that mutate after the caller stores them.

Compare ordinary objects, compact batches and typed arrays on the actual workload, including index build, string decoding, lookup, output conversion and teardown. JS layout and cache locality are runtime-dependent; typed arrays do not by themselves prove a CPU-cache win. Keep an understandable reference path and semantic oracle. Pool buffers only after a profile demonstrates a benefit and a bounded, tested reset/lifetime policy exists.

## Documentation, comments, schema and format gates

Each delivered module needs a common-path example, advanced composition example where useful, capability/format version, ownership, cancellation/cleanup, budget, expected failure, integrity status and unsupported case. An archive guide must explain the cost of listing versus reading; an extension guide must show public imports and complete ownership. A runnable example is also an installed-artifact fixture.

Use strict Zod objects for project-owned serialized checkpoints/configuration, `*Schema` names and inferred `*Type` data. Keep behavioral interfaces and live resources distinct from serialized data. Preserve native unknown fields only through an explicitly versioned representation/profile; do not confuse strict internal admission with silently discarding archive metadata needed for fidelity.

Document public APIs and important private invariants: checked binary offsets, buffer lifetime, encrypted-frame numbering/finality, dictionary/restart state, chunk acknowledgment, revision binding, temporary publication, and cleanup failure ordering. Explain why an invariant exists and what breaks if it changes. Comments cannot replace a clear API, and routine test helpers do not need essays.

Follow existing TypeScript formatting and explicit extensions; keep type/value imports distinct and avoid any/casts that conceal unsupported contracts. Make narrow Markdown changes; no unrelated broad reformatting. Update all owning docs, release intent and generated outputs when an API or durable layout changes. Preserve current behavior while introducing enabling contracts; remove obsolete paths only with complete consumer migration and recovery evidence.

## Tests that prove the intended contracts

Use existing `node:test`/`@std/expect` and Playwright where real browser capabilities matter. Do not add a new property-testing dependency by default: deterministic generated adversarial cases and an independent oracle can run under the approved dependency policy. Add an optional tool only through its own dependency decision.

| Surface | Required proof |
| --- | --- |
| Pure parser/index | Split input at adversarial boundaries; compare chunk-invariant results; checked64-bit arithmetic, truncation, conflicting local/directory metadata, duplicate names and corrupt indexes. |
| Third-party contracts | External package imports only public exports; correct generic inference; deliberate false capabilities/unsupported operations; real consumer bridge semantics; peer/version mismatch. |
| Preview | Instrument fetched/read/decompressed/decrypted/returned bytes separately; enforce aggregate budgets; prove accepted level and authentication scope match actual work. |
| Crypto/envelopes | Independent vectors and cross-implementation fixtures; wrong key, tamper, reorder, truncation, nonce/index limits, terminal authentication and partial-result policy. |
| Transfer | Fresh-process crash windows, exact source/transform identity, stale resume/fencing, dropped acknowledgments, destination races and unknown publication. |
| Resources | Abort before/after acquisition, slow consumer, early break, partial construction and cleanup failure; no borrowed-resource closure or hidden lingering worker/subprocess. |
| Native/WASM options | Exact build digest, supported codec/profile set, worker FS bridge, bounded memory/staging, CSP/missing-feature errors, initialization and repeated dispose. |
| Package/host | Fresh-process no-network/no-env import safety, missing Node/Deno/Bun globals, optional module exclusion, bundled clean consumers and runtime/type environment separation. |
| Restore/extract | Traversal/link/collision/sparse metadata policies, destination revision races, staged publication, partial extraction and fidelity/loss receipts. |

Fixture metadata names the independent producing tool/version, profile/options, input digest, expected semantic output, source/license and why adaptations are necessary. Never generate expected bytes or capabilities from the candidate under test. Corrupt/fuzz inputs have bounded budgets too. Avoid exploding the full matrix on every tiny change: run affected correctness cases per PR, larger corpus/fuzz/hosted matrices separately with an owner, and report exclusions explicitly.

Static checks stay serial in CI under AGENTS.md's memory restriction. Local Deno runtime tests use `--no-check`. A shared source or passed typecheck cannot certify native I/O, a cloud service, a browser permission or a compressed format.

## Benchmarks and promotion criteria

Keep benchmarks separate from ordinary correctness gates unless a stable, owned performance decision justifies a required gate. Before implementation, record a baseline revision, expected physical change, workload, protected behavior and threshold that would justify complexity.

Measure at least: header identification; cold listing/index build; first prefix of an early/late member; arbitrary member range; full verify; encrypted unlock/list/read; solid-group late access; nested preview; transfer/resume; cancel/cleanup; and cold package/engine load. Cross file count, name length, compressed size, compression ratio, frame/block size, source latency and request concurrency. Use a small case to expose conversion overhead and large cases that exceed cache/heap-friendly toy data.

Baseline against the current/simple implementation, an optimization-disabled route, applicable Web/std primitives and selected independent engines with identical outputs, verification and cleanup. Native engines, WASM engines, network and pure parsing are separately reported; do not compare a warmed native decoder with cold WASM initialization and call it one result.

Use Mitata and consume outputs with its anti-optimization mechanism. Preserve raw samples, runtime/host versions, seeds, cold/warm state, construction timing, concurrency and stage counters. Record first-result/p95 latency, throughput, peak RSS/heap/linear memory, retained memory after repeated close, temporary storage, requests and physical byte amplification. Memory/lifecycle experiments should not distort the timed hot loop.

A preview may return4KiB while fetching1MiB or decoding1GiB. Report all three. Deterministic counters and budget tests can be CI gates; noisy wall-time/cache/GC claims need controlled runs and meaningful effect size. Reject an optimization that changes integrity, errors, metadata or cleanup outside its declared option, even if a microbenchmark wins.

## Supply-chain transparency and from-scratch work

Prefer built-in APIs, applicable std and verified personal libraries. Willingness to implement from scratch remains an explicit option: choose between reusing code, improving/extracting an owned implementation, writing a focused implementation from a public specification, or isolating an optional engine. Record the missing capability or measured problem that justifies the choice. No decision is settled by package popularity or dependency count alone.

A from-scratch decoder/format reader needs the same independent corpus, differential tests, fuzzing, bounds and maintenance owner as a dependency. Implement protocol/framing/checked parsing directly where justified. Implementing a named envelope from primitives is distinct from inventing a new cryptographic construction. Keep cryptographic format review and primitive availability gates; do not silently downgrade authentication or KDF parameters.

For every runtime subpath, publish a dependency inventory showing direct/transitive packages, registry/source revision, integrity, license, native/WASM artifacts, initialization, network/file permissions and update owner. Inspect exact exports/lock/artifacts; a personal top-level package may include other maintainers' dependencies. Pin binary/WASM bytes and make worker URLs explicit; avoid import-time CDN download or user-manifest-selected code. Disable unnecessary install scripts in controlled builds, retain artifact/provenance evidence, and make upgrades reviewable. These controls reduce exposure; neither zero dependencies nor signatures establish that no malicious code exists.

No ambient credential, wallet, network or paid operation is acquired during import. Application code explicitly chooses external extensions and resources. Capability injection makes that choice visible; arbitrary extension code still runs with its host's authority unless the application places it in a separately designed isolation boundary.

Acceptance: each release slice links a consumer outcome to its code owner, contracts, docs/comments, meaningful tests, benchmark decisions and exact-artifact evidence. Reports distinguish planned, source-inspected, fixture-tested, live-tested and released behavior. Human readability gets a first-reader pass as well as technical validation.
