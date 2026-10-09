---
"@okikio/opfs": patch
---

### Keep append and truncation on one mutable host file

Streaming append with `truncate: true` previously opened an append-mode descriptor and then asked it to truncate. On
Windows, that descriptor lacks the mutable-write rights required by the truncation operation, so bytes could be appended
before the write rejected with a native permission error. A complete append without a signal also used a fast path that
ignored the requested truncation.

Node and Bun's delegated Node-compatible lane now acquire one mutable file for append with truncation. The driver reads
that descriptor's EOF once, writes each chunk at the advancing cursor and truncates the same descriptor after input
retirement. Complete bytes, empty input and streamed chunks use that owner with or without a signal:

```ts
import { createNodeDriver } from "@okikio/opfs/driver/node";

const driver = createNodeDriver({ root: "/trusted/cache" });
await driver.writeFile("/journal.bin", new Uint8Array([1, 2]), { mode: "replace" });
await driver.writeFile("/journal.bin", new Uint8Array([3, 4]), { mode: "append", truncate: true });
console.log([...await driver.readFile("/journal.bin")]); // [1, 2, 3, 4]
```

```text
acquire mutable file → capture EOF → partial writes → retire input → truncate same file → close
```

The descriptor remains pinned to its file if the namespace path changes. Acquisition also creates an absent file
exclusively; a competing creation is reopened for update once, preserving its existing bytes instead of clearing them.
The same acquisition rule protects update-mode writes. Another disappearance or native admission failure rejects rather
than starting an unbounded retry loop.

Append with truncation requires cooperating writers, as it already does in the Deno lane. Another writer's later bytes
can be overwritten by positioned writes or removed by the final truncation. Use the filesystem facade's cooperating path
locks or application coordination when writers share a file. Ordinary Node append without truncation keeps native append
mode. Cancellation prevents further admission and joins acquired cleanup; neither route promises rollback or durability.

The controls exercise actual host bytes for absent and existing files, empty and multi-chunk input, direct bytes and
streams, and live or absent signals. Additional controls force partial native writes, rename the acquired file while
writing, retain a competing creation's prefix and inspect exact operation/close failures. These controls establish those
scenarios when their native runtime lanes pass; formatting alone is not runtime or Windows proof.
