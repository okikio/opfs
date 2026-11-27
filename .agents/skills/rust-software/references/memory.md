# Give every allocation a reason and a lifetime

Use this for hot loops, large inputs, caches, arenas, FFI, or long-lived workers.
Start with ownership and the largest live data set. Allocation count, retained
capacity, peak live bytes, process RSS, and Wasm linear-memory size answer
different questions; do not report one as another.

## Prefer a bounded ownership story

Borrow `&[T]` or `&str` for call-scoped input. Return an owned value when the
caller must keep it independently. Use a caller-provided output buffer when
reuse is material and the mutation/error contract is clear. A borrowed tiny
slice can retain a large backing allocation, so copying a small retained result
may use less memory than preserving the whole source.

Use `Vec` as the ordinary contiguous owner. Reserve from credible bounds,
use checked length arithmetic, and reject configured limits before allocation.
Consider fallible reservation where recoverable allocation failure is part of
the API. A fallible reserve call alone does not make every later allocation or
allocator failure recoverable.

`Vec::clear` retains capacity. Reuse can reduce allocation churn, but a single
large request can keep a worker's buffer large indefinitely. Set an evidence-based
retention budget or discard oversized buffers at a defined lifecycle event.
Do not shrink every iteration without measuring the resulting churn.

## Choose containers by access and lifetime

| Shape | Useful when | Cost to examine |
| --- | --- | --- |
| `Vec<T>` / `Box<[T]>` | Contiguous owned records | Capacity slack, relocation, peak live copies |
| Borrowed slice / span | Source outlives the operation | Retained backing data and lifetime coupling |
| `Cow` | Most paths borrow; some transform | Branches and when ownership is forced |
| `Rc` / `Arc` | Shared ownership is real | Refcount traffic, cycles, cache contention |
| Arena | Many values have one phase lifetime | Reset scope, retained chunks, destructor rules |
| Ring/deque | Bounded FIFO or rolling state | Wrapped regions and downstream contiguity needs |

Do not add reference counting to avoid understanding ownership. Use `Arc` only
when the shared lifetime and cross-thread contract require it; it does not make
the contained value safe to mutate concurrently.

## Keep data layout deliberate

Use [data-oriented design](data-oriented-design.md) to map passes and lifetimes.

Measure record size, padding, access stride, working set, and cache behavior.
Keep hot fields together or in separate columns when the actual pass benefits.
Indices/spans can reduce pointer chasing and duplicated strings; validate their
range and generation, and keep the backing store alive. Structure-of-arrays is
not automatically faster when operations need complete records together.

Avoid `repr(packed)` as a general size optimization: unaligned references create
safety hazards. Use `repr(C)` for a defined ABI need, not a promise that layout
is optimal or portable serialization. Treat public layout as a separate contract.

## Verify lifecycle costs

Measure first use, steady reuse, oversized input, cancellation, errors, and
shutdown. Check that buffers, arenas, pools, callbacks, and task results release
or retain exactly what the contract allows. In Wasm, freed allocations may be
reusable without shrinking linear memory; high-water size is not itself a leak.

## Sources

- [Vec guarantees](https://doc.rust-lang.org/std/vec/struct.Vec.html)
- [Arc ownership and thread safety](https://doc.rust-lang.org/std/sync/struct.Arc.html)
- [Layout guarantees](https://doc.rust-lang.org/reference/type-layout.html)
