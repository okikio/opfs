---
"@okikio/opfs": minor
---

S3-compatible listing can now select its explicit encoding dialect with `listEncoding: "form"`. The default remains
`percent`, which preserves literal plus characters under Amazon S3's encoding contract.

The pinned SeaweedFS4.41 emulator encodes a space as `+` while declaring `EncodingType=url`. Previously a file named
`a b` appeared as `a+b` during listing. Recursive cleanup then attempted the wrong file and correctly refused to remove
the still-populated directory. Select the provider's dialect once; the client, driver, adapter and filesystem share it:

```ts
import { createS3Client } from "@okikio/opfs/s3";
import { createS3DriverFromClient } from "@okikio/opfs/driver/s3";
import { createObjectAdapter } from "@okikio/opfs/adapter/object";
import { createFileSystem } from "@okikio/opfs";

const client = createS3Client({
  endpoint: "https://storage.example",
  bucket: "reports",
  region: "us-east-1",
  credentials: { accessKeyId: "your-key", secretAccessKey: "your-secret" },
  listEncoding: "form",
});
await using fs = createFileSystem(createObjectAdapter(createS3DriverFromClient(client), { prefix: "app" }));
await fs.writeFile("/a b", "space");
await fs.writeFile("/a+b", "plus");
console.log((await Array.fromAsync(fs.readDir("/"))).map((entry) => entry.name));
// a b and a+b remain distinct; list ordering belongs to the provider.
await fs.emptyDir();
```

Only declared URL-encoded keys and prefixes use this policy. Raw fields and continuation tokens remain exact; literal
`%2B` text is not heuristically decoded. `client.listEncoding` exposes the immutable choice without network I/O.
Physical objects are not renamed or migrated, and any previously created plus aliases require deliberate repair. The
emulator regression exercises distinct space, plus, percent and nested names, pagination, byte reads and complete
recursive cleanup. This does not claim that every compatible service uses the same encoding or that emulator proof
establishes live Amazon S3 behavior.
