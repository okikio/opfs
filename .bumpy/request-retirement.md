---
"@okikio/opfs": patch
---

### Keep request rejection and caller abort as observed events

Request cancellation used to omit a rejection when its value equalled `signal.reason`. That equality can describe native
Fetch forwarding the caller's reason, or two authored events that happen to throw the same value. It cannot establish
which event occurred. Request preparation now has an attempt-owned abort token. If cancellation wins while preparation
is pending, it keeps its exact scalar reason and cannot dispatch an HTTP request. If preparation wins by rejecting, that
operation remains primary. Only the attempt's own timeout winner can authorize preparation replay.

A concrete Fetch rejection and an observed caller abort now remain two observations, even when Fetch forwards the same
reason. This records what happened without claiming two independently caused failures. For example, this complete
injected-transport example performs no network work:

```ts
import { sendRequest } from "@okikio/opfs/request";

const caller = new AbortController();
const reason = new Error("Stop this request");
try {
  await sendRequest(async (signal) => ({
    input: new URL("https://storage.example/object"),
    init: { ...(signal === undefined ? {} : { signal }) },
  }), {
    signal: caller.signal,
    replayable: false,
    fetch: async () => {
      caller.abort(reason); // actual caller event
      throw reason; // actual transport rejection
    },
  });
} catch (failure) {
  if (!(failure instanceof AggregateError)) throw failure;
  console.log(failure.errors[0] === reason, failure.errors[1] === reason); // true true
  console.log(failure.cause === reason); // true: the operation remains primary
}
```

An additional observer or response-retirement fault stays additional evidence; it does not become clean cancellation.
Borrowed aggregates remain nested. Applications that compared every Fetch cancellation directly with `signal.reason`
should retain the operation's aggregate rather than discard an entry by value. Private integration metadata binds
composed cancellation observations to the exact caller signal and records whether abort, operation, or an earlier
attempt deadline was primary. It adds no public policy flag and does not infer causal independence or traverse borrowed
errors.

Uncooperative signing or credential callbacks can continue internally after cancellation; their observed eventual result
cannot publish a request. The retry engine still owns abort during backoff, outside an active attempt. Its scalar result
is not presented as a tagged concrete Fetch rejection. Raw response ownership, response body retirement, nonreplayable
requests and ordinary retry policy remain unchanged. Authored controls cover equal-valued events, scalar winners,
borrowed provenance and additional observer faults. Real native Fetch propagation and emulator cancellation remain
separate runtime gates; this entry does not claim those gates or a performance result from the source change.
