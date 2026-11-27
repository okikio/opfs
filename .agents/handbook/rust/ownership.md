# Preserve memory, stream and foreign-resource contracts

Name who owns each allocation or handle, who borrows it and when it is released. Record the invariant beside unsafe operations and at the public interface a consumer must use correctly.

For streaming work, compare the same logical input under relevant chunk partitions, including empty chunks, split encodings, limits and terminal states. Bound retained data and unfinished work. Define partial output and error behavior so a caller can recover without guessing which input was consumed.

For FFI or generated bindings, define representation, lengths, alignment, validity, errors and the allocator/release pairing. Test through the actual foreign consumer. Check stale views after memory growth, partial construction failure, repeated cleanup and cancellation where the contract allows them.

For concurrency, trace ownership, bounded queues, admission, cancellation and task completion separately. A progress event is not a terminal result. A request to cancel does not establish that buffers, threads or foreign resources were released.

Keep safe fallback behavior when selecting SIMD or GPU execution. Test feature detection and artifact selection on the required host. Preserve equivalent outputs and explicit numerical tolerance where the product permits a difference.

Use the [Rust skill's routed references](../../skills/rust-software/SKILL.md) for the exact technique and current API. Keep comments and rustdoc consistent with the implemented ownership and supported hosts.
