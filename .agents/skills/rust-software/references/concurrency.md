# Parallel work needs an execution and shutdown contract

Use this for threads, async tasks, work stealing, shared buffers, and queues.
Parallelism is useful when useful work exceeds scheduling, coordination,
transfer, and contention costs. Start with a correct sequential path and a
bounded workload before selecting a pool or runtime.

## Keep ownership visible

Partition mutable output into disjoint slices or give each task an owned
result. Borrow with scoped native threads when the scope can join every task.
Use channels when transferring ownership fits better than shared mutation.
Bound queued items and bytes; an item limit alone may hide large payloads.

Specify spawn, admission, cancellation, join, failure propagation, and teardown.
A dropped future or a cancel flag does not prove the worker stopped or released
its buffers. Join or otherwise observe completion before reclaiming resources.
Avoid holding a lock across external calls or suspension unless the protocol
requires it and deadlock/latency consequences have been reviewed.

Use `Arc` for a real shared lifetime; it does not make `T` safe for concurrent
mutation. Define lock ordering and avoid unnecessary global coordination.
Batch small work to reduce scheduling costs, then check tail latency and
cancellation responsiveness rather than maximizing batch size blindly.

## Atomics are a protocol, not a faster mutex spelling

Document the shared invariant and the release/acquire or other ordering that
makes it hold. Rust atomics do not remove data-race or mixed-size-access rules.
Lock-free does not mean wait-free, and atomic widths vary by target. Gate real
requirements with target capabilities rather than assuming `AtomicU64` exists.

Use a bounded model test with Loom for a small custom synchronization protocol,
plus stress and integration tests in the actual runtime. Loom explores the
modeled operations; omitted operations, bounds, and non-Loom synchronization
remain outside that evidence. Prefer reviewed primitives to custom lock-free
structures unless profiling and a soundness argument justify the complexity.

## Wasm requires a separate host check

`wasm32-unknown-unknown` does not provide ordinary `std::thread::spawn`.
Browser worker-based pools require their adapter, initialization, memory/atomic
configuration, and host headers. Verify the no-thread path too. A browser main
thread cannot serve as a general blocking worker.

Rayon's implicit unsupported-thread fallback is not equivalent to every API
being an ordinary sequential call: upstream documents limitations for `spawn`.
An explicitly built pool returns its creation error. Test the exact operation
you use; a parallel iterator completing does not prove detached task execution.
The [Rayon candidate fixture](candidate-serde-rayon.md) observed `join` complete,
explicit pool creation fail, and `spawn` wait until `yield_now` under WASI.

WASI Preview 3's default cooperative-thread support was still described as
incomplete in the Rust 1.100 target documentation reviewed on 2026-11-26.
Recheck the pinned toolchain/runtime, not the name of the target.

## Measure the actual work

Compare thread counts and batch sizes under fixed CPU/memory limits. Record
queue wait, processing, synchronization, memory high-water, throughput, and
tail latency. Preserve failures and throttling. Require output ordering or
deterministic reduction only when the product contract needs it, then test it.

## Sources

- [Rust atomic memory model](https://doc.rust-lang.org/std/sync/atomic/)
- [Loom model testing](https://docs.rs/loom/latest/loom/)
- [Rayon unsupported-thread behavior](https://github.com/rayon-rs/rayon/blob/599425d4a4c64714632817f48496dbc53f656a90/rayon-core/src/lib.rs)
- [Browser pool setup](https://github.com/RReverser/wasm-bindgen-rayon)


Read the [reproducible evidence requirements](evidence-index.md) before relying on a research observation.
