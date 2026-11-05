# Read and write HDFS through its native HTTP protocol

The WebHDFS client uses the NameNode for metadata and routing, then sends file data to an explicitly allowed DataNode.
It does not discover a cluster, read ambient credentials or implement Kerberos negotiation. Applications inject their
authentication owner and Fetch transport. The file driver exposes the subset that fits canonical file primitives without
silently changing native directory or rename semantics.

This example replaces a file inside an existing HDFS directory, appends bytes, then reads a bounded range. Replace the
endpoints and authentication with your cluster's values before running it.

```ts
import { createWebhdfsClient } from "@okikio/opfs/webhdfs";
import { createWebhdfsAdapter } from "@okikio/opfs/adapter/webhdfs";
import { createFileSystem } from "@okikio/opfs";

const client = createWebhdfsClient({
  endpoint: "https://namenode.example:9871/webhdfs/v1",
  root: "/user/app",
  dataOrigins: ["https://datanode.example:9865"],
  auth(_url, _target) {
    // Explicit simple-auth example for a cluster configured to accept it.
    // A secure deployment supplies its own per-target headers/delegation token.
    return { query: { "user.name": "app" } };
  },
});

const files = createFileSystem(createWebhdfsAdapter(client));
try {
  await files.writeFile("/notes.txt", "hello");
  await files.writeFile("/notes.txt", " world", { mode: "append" });
  console.log(new TextDecoder().decode(await files.readFile("/notes.txt", { at: 6, length: 5 }))); // world
} finally {
  await files[Symbol.asyncDispose]();
}
```

The selected root is a path prefix, not a security sandbox against server-side aliases, permission changes or concurrent
path replacement. HDFS permissions and the caller's authentication remain the authority. The client, transport and
credential owner are borrowed by the driver and facade; closing the facade does not close them.

## Redirect and credential authority

File OPEN normally returns HTTP 307 from the NameNode. CREATE and APPEND use two stages: first send a bodyless request
to the NameNode, then send the complete materialized payload to the admitted DataNode. Payload bytes are never sent to
the NameNode in this profile. All Fetch requests use manual redirects and omit ambient cookies.

`dataOrigins` contains exact scheme/host/port origins. An empty list allows direct NameNode responses but no redirects.
The NameNode origin is not implicitly included. The client follows at most one 307, requires the same encoded path,
refuses HTTPS-to-HTTP downgrade, and preserves selected operation, offset, length, overwrite and createparent
parameters. Only documented routing/default parameters are allowed in addition; duplicate or unknown query fields are
rejected before DataNode credentials or bytes are acquired. NameNode HA redirects, arbitrary redirect chains,
`noredirect=true` JSON routing and transparent client-side HDFS encryption are unsupported.

`auth(url, target)` receives a URL copy and `namenode` or `datanode`. It returns headers and optional `user.name`,
`doas` or `delegation` query fields. The client strips credential fields from the redirect, including server-issued
delegation tokens, and calls the DataNode authentication owner independently. It forwards no NameNode Authorization
header or query token automatically. A deployment relying on a NameNode-issued token must obtain and provide a suitable
DataNode credential explicitly. Returning the same credential for both roles is a deliberate application choice. URLs
may contain credentials after authentication; avoid logging them.

The protocol owns framing, conditional and range headers. Authentication cannot replace Host, Content-Length,
Transfer-Encoding, Range or HTTP precondition fields. WebHDFS uses `offset` and `length` query parameters with HTTP 200
responses, rather than the ordinary HTTP Range/206 contract. Actual stream bytes and declared lengths are checked
against the selected bound. These responses remain server-trusted file reads; no revision, immutable snapshot or
ByteSource replay identity is invented from a path, modification time, checksum or file ID.

## Native operations and the file projection

