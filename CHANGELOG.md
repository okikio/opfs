# Changelog

## 0.1.0

2026-10-06

### Preserve Drizzle column types without importing unrelated dialect declarations

The Drizzle driver now exposes a small column contract that retains the table builder's inferred string and number
values. Importing the driver no longer requires consumers to type-check every SQL dialect reached by Drizzle's public
column declarations. Applications still supply actual Drizzle columns; construction rejects missing columns and plain
objects that imitate the column shape before querying the database.

For example, a text path column and a numeric size column remain valid, while a text size column fails the public type
contract. Existing Drizzle tables retain their inference. This change addresses the OPFS declaration boundary;
applications that directly import other Drizzle entry points still depend on those upstream declarations and their peer
requirements.

### Use the configured Blob operation version for SAS requests

Azure SAS requests now select the client's configured REST version through `api-version`, including source URLs for
server-side copy. Previously, Azure could use the token's older signing version to execute an operation even though the
client planned its upload against newer block limits.

The token's signed `sv`, signature and permissions remain intact. The configured client version takes precedence over an
`api-version` embedded in the token or a low-level request query, matching the existing `x-ms-version` header rule.
Applications that need older Blob operation semantics should set the client `version` option explicitly.

### Preserve a multipart source failure after admitted work finishes

A multipart upload can have two independent failures: the input iterator can reject while an already admitted part
upload also fails. The upload now waits for admitted work to settle and preserves both failures. An iterator rejection
is retained even when its rejection value is `undefined`.

This matters when a network-backed input stops midway through an S3 or Azure transfer. Previously, a pooling primitive
could lose the source rejection while draining its remaining operations, leaving the caller without the failure that
interrupted the input.

| Failure                                   | Observable result                                 |
| ----------------------------------------- | ------------------------------------------------- |
| Input fails; admitted operations succeed  | Input rejection is preserved                      |
| An operation fails; input succeeds        | Operation rejection is preserved                  |
| Input and an operation fail independently | Both reasons are retained in an aggregate failure |

Applications should await the transfer's terminal result. A progress notification reports activity; it does not prove
the upload completed. This repair does not add a public pooling API or change caller ownership of provider clients.

### Inspect a storage route before transferring data

OPFS now separates the backend driver, OPFS adapter, and portable filesystem facade. Applications can use native backend
capabilities where they are available and use explicit portable fallbacks elsewhere. Each driver describes its
requirements and limits, so a large upload does not have to discover an unsupported route after reading the input.

```ts
import { createFileSystem } from "@okikio/opfs";
import { createMemoryAdapter } from "@okikio/opfs/adapter/memory";

await using files = createFileSystem(createMemoryAdapter(), { coordination: "local" });
await files.writeFile("/state/config.json", '{"enabled":true}', { parents: true });
const bytes = await files.readFile("/state/config.json");
console.log(new TextDecoder().decode(bytes)); // {"enabled":true}
```

For persistent storage, select a browser OPFS, Node, Deno, Bun, database, S3, or Azure adapter explicitly. Memory
storage lasts only as long as the supplied adapter. Applications retain ownership of injected clients, databases, and
externally opened storage resources.

```text
backend client -> driver -> adapter -> filesystem -> ecosystem bridge
                  native     OPFS       paths, locks      consumer API
                  limits     primitives cancellation
```

This layering matters for object stores: a directory is a key prefix, and append, rename, range reads, and multipart
uploads have backend-specific costs. S3 and Azure Blob clients implement the documented operation subsets; this release
does not claim complete vendor API coverage, a Google Cloud Storage client, or POSIX semantics for every backend.

**Migration:** code using backend-specific internals should select a public driver or adapter subpath. Importing the
root does not connect to providers or initialize a browser worker. Host roots are lexical mappings and can follow
existing symlinks; they are not a filesystem security sandbox.
