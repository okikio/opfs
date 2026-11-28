# Express ownership and work clearly

Idiomatic Rust makes valid states, borrowing and failure visible in the API.
It does not require elaborate traits, pervasive generics or unsafe code.

Start with concrete structs, enums, slices and ordinary functions. Put methods
on the type whose invariant they preserve. Use newtypes for incompatible units,
IDs or validated values. Keep constructors responsible for real invariants.
Represent alternatives with enums rather than loosely related booleans.
Use `Option` for absence and `Result` for expected failure. Preserve useful error
context without repeatedly formatting and allocating strings in a hot path.

Prefer `&[T]` and `&str` when the callee only observes caller-owned input. Return
borrowed views only when their lifetime and retention cost fit the caller.
Take ownership when data must outlive the call, cross a task or change owners.
Expose iterator or callback consumption when it avoids a large temporary output.
Keep essential intermediate results available to avoid forcing repeated work.

## Choose abstractions from the cost being paid

| Choice | Useful when | Cost to check |
| --- | --- | --- |
| Concrete type or enum | Small known set of behaviors | Variant size and matching |
| Generic function/trait | Static specialization matters | Monomorphized code and build time |
| `dyn Trait` | Runtime choice or code sharing matters | Indirection, object lifetime, allocation if boxed |
| Iterator pipeline | Streaming transforms compose clearly | Allocation, fusion and generated loop |
| `Arc<T>` | Shared lifetime crosses owners/threads | Atomic refcount traffic and retained graph |
| Arena/indices | Bulk-lifetime traversal dominates | Reset safety, destructors and retained peak |

Rust's "zero-cost abstraction" term means no additional runtime overhead over
an equivalent lower-level implementation in the intended case. It does not mean
zero CPU work, compilation, code size, memory or design cost. Keep the standard
term precise while measuring all material costs. Do not replace clear safe code
with unsafe code solely because an abstraction exists.

Avoid generic public APIs that force many unrelated types to instantiate a large
implementation. Where measured build/binary costs matter, put the large body in
a concrete internal operation and keep a small generic conversion at entry.
Do not assume dynamic dispatch is slower overall when it reduces code footprint.

## Use language conventions, not another language's spelling

Use `snake_case` for modules/functions and `UpperCamelCase` for types/traits.
Follow `as_` for a borrowed view, `to_` for a conversion that may allocate, and
`into_` for consuming conversion when those names match the real behavior.
Implement standard conversion/iterator/error traits where the semantics fit.
Use `field()` and `field_mut()` for ordinary getters; do not add `get_` everywhere.
Keep protocol spellings and actual upstream names exact.

Use `Vec` as a contiguous starting point, `VecDeque` for queue behavior, and a
map with explicit ordering/hash threat requirements. Hash iteration order is not
a stable serialization contract. A faster hasher must preserve the needed
adversarial-input protection. Measure before introducing specialized containers.

Avoid `clone()` as an automatic borrow-checker fix. Explain expensive clones by
ownership. A cheap `Arc::clone` can still retain a large allocation indefinitely.
Use `Drop` for deterministic local cleanup; provide explicit fallible close or
commit operations when the caller must observe failure. Do not rely on process
exit or panic abort to run destructors.

Sources: [API guidelines](https://rust-lang.github.io/api-guidelines/checklist.html),
[names](https://rust-lang.github.io/api-guidelines/naming.html),
[collections](https://doc.rust-lang.org/std/collections/index.html),
[iterator performance](https://doc.rust-lang.org/book/ch13-04-performance.html),
[Drop](https://doc.rust-lang.org/std/ops/trait.Drop.html).
