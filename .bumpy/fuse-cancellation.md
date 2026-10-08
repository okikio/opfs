---
"@okikio/opfs": patch
---

### Finish each mounted cancellation scenario before reusing its filesystem

The Mountpoint and BlobFuse correctness run stalls a real producer, aborts its write, then writes and reads `[1, 2, 3]`
at the same path. That final byte comparison proves the path can be used again; a timeout alone cannot prove that a
reader, file, or path lock was released.

Previously an admission or cancellation deadline could make the case fail while its write was still running. The harness
recorded the failed case and moved on; only the later filesystem close owned that outstanding operation. Each case now
owns its producer, both operational alarms, and the pending write together. On every exit it aborts and awaits the write
before another case can run. An alarm refuses the scenario and never supplies normal EOF. Both admission and
cancellation have a 60-second operational budget rather than a five-second admission or 1.5-second speed assertion.

```text
producer admitted → caller abort → write settles → source unlocked/cancelled once → same-path exact bytes
       ↓ operational refusal
abort → await actual write settlement → retain original refusal and independent retirement failures
```

The import-safe scenario owner also runs against the memory facade in the maintained runtime controls. Manually held
alarms and cleanup gates check that timeout, early failure, and alarm-acquisition failure cannot return before the owned
write settles. The controls retain `undefined`, `null`, and Error rejection identity and an independent late failure. A
write that reports settlement while retaining its source reader is an independent failure. These controls exercise
ownership rather than simulate Docker or claim mounted-provider success.

The five concurrent create/read checks also await every started sibling before the next case. All independent failures
remain in the failed row through the existing bounded diagnostic serializer, including `undefined`, `null`, and
aggregated retirement causes. This does not change the authored create/read bytes or benchmark callbacks.

Run the actual mount workflow with `deno task test:filesystem-clients`. Its existing mount capability exclusions and
byte workloads remain unchanged. A backend that ignores cancellation forever still needs the outer runner to terminate
it; the harness does not report invented cleanup. Historical mounted passes and earlier failed preparations remain
separate evidence from this revised source.
