# Prove the GPU path and its full cost

Use a GPU when representative work and the deployment host justify it. Separate
shader compilation, upload, dispatch, synchronization, readback and steady-state
compute. Small batches may spend more time crossing these stages than computing.
Keep a correct CPU/Wasm implementation when the product requires hosts without
the selected GPU capability. Do not disguise missing computation as a fallback.

`wgpu` is a candidate for native Vulkan/Metal/D3D12 and browser WebGPU. Its
WebGL2 backend has fewer capabilities; it is not a generic substitute for WebGPU
compute shaders. Select exact backend features and inspect resolved dependencies.
A successful Wasm build does not prove a graphics adapter exists at runtime.

## Establish the host contract before choosing kernels

Record browser/engine, OS, adapter/device, driver, backend, features and limits.
Request only the features and limits the operation needs. Test adapter absence,
device loss, validation errors, allocation pressure and cancellation/cleanup.
Keep blocking waits out of the browser event loop. Respect the selected API's
mapping and asynchronous completion rules.

WebGPU needs a suitable browser host and secure context. Threaded Wasm has its
own shared-memory/isolation requirements; WebGPU availability does not satisfy
them. A native `Send`/`Sync` expectation cannot be imposed on browser objects.
Do not enable fragile marker-trait features without proving their constraints.

## Make layouts and arithmetic explicit

Define the byte layout shared by Rust and WGSL, including padding, alignment,
array stride and endianness. `#[repr(C)]` alone does not prove a struct matches
WGSL buffer layout. Use checked conversion/layout tools only for types whose
validity rules fit. Test boundary offsets and serialize a known fixture both ways.

For reductions and ML, define accepted numeric error before changing precision
or reassociating arithmetic. Test extreme values, NaNs, infinities and signed
zero where relevant. Compare actual outputs, not only successful command submit.
Keep deterministic and approximate execution policies distinct.

Measure end-to-end latency and throughput at realistic sizes. Report transfer
bytes and peak live CPU/GPU buffers. Readback timers must await completion;
submission time alone is not execution time. Do not compare a warmed cached
pipeline with another implementation's startup as if they performed equal work.

## Evidence from this guide's research

An isolated `wgpu=30.0.2` adapter library compiled on Linux and to
`wasm32-unknown-unknown` using Rust1.100.0. The native runtime gate failed because
the environment supplied no usable Vulkan adapter. Browser execution and GPU
computation were unrun. This supports the separation of compilation and runtime
gates; it does not establish any GPU speed claim or a production-ready wrapper.

Recheck version-specific descriptors, feature names and binding generators before
using examples. In the inspected wgpu30 API, `Instance::new` takes its descriptor
by value; older examples can differ. Pin binding generator and crate versions
together when using generated JavaScript.

Sources: [wgpu30](https://docs.rs/wgpu/30.0.2/wgpu/),
[web platforms](https://wgpu.rs/doc/wgpu/documentation/platforms/web/index.html),
[features](https://wgpu.rs/doc/wgpu/documentation/features/index.html),
[WebGPU](https://www.w3.org/TR/webgpu/),
[WGSL layout](https://www.w3.org/TR/WGSL/#alignment-and-size).

Read the [reproducible evidence requirements](evidence-index.md) before relying on a research observation.