| Operation                 | Native client                                                   | Canonical file driver                                                                                                                          |
| ------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Status                    | GETFILESTATUS; retains file/directory/symlink kinds             | Projects regular files/directories; refuses symlink entries.                                                                                   |
| Listing                   | LISTSTATUS_BATCH with bounded pages and entries                 | Validates the full result before yielding; refuses symlink listings.                                                                           |
| Reading                   | OPEN with offset/length; bounded cancellable stream             | Native streams and separately bounded materialized readFile.                                                                                   |
| Replacement               | CREATE; overwrite=false by default, createparent=false          | Materialized replacement selects overwrite=true. No compare-and-swap or preserving publication claim.                                          |
| Append                    | APPEND to an existing file                                      | Native append; a known missing-file rejection falls back to CREATE overwrite=false. A concurrent creator causes failure rather than overwrite. |
| Directory creation        | MKDIRS recursively creates parents                              | Refused before I/O because it cannot guarantee one-entry directory creation.                                                                   |
| Removal                   | DELETE; recursive=false by default, explicit true allowed       | Always recursive=false. A concurrent nonempty directory cannot turn it into recursive deletion.                                                |
| Rename                    | Native RENAME, including move-into-existing-directory semantics | Refused; native RENAME cannot promise the requested canonical destination under directory races.                                               |
| Copy/update/stream writes | Not implemented                                                 | Refused before I/O.                                                                                                                            |

Canonical `mkdir`, `ensureDir` and directory-handle creation are unsupported, including recursive variants. A filesystem
write with `parents:true` cannot overcome this limit if an ancestor is missing. An application may explicitly call
`client.mkdir()` when it wants native recursive directory creation, then use the file facade inside that existing
directory. Native removal with `recursive:true` and native rename are independent client operations; neither is
relabeled as a stronger canonical primitive. Generic copy/move fallback is also refused.

An acknowledged APPEND is not idempotent. The client never automatically retries a dispatched mutation, even when a
configured request policy permits retries for reads. A transport failure after dispatch, 5xx/408, unexpected success
status or malformed namespace receipt produces `WebhdfsPublicationError`. Some bytes or namespace changes may already
exist. Inspect the remote state through application-owned reconciliation before retrying; blindly repeating an append
can duplicate bytes. A known HTTP rejection remains `WebhdfsError`; the file projection maps known statuses to
`FileSystemError` while retaining the cause. `WebhdfsRejectionError` identifies a `boolean:false` receipt without
inventing an HTTP status or a more specific reason; the projection maps it to `invalid-operation`. Cancellation stops
further admission and joins response cleanup, but does not roll back mutations.

## Bounds and interoperability evidence

Client defaults are 8 MiB per materialized write, 1 GiB per OPEN stream, 100,000 listing entries and 10,000 pages.
Control JSON uses the shared 8 MiB response limit. LISTSTATUS_BATCH is an explicit server requirement: there is no
unbounded LISTSTATUS fallback. Each page must advance its last-child cursor in unsigned UTF-8 order without duplicate,
malformed or aliased child names. Listing is not a snapshot of a concurrently changing directory. The driver has a
separate `maxBufferedReadBytes` policy, default 8 MiB. Stream reads do not materialize the complete file. Native Web
Crypto, filesystem runtimes or external SDKs are not acquired by importing this module.

Focused tests cover independent target authentication, redirect rejection before payload acquisition, bounded
status/list/body parsing, append acknowledgement loss without retry, direct/facade hard refusal and error causes. The
separate HTTP test uses two disposable loopback origins to exercise native client, driver, adapter and facade behavior
through real Fetch. This is protocol-fixture evidence, not a real HDFS server, MiniDFSCluster, Kerberos, Hadoop
encryption-zone or full provider conformance result. No maintained real HDFS container was run for this slice;
deployment verification against the target cluster remains required before claiming it.

Primary sources:
[Hadoop 3.4.2 WebHDFS REST API](https://hadoop.apache.org/docs/r3.4.2/hadoop-project-dist/hadoop-hdfs/WebHDFS.html) and
[NameNode HTTP implementation](https://github.com/apache/hadoop/blob/rel/release-3.4.2/hadoop-hdfs-project/hadoop-hdfs/src/main/java/org/apache/hadoop/hdfs/server/namenode/web/resources/NamenodeWebHdfsMethods.java).
