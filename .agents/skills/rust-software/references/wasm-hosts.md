# Verify the actual Wasm host

Use this when portable code meets files, networking, clocks, randomness,
threads, browser APIs, GPU devices, or other external capabilities.

## Keep the algorithm independent of host policy

Accept borrowed bytes, explicit limits, and a small capability interface at the
core. Put permission checks, browser fetches, filesystem access, scheduling,
and resource cleanup in the adapter that owns them. A trait is justified by a
real host variation or test contract; do not create a framework around one call.

Specify what each host operation means. A native file path, a WASI preopened
directory, and a browser File/stream are different capabilities. Do not model
them as interchangeable strings and hope errors reconcile the difference.
Keep cancellation, deadlines, partial results, and cleanup observable.

## Check runtime behavior, not only available symbols

For `wasm32-unknown-unknown`, Rust documents that filesystem operations return
errors and `std::thread::spawn` panics. Code can therefore compile while its
customer operation is unusable. `cfg` cannot tell whether the eventual host is
a browser. Choose an explicit adapter or feature, then test that deployment.

| Operation | Evidence to retain |
| --- | --- |
| Clock/deadline | Time source, resolution, suspend behavior, timeout observation |
| Randomness | Host capability and failure behavior; never a silent fixed seed |
| File/stream | Permission scope, partial reads/writes, EOF, limits, cancellation |
| Network | Available protocol, redirects, headers, errors and body retention |
| Thread/pool | Creation, execution, join, shutdown, queue bounds and fallback |
| GPU | Adapter features, buffer limits, device loss, fallback correctness |

Do not grant broad host permissions to make a probe pass. Use the smallest real
capability needed for the question. Preserve failures and useful response data.

## Browser execution needs browser evidence

Test generated glue and its loader in the actual browser flow, including worker
startup, HTTP response headers, asset paths, CSP where relevant, and teardown.
Node successfully instantiating a core module does not establish those behaviors.
Likewise, a WASI runner does not prove the browser adapter.

Long synchronous compute blocks the browser thread running it. Move material
work to an appropriate worker or expose bounded resumable work, and verify
responsiveness and cancellation under the real load. Async syntax alone does
not make CPU work preemptible or guarantee thread availability.

For shared-memory browser work, verify cross-origin isolation and the pinned
threading adapter's worker and standard-library requirements. Do not infer that
`SharedArrayBuffer` availability makes `std::thread` usable.

## Smallest useful probe

Invoke the operation directly in the selected host with one valid case, one
permission/capability failure, and one cancellation/cleanup case. Keep the
scope narrow enough to distinguish an absent host facility from an algorithm
defect. Integrate only after the operation itself has a useful evidence anchor.

## Sources

- [Rust minimal Wasm limitations](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html)
- [wasm-bindgen threading caveats](https://wasm-bindgen.github.io/wasm-bindgen/examples/raytrace.html)
- [wasm-bindgen-rayon setup](https://github.com/RReverser/wasm-bindgen-rayon)
