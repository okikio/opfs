# Declare each maintained Rust artifact's contract

Inventory actual Cargo packages and targets, including binaries, examples, excluded members, generators and build-time hooks that the project maintains. Use the repository's pinned toolchain and native metadata rather than inferring support from folder names.

| Field | Record |
| --- | --- |
| Operation | Useful behavior, inputs, outputs, failures and cleanup. |
| Consumer | Public caller, executable, host adapter or packaged integration. |
| Supported hosts | OS, architecture, CPU assumptions, runtime and any declared Wasm environment. |
| Features and imports | Exact feature combinations and required host capabilities. |
| Ownership | Buffers, views, handles, threads and foreign-resource release. |
| Bounds | Memory, concurrency, work and output limits relevant to the operation. |
| Evidence | Build, artifact inspection and meaningful execution on each required host. |

When Wasm is required, name the target, engine or browser, imports, permissions and callable operation. Compilation alone does not prove host APIs or behavior. A skipped binary, empty implementation or remote native substitute cannot establish local portable behavior when that is the requirement.

When a required host cannot perform the operation, preserve the failed observation and resolve the design or product conflict. Record unsupported hosts truthfully when they are outside the agreed support contract. Keep build-host macros and generators distinct from product target execution.
