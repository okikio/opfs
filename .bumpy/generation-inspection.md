---
"@okikio/opfs": patch
---

### Keep a failed KV transaction beside a failed outcome inspection

A KV transaction can apply even when its acknowledgement is lost. The library inspects the same immutable generation,
part or pin identity before deciding whether the operation actually completed. Use the driver normally; inspect its
cause when transport and inspection both fail:

```ts
import { createDenoKvDriver } from "@okikio/opfs/driver/deno-kv";
import { createFileSystem } from "@okikio/opfs";
import { createRecordAdapter } from "@okikio/opfs/adapter/record";

const db = await Deno.openKv("application.db");
const driver = createDenoKvDriver(db, { partition: "always" });
const fs = createFileSystem(createRecordAdapter(driver));
try {
  await fs.writeFile("/snapshot.bin", Uint8Array.of(17, 31));
} catch (error) {
  console.error(error); // Includes actual operation and independent inspection failures.
  // Do not assume this means that a dispatched mutation never applied.
} finally {
  const failures: unknown[] = [];
  try {
    await fs.close();
  } catch (reason) {
    failures.push(reason);
  }
  try {
    db.close();
  } catch (reason) {
    failures.push(reason);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Facade and owned database retirement failed.");
}
```

Previously, a second failed KV read could replace the original commit rejection during writer admission, immutable part
mutation, pin renewal, reclamation, or tombstone removal. These boundaries now retain both actual events in order. An
inspection failure is not proof that the mutation failed to apply. Successful inspection of the known applied state
still reconciles the lost acknowledgement without a false error. Removal requires an actually acquired absent value and
absent versionstamp; inconsistent state is a visible inspection failure.

```text
actual commit rejects → inspect the same identity
                          ├─ applied state → acknowledge
                          ├─ unchanged state → original commit reason
                          └─ inspection fails → [commit reason, inspection reason]
```

The two reasons remain separate even when both are `undefined`, `null`, or the same object. Only library-created
composition records grant primary-error diagnostic provenance; a borrowed aggregate cannot authorize publication or
reclamation. An acknowledged inspection does not replay the transaction or change its CAS fences.

Namespace initialization keeps its explicit `maxRetries` attempt budget. It can acknowledge a lost create response after
acquiring and validating the existing policy. When inspection fails, prior commit failures remain visible. Exhausting
the budget still reports deliberate admission failure, with each failed attempted commit retained beside it. This adds
bounded diagnostic storage proportional to that configured budget, and no extra unbounded retries or background work.

A failed commit whose boundary performs no inspection continues to report its sole original rejection. Admission
conflicts still use their existing finite retry budgets. These changes do not establish that every failed transport
request was unapplied, and callers must continue to treat uncertain durable state conservatively.
