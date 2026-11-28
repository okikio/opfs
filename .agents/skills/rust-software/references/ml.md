# Select acceleration for the model and host

Start with the customer operation: model, tensor shapes, batch sizes, latency
budget, accuracy requirement and memory ceiling. Measure preprocessing, model
loading, tokenization, compute, sampling and transfer separately and together.
The fastest isolated matrix multiply may not improve the user-visible path.

## Treat each hardware feature as a conditional implementation

| Family | Candidate mechanism | Required evidence |
| --- | --- | --- |
| x86/x86_64 | SSE/AVX2/AVX-512, VNNI, BF16, AMX | Compiler API, CPU and OS enablement, dispatch, benchmark |
| AArch64 | NEON, dot-product, I8MM, BF16, SVE/SME | Exact target/runtime feature, vector semantics, fallback |
| Wasm | simd128 and optional relaxed SIMD | Engine validation, selected artifact and numeric contract |
| GPU | WebGPU or native backend kernels | Features/limits, transfer cost, shader output and device loss |

A supported Rust `target_feature` name does not guarantee every corresponding
intrinsic is stable. Check the pinned compiler's API and compile a minimal use.
Some SVE and AMX interfaces remain experimental in inspected documentation.
Do not execute unsupported instructions just to test whether they are supported.

CPU detection alone can be insufficient. Linux AMX tile data requires the
documented OS permission/state setup; inspect the actual host interface.
Native AVX-512/AMX are not direct Wasm opcodes. A Wasm engine lowers its own
instruction set; record that separation instead of promising native ISA control.

## Preserve model semantics and bounded resources

Quantization changes representation and often accuracy. Define calibration data,
scale/zero-point rules, accumulation width, rounding and accepted output error.
Compare model-level quality on representative inputs. Include overflow, tiny
and odd shapes, alignment, sparse/dense cases and pathological values.

Use batching or fusion only when the full pipeline benefits. Bound queues and
working buffers; avoid retaining an arena, model copy or GPU buffer per request.
Measure warm and cold paths, cancellation, concurrent requests and memory churn.
Account for weight downloads and startup when they matter to first useful output.

## Candidate backlog, not automatic dependency approval

- Burn: inspect the exact enabled backend and operators. Current 0.22 docs expose
  explicit device backends and a pure-Rust Flex option. Backend availability
  does not prove every operator/model works on Wasm or uses SIMD profitably.
- Candle: inspect the exact core/model and its Wasm example. CUDA/Metal features
  are native deployment choices; an existing Wasm model demo proves only its
  demonstrated configuration. Test the required tokenizer, weights and kernels.
- CubeCL/wgpu: consider kernel generation only after a measured operation needs
  it. Confirm browser-compatible feature/precision support and actual dispatch.
- Specialized inference/BLAS libraries: evaluate native code, compiler/linker,
  licenses, binary size and Wasm replacements before accepting a dependency.

Prefer one small kernel probe with a trusted CPU oracle before installing an
entire model stack. This guide provides selection criteria. Establish model inference throughput
with the exact model, host, dependency graph and saved measurements.

Sources: [Burn0.22](https://burn.dev/docs/burn/index.html),
[Candle](https://github.com/huggingface/candle),
[CubeCL](https://github.com/tracel-ai/cubecl),
[Rust target features](https://doc.rust-lang.org/reference/attributes/codegen.html#the-target_feature-attribute),
[Linux XSTATE](https://www.kernel.org/doc/html/latest/arch/x86/xstate.html),
[Wasm SIMD](https://github.com/WebAssembly/simd).
