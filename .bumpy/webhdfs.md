---
"@okikio/opfs": minor
---

### Access HDFS files with explicit NameNode and DataNode credentials

Optional `webhdfs`, `driver/webhdfs` and `adapter/webhdfs` subpaths implement a bounded native HTTP profile. File data
follows one admitted DataNode redirect; NameNode headers and delegation tokens are not automatically forwarded.
Applications provide separate per-target authentication and exact allowed origins. No cluster discovery or Kerberos
negotiation runs on import.

```ts
import { createFileSystem } from "@okikio/opfs";
import { createWebhdfsClient } from "@okikio/opfs/webhdfs";
import { createWebhdfsAdapter } from "@okikio/opfs/adapter/webhdfs";

const client = createWebhdfsClient({
  endpoint: "https://namenode.example:9871/webhdfs/v1",
  root: "/user/app",
  dataOrigins: ["https://datanode.example:9865"],
  // Supply your cluster's independently authorized credentials for each target.
  auth: (_url, _target) => ({ query: { "user.name": "app" } }),
});
const files = createFileSystem(createWebhdfsAdapter(client));
try {
  // The parent directory must already exist in this conservative file projection.
  await files.writeFile("/hello.txt", "hello");
  console.log(await files.readText("/hello.txt"));
} finally {
  await files[Symbol.asyncDispose]();
}
```

The driver supports materialized replacement/native append and bounded file reads. It refuses canonical mkdir, rename,
copy, positional update and streaming writes where native semantics do not establish the required primitive. Native
mkdir and rename remain direct client operations. Nonrecursive DELETE cannot silently remove a nonempty directory. An
append with a lost receipt is an unknown publication outcome, never an instruction to append again automatically.

See [the complete protocol and authentication guide](docs/webhdfs.md) for redirect restrictions, LISTSTATUS_BATCH server
requirements, bounds and recovery. Two-origin HTTP fixtures prove the exercised message/credential behavior; they do not
establish real HDFS, Kerberos, encryption-zone or HA conformance. Reads remain server-trusted, with no immutable
snapshot or replay identity inferred from a path or modification time.
