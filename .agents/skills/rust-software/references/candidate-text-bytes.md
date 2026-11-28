# Candidate backlog: bytes and text

These are source-linked candidates, not universally approved dependencies.
Use [dependency acceptance](dependencies.md) before adding one to a product.
The pinned links identify examples to inspect. Verify the exact installed
version, features, license and host behavior; the checks below are proposed
consumer probes, not published results for your environment.

## bstr 1.14.0

Purpose: operate on byte strings when input is not guaranteed to be UTF-8.
License: MIT OR Apache-2.0. Declared minimum Rust: 1.65.
A minimal candidate configuration disables defaults and enables `alloc`.
Default features include `std` and Unicode facilities; inspect their graph.
The package uses memchr; Unicode regex machinery is feature-dependent.
Do not convert arbitrary bytes into `str` without validation or explicit replacement.
Choose this when byte-oriented operations are the contract, not to bypass text rules.

Probe: search `b"left\xff:right"`; verify the colon is at byte 5 and the
invalid byte remains intact. Expand to the product's text policies.
Next evidence: benchmark the needed search/split workload and test every malformed
input policy exposed by the product, including its Wasm host adapter.
[Manifest](https://github.com/BurntSushi/bstr/blob/cb7e1d40741ce6415233d1cd4e211c0cae179165/Cargo.toml)

## bytes 1.12.2

Purpose: owned/shared byte buffers and views for I/O and parsing.
License: MIT. Declared minimum Rust: 1.57.
Inspect a configuration with defaults disabled; `std` is a default feature.
Serde and extra-platform atomic support are optional capabilities.
Cheap views trade copying for ownership bookkeeping and storage retention.
A tiny view can keep a very large allocation alive; count retained bytes too.
Copying a small long-lived slice can be cheaper than retaining its large owner.

Probe: retain a 1-byte slice of a large custom backing owner, drop the original
`Bytes`, and observe when the owner is released. This measures the ownership
contract; allocator overhead and process RSS need separate observations.
Next evidence: actual stream queue depth, retained capacity, clone/drop cost,
backpressure, and runtimes with different atomic capabilities.
[Manifest](https://github.com/tokio-rs/bytes/blob/67edc2b999d669eb4f471aff576e213dbcb58871/Cargo.toml),
[Bytes API](https://docs.rs/bytes/1.12.2/bytes/struct.Bytes.html)

## encoding_rs 0.8.44

Purpose: web-compatible text encoding/decoding with incremental decoder state.
License expression: (Apache-2.0 OR MIT) AND BSD-3-Clause.
Declared minimum Rust: 1.88; this current source uses edition 2024.
A minimal candidate configuration disables defaults and enables `alloc`.
The `simd-accel` feature has nightly requirements; do not enable by name alone.
This release also has target-specific acceleration dependencies. Inspect the
resolved graph and compiler flags rather than inferring scalar/SIMD from one feature.
Its build script contains compiler-version handling for a SIMD code-generation issue.

Probe: split the UTF-8 bytes for `€!` across decoder calls, retain decoder
state, and verify complete output and error status after the final flush.
Next evidence: every supported encoding, replacement/error policy, output-full
loops, final flush, chunk partitions, and exact production CPU/Wasm artifact.
Do not decode each chunk with a new decoder or discard unconsumed input.
[Manifest](https://github.com/hsivonen/encoding_rs/blob/e89b7c3371bffe0c260c76a11f32b8a7b6adad4a/Cargo.toml),
[build script](https://github.com/hsivonen/encoding_rs/blob/e89b7c3371bffe0c260c76a11f32b8a7b6adad4a/build.rs),
[decoder API](https://docs.rs/encoding_rs/0.8.44/encoding_rs/struct.Decoder.html)

## What these candidate notes do not establish

No speed ranking, complete security review, browser deployment, memory budget,
or full feature-matrix support is established by this guide.
An upstream claim and a local check are separate fields in the acceptance card.

Read the [reproducible evidence requirements](evidence-index.md) before relying on a research observation.
