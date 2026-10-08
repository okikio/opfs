---
"@okikio/opfs": patch
---

### Test cancellation after the provider accepts a part

The real-provider cancellation scenario first writes an old object, then starts a streamed replacement with one part and
a stalled producer. A successful part response for that exact object triggers caller cancellation. The scenario checks
that the producer was cancelled once and unlocked, the old bytes remain complete, and S3 has no unfinished multipart
upload for the key.

```text
seed old bytes → begin streamed replacement → provider accepts one part → caller aborts
                                                                  ↓
                                               await upload and producer retirement
                                                                  ↓
                                         compare old bytes and inspect multipart state
```

Previously a five-second rescue started before the initial write. A slow setup or a legitimate large-part transfer could
consume that budget, and the rescue closed the producer normally. That mixed a timing assumption with the cancellation
contract. Setup now finishes before the upload owns its 60-second operational watchdog. Expiry aborts with a distinct
failure and waits for actual upload settlement; it cannot manufacture normal EOF or certify successful cancellation. The
outer runner remains responsible for terminating an implementation that never settles after abort. This budget protects
the test run and does not define a provider latency target.

A failed part response, an unrelated key, a seed write or multipart creation cannot trigger the cancellation oracle.
Manual-alarm controls cover actual source cancellation and delayed reader retirement, refusal of an operation that
ignores abort, original rejection identity, and independent deadline, operation and timer-retirement failures. The same
TypeScript controls run through the maintained runtime test tasks.

This changes test ownership rather than publication retry policy. An opaque Fetch failure during the initial PUT still
has an unknown publication outcome, because entering Fetch does not reveal whether the service committed the write. The
library retains that cause and does not automatically replay the PUT. A fresh provider run and a successful focused
control do not turn an earlier failed preparation into a successful one, or establish full live-cloud conformance.
