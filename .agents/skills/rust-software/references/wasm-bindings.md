# Treat Wasm bindings as an ownership protocol

Use this for JavaScript glue, shared linear memory, generated bindings, or
Component Model interfaces. A fast Rust function can become expensive or unsafe
when the adapter copies, retains, mutates, or misinterprets its buffers.

## Choose the contract before the generator

- Browser/JavaScript integration: inspect the exact `wasm-bindgen` binding and
  generated code for parameter conversion, allocation, copying, and freeing.
- Runtime-neutral component integration: define the needed WIT world and use
  bindings compatible with the deployed component runtime.
- A tiny raw core-module ABI: use only when its pointer, length, ownership,
  error, version, and reentrancy protocol can be documented and tested directly.

A C ABI signature and a WIT interface are different contracts. WIT describes
types and owned/borrowed resource handles; it does not supply application
behavior or prove that transferring a list/string avoids a copy.

## Keep borrowed views shorter than their hazards

Every view into Wasm memory needs an owner, range, mutation rule, and expiry.
Avoid retaining a JS typed-array view across an allocation, reentrant callback,
async suspension, free, or pool reuse unless the design explicitly handles it.
Unshared memory growth detaches old buffers, including growth by zero pages.
Shared-memory growth leaves old views at their old length; reacquire the buffer
to address the newly added region. A valid pointer does not rescue a stale view.

With current `wasm-bindgen` numeric imports, borrowed slice views are scoped to
the call; retained data needs an appropriate copy or owned transfer. Inspect the
selected version's generated wrapper rather than assuming every slice/string
has the same marshalling behavior.

## Define a raw-buffer protocol completely

Record allocation/free owner, capacity and length units, permitted empty/null
representation, maximum range, encoding, aliasing, callback behavior, and
whether a failure consumes the input. Never free a Rust allocation with a host
allocator. Never reconstruct a `Vec` from guessed capacity or a borrowed pointer.
Use checked range arithmetic and fixed-width serialized lengths where the
protocol requires stable widths; native `usize` changes with the target.

If a host obtains a view, state whether it may write. Read-only Rust borrowing
does not make an independently exposed JS typed array immutable. End all views
before the Rust allocation is freed or mutably reused.

## Exercise the contract through the consumer

Test empty and large buffers, non-ASCII strings, malformed input, memory growth,
reentrant allocation, repeated allocate/use/free cycles, cancellation, and
adapter errors. Assert full output and ownership transitions. Inspect memory
growth/retention separately from process RSS and JS garbage collection.

Force an allocation that grows memory and inspect old and reacquired views
through the actual host. Check preserved contents and view lifetimes. Repeat
with the chosen binding generator and memory model before claiming support.

## Sources

- [Numeric slice/Vec import behavior](https://wasm-bindgen.github.io/wasm-bindgen/reference/attributes/on-js-imports/slice.html)
- [Unsafe typed-array views](https://wasm-bindgen.github.io/wasm-bindgen/api/js_sys/struct.Uint8ClampedArray.html)
- [WIT contracts and resources](https://component-model.bytecodealliance.org/design/wit.html)


Read the [reproducible evidence requirements](evidence-index.md) before relying on a research observation.
