---
"@okikio/opfs": patch
---

### Read cancellation results without discarding independent failures

Streamed S3 and Azure writes stop input admission, wait for admitted parts or blocks, and retire the source reader
before rejecting. Their terminal error depends on where cancellation is actually observed. A producer read can reject
with the exact caller reason; an admitted provider operation can reject first and remain in the operation-owned pool's
`AggregateError`. The client preserves that aggregate even when it has only one error.

```text
successful part HTTP response → caller aborts → owned response retirement
                                      │                    │
                           next input read rejects   part mapper rejects first
                                      │                    │
                               exact input reason    pool aggregate of mapper faults
```

At concurrency one, the pool waits for that part's retirement before asking for another input chunk. Cancelling the
Fetch response can therefore reject the part mapper before the producer performs another read. This is an observed
operation failure, not permission to replace the result using an aborted signal flag.

The provider cancellation controls now require the exact caller signal to be aborted. They recognize its exact reason,
or one direct pool aggregate containing that sole failure. A request-owned observation can also record that concrete
Fetch rejected with the forwarded caller reason while that same request observed the signal's abort. The fixture accepts
that exact signal-bound Fetch tuple only when it has no extra observer or retirement failures; one pool envelope can
retain it unchanged.

```text
Fetch rejects with caller reason + exact signal abort observed
                         │
        request keeps both observations in its failure
                         │
      optional one-member pool envelope keeps that failure
```

This does not infer two independent causal origins or discard either observation. Preparation or deadline failures,
another signal, borrowed lookalike tuples, empty or nested pool envelopes, unrelated causes and extra faults remain
failures. Even an extra observer or retirement fault equal to the caller reason is still another event. An inactive
signal cannot certify a cancellation merely because its default reason is undefined. The tests capture the upload's
actual rejected result immediately, drain it in teardown and avoid reporting the same consumed failure a second time. A
successful undefined result cannot be mistaken for a thrown undefined reason.

Deterministic controls hold response retirement open after part acknowledgement. They require the write to remain
pending, then verify its actual mapper aggregate, source cancellation and lock release, no final publication, and S3
multipart abort. Real provider controls still require a successful part response, unchanged previous object bytes and no
remaining S3 multipart upload. The watchdog never manufactures EOF or retries a publication. This documents existing
error ownership; it does not flatten provider errors or establish the cause of mapped Docker gateway connection
timeouts. Additional controls use actual injected Fetch cancellation and actual pool mapping, while negative records
require wrong signals, preparation/operation mismatches, borrowed metadata and equal-valued extra faults to be refused.
These authored controls do not replace exact-source Node, Deno, Bun and real-provider execution.
