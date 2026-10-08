---
"@okikio/opfs": minor
---

Object-storage filesystems continue to validate the destination at the facade and again at the adapter before
publication. This is the default for applications that need the existing validation path when saving binary state or
exported reports. No consumer needs to enable a performance route to keep that behavior.

An explicit `{ optimizations: { writeAdmission: true } }` option delegates destination admission to an adapter declaring
`capabilities.validatesReplacement`. Delegation applies only to already materialized ArrayBuffer and view inputs. The
adapter still reads fresh metadata, rejects file/directory collisions, and sends the current ETag precondition. This is
validation at the adapter, not disabled validation.

For an existing root-level file on S3 or Azure Blob, the two request paths are:

```text
default: facade HEAD + marker HEAD + LIST -> adapter HEAD + marker HEAD + LIST -> PUT
opt-in:                                     adapter HEAD + marker HEAD + LIST -> PUT
```

Nothing is cached between writes. Parent checks, locks, cancellation, acknowledgement, and resource ownership keep their
existing contracts. The opt-in route removes three requests from this warm binary replacement workflow; it does not
establish a universal latency percentage or a live-cloud throughput claim. Keep the default when you require both
validation stages.

This complete Deno example uses an existing S3 bucket. Supply your endpoint, bucket, region, and credentials through the
named environment variables before running it with environment and network permissions:

```ts
import { createFileSystem } from "@okikio/opfs";
import { createS3Client } from "@okikio/opfs/s3";
import { createS3DriverFromClient } from "@okikio/opfs/driver/s3";
import { createObjectAdapter } from "@okikio/opfs/adapter/object";

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Set ${name} before running this example.`);
  return value;
}

const client = createS3Client({
  endpoint: required("S3_ENDPOINT"),
  bucket: required("S3_BUCKET"),
  region: required("AWS_REGION"),
  credentials: {
    accessKeyId: required("AWS_ACCESS_KEY_ID"),
    secretAccessKey: required("AWS_SECRET_ACCESS_KEY"),
  },
});
await using fs = createFileSystem(createObjectAdapter(createS3DriverFromClient(client)));
const bytes = new TextEncoder().encode("new report");
await fs.writeFile("/report.bin", bytes);
console.log(new TextDecoder().decode(await fs.readFile("/report.bin")));
console.log(fs.inspect().adapter.native.validatesReplacement); // true
console.log(fs.inspect().optimizations.writeAdmission); // false
```

Set `{ optimizations: { writeAdmission: true } }` in `createFileSystem()` only when explicitly choosing adapter-owned
validation for binary replacements. Leaving the option absent, or setting it to false, keeps both validation stages.
Custom adapters must explicitly declare the replacement-validation guarantee; omitting it keeps facade validation.
Strings, Blobs, streams, append, and update retain facade validation. In particular, an invalid destination is rejected
before the facade encodes a string, reads a Blob, or acquires an iterable producer. The provider benchmark includes both
admission routes, independent request-count controls, complete byte checks, and the official SDK comparisons.
