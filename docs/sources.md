Research and source register
============================

Research date: 2026-08-15.

This register records the external contracts used to design and test the implementation. Source code and provider behavior can
change, so a release review should recheck current primary sources rather than assuming this date remains current.

Use this authority order when sources disagree:

1. current standards and current upstream source/contracts;
2. current repository implementation rules and project architecture guides;
3. current package implementation and tests;
4. older experiments and secondary performance reports.

The package intentionally distinguishes implemented behavior from provider claims and proposals. A compatibility note in this
file is not evidence that an adapter passed a live integration test against that provider.

Browser File System and OPFS
----------------------------

Primary sources:

- WHATWG File System Standard: <https://fs.spec.whatwg.org/>
- WHATWG File System issues: <https://github.com/whatwg/fs/issues>
- Web Platform Tests File System results: <https://wpt.fyi/results/fs>
- WPT interoperability tracking: <https://github.com/web-platform-tests/interop/issues/172>
- MDN Origin Private File System overview:
  <https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system>
- web.dev OPFS overview: <https://web.dev/articles/origin-private-file-system>

The implementation follows these observed design facts:

- asynchronous file/directory handles are the portable frontend;
- sync access is context/capability-specific and owns a native file lock for its lifetime;
- writable streams and sync handles have explicit close/abort lifecycle;
- browser storage policy can change availability, partitioning, persistence, quota, and error shape;
- third-party/opaque iframe behavior must be tested from the actual context;
- portable OPFS does not imply the same native rename model as Node/Deno host filesystems.

Secondary OPFS/performance context reviewed earlier in the project:

- <https://rxdb.info/rx-storage-opfs.html>
- <https://lofttools.com/blog/opfs-origin-private-file-system/>
- <https://barndoors.lumafield.com/3x-faster-project-loads-with-the-origin-private-file-system/>

These sources informed performance questions. They do not override the File System Standard or real browser tests.

Playwright
----------

Primary documentation:

- Browsers: <https://playwright.dev/docs/browsers>
- Test projects: <https://playwright.dev/docs/test-projects>
- Browser contexts/isolation: <https://playwright.dev/docs/browser-contexts>
- BrowserType persistent contexts: <https://playwright.dev/docs/api/class-browsertype>
- Frames: <https://playwright.dev/docs/frames>
- Service workers: <https://playwright.dev/docs/service-workers>
- Test configuration and webServer: <https://playwright.dev/docs/test-configuration>

The canonical browser test architecture uses Playwright Test for Chromium, Firefox, and WebKit. Chromium gets deeper
ServiceWorker instrumentation because Playwright documents that inspection surface as Chromium-specific; observable
ServiceWorker behavior remains a black-box test in the other browsers.

Testcontainers
--------------

Primary documentation and source reviewed:

- Testcontainers Node quickstart/usage: <https://node.testcontainers.org/quickstart/usage/>
- containers and random mapped ports: <https://node.testcontainers.org/features/containers/>
- wait strategies: <https://node.testcontainers.org/features/wait-strategies/>
- supported container runtimes: <https://node.testcontainers.org/supported-container-runtimes/>
- Azurite module: <https://node.testcontainers.org/modules/azurite/>
- Toxiproxy module: <https://node.testcontainers.org/modules/toxiproxy/>
- repository: <https://github.com/testcontainers/testcontainers-node>

The provider suite keeps `node:test` as the test runner and uses Testcontainers only for service lifecycle. The official Azurite
module is used instead of reproducing its container flags. SeaweedFS has no focused Testcontainers module, so the fixture uses
`GenericContainer` with the pinned image and a composite listening-port/HTTP wait. Random mapped host ports avoid collisions
between concurrent local runs.

Testcontainers currently documents Docker directly and Docker-compatible configuration for Podman, Colima, and Rancher Desktop.
Those runtimes have provider-specific caveats, including Ryuk behavior under Podman and delayed port forwarding under
Colima/Rancher. The package therefore treats Testcontainers as an interim test-resource implementation, not as the future
compute-provider API for OPFS.

Deno, Node, and Bun
-------------------

Primary runtime sources:

- Deno testing: <https://docs.deno.com/runtime/test/>
- Deno Node compatibility: <https://docs.deno.com/runtime/fundamentals/node/>
- Deno API reference: <https://docs.deno.com/api/>
- Deno KV API: <https://docs.deno.com/api/deno/~/Deno.Kv>
- Bun Node compatibility: <https://bun.com/docs/runtime/nodejs-compat>
- Bun benchmarking guidance: <https://bun.com/docs/project/benchmarking>
- Node documentation: <https://nodejs.org/docs/latest/api/>

Current Deno documentation treats `node:test` as a first-class test API and currently marks Deno KV unstable. The real Deno KV
suite therefore uses `--unstable-kv` without making that flag part of unrelated source imports. Current Deno KV documentation
states a 2 KiB serialized key limit, a 64 KiB serialized value limit, 1,000 mutations per atomic operation, and an 800 KiB total
atomic-operation limit. The Deno KV adapter exposes these constraints and uses a configurable manifest/part layout instead of
pretending one logical file must fit in one 64 KiB value.

Current Bun compatibility documentation says its in-process `node:test` API works when files run under `bun test`, while some
advanced Node test-runner/reporting features remain incomplete. The repository uses the common `describe`/`it`/hooks subset and
keeps the test API itself as `node:test`.

Bun's current File I/O documentation says `Bun.write(destination, Bun.file(source))` selects fast platform system calls for
file-to-file copies. The current Bun Rust source also keeps file-backed Blob state distinct so file-to-file paths can avoid a
naive user-space read/write loop. The benchmark therefore compares Bun's direct copy shape with Node-compatible `copyFile`
before changing the adapter implementation.

Bun's S3 documentation exposes `S3Client`, `S3File`, `write`, `stat`, `stream`, and multipart `writer()` APIs. A Bun-only provider
benchmark now uses that native implementation as a second S3 baseline beside AWS SDK v3. The project does not treat Bun main
branch implementation work as proof about a released runtime; the mise pin remains the current released version selected by the
repository until a deliberate toolchain update.

Deno standard libraries and Standard Schema
-------------------------------------------

Primary sources reviewed from the current `denoland/std` repository and JSR
packages:

 -  `@std/async`: <https://jsr.io/@std/async>
 -  `@std/bytes`: <https://jsr.io/@std/bytes>
 -  `@std/encoding`: <https://jsr.io/@std/encoding>
 -  `@std/expect`: <https://jsr.io/@std/expect>
 -  `@std/fs`: <https://jsr.io/@std/fs>
 -  `@std/http`: <https://jsr.io/@std/http>
 -  `@std/path`: <https://jsr.io/@std/path>
 -  `@std/streams`: <https://jsr.io/@std/streams>
 -  `@std/xml`: <https://jsr.io/@std/xml>
 -  `@std/crypto`: <https://jsr.io/@std/crypto>
 -  Standard Schema: <https://standardschema.dev/>
 -  Zod 4: <https://zod.dev/>

The review was operation-led. A standard package replaces project code only
when its contract matches the filesystem or provider requirement without hiding
a stronger invariant.

`@std/async/pool` owns bounded multipart and block concurrency. The stable
`pooledMap()` contract limits active requests and lets already-started requests
settle after one item fails. S3 cleanup waits for that settlement before it
sends `AbortMultipartUpload`, so a late part cannot arrive after the cleanup
request.

`@std/async/retry` owns the direct clients' exponential backoff, jitter, AbortSignal, and retriable-error loop. The protocol
layer still classifies whether a request may enter that loop. One-shot streams are not replayed, and S3 multipart initiation and
completion disable automatic retry because a lost response can make the remote lifecycle outcome ambiguous. The low-level
request APIs also expose `retry: false` for provider-specific operations.

`@std/bytes/concat` owns byte-array concatenation used by bounded chunk
assembly. The package does not maintain another concatenation implementation.

`@std/streams` owns bounded materialization through
`LimitedBytesTransformStream` and final stream collection through `toBytes()`.
The current `FixedChunkStream` API is still marked unstable, so fixed-size
provider chunks remain in the package's small streaming adapter until that
standard contract is suitable for a public dependency.

`@std/encoding` owns Base64 and hexadecimal encoding through their direct
subpaths. S3 uses hexadecimal SHA-256 output, Azure Shared Key and block IDs
use Base64, and record stores use Base64 for portable byte persistence.

`@std/path` owns host path normalization and resolution for the Deno, Bun, and
Node adapters. The OPFS virtual path model remains project-owned because it
rejects and normalizes a different namespace than an operating-system path.

`@std/fs` was reviewed for copy, move, walk, ensure, and host filesystem
operations. Those are intentionally not used inside the primitive Deno/Bun/Node
adapters. The public filesystem facade already owns recursive copy/move/walk,
overwrite, cancellation, and adapter-neutral semantics. Calling `@std/fs` from
one host adapter would duplicate that layer and introduce host-only symlink and
filesystem assumptions. `@std/path`, by contrast, directly replaces custom host
path manipulation without changing facade semantics.

`@std/http/etag` was reviewed for conditional request support. The clients keep
provider ETags opaque instead of generating or evaluating them locally. S3
multipart ETags and Azure ETags are provider tokens, not hashes that this
library should reinterpret. The package therefore forwards `If-Match` and
`If-None-Match` values to the provider rather than applying `@std/http/etag` in
the client. The unstable HTTP message-signature utilities also do not implement
AWS Signature Version 4 or Azure Shared Key.

`@std/xml` owns provider control-document parsing and serialization. S3 list,
error, multipart, and copy responses and Azure list/error/block-list documents
use the standard XML tree instead of regular expressions or hand-written XML
escaping. Storage payloads themselves do not pass through XML parsing.

`@std/crypto` was reviewed but is not used for provider signing. Web Crypto
already exposes browser-compatible SHA-256 and HMAC-SHA256, while the standard
crypto package does not implement AWS Signature Version 4 or Azure Shared Key
canonicalization. Adding it would introduce a wrapper without removing the
protocol code that actually carries the risk.

`@std/expect` remains the assertion API on top of `node:test`. Zod 4 implements
Standard Schema, so the repository exports the Zod schemas directly instead of
maintaining a second validation wrapper for Standard Schema consumers.


S3 and Signature Version 4
--------------------------

AWS primary references:

- Signature Version 4 request authentication:
  <https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html>
- Signature Version 4 canonical request:
  <https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html>
- ListObjectsV2: <https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html>
- CreateMultipartUpload: <https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateMultipartUpload.html>
- UploadPart: <https://docs.aws.amazon.com/AmazonS3/latest/API/API_UploadPart.html>
- CompleteMultipartUpload: <https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html>
- AbortMultipartUpload: <https://docs.aws.amazon.com/AmazonS3/latest/API/API_AbortMultipartUpload.html>
- CopyObject: <https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html>
- UploadPartCopy: <https://docs.aws.amazon.com/AmazonS3/latest/API/API_UploadPartCopy.html>
- S3 multipart limits: <https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html>

Implementation details derived from these contracts include:

- canonical signing includes `host` even though browser Fetch does not let application code set the Host header directly;
- multipart upload parts are bounded and the destination publishes on CompleteMultipartUpload;
- conditional `If-Match`/`If-None-Match` behavior belongs to multipart completion for the commit path used here;
- CompleteMultipartUpload can return an HTTP 200 response whose XML body later reports an error;
- CopyObject can also report an embedded error in an HTTP 200 response;
- CopyObject has a 5 GB source limit, so larger provider-side copies use UploadPartCopy;
- multipart uploads permit at most 10,000 parts and have defined part-size limits.

The package uses Web Crypto and Web Fetch rather than the AWS SDK so the direct client remains small, runtime-neutral, and
explicit about the S3 protocol surface it actually implements.

S3-compatible providers
-----------------------

Provider-specific primary sources reviewed for compatibility differences:

Cloudflare R2:

- S3 API compatibility: <https://developers.cloudflare.com/r2/api/s3/api/>
- release notes: <https://developers.cloudflare.com/r2/platform/release-notes/>

DigitalOcean Spaces:

- S3 compatibility: <https://docs.digitalocean.com/products/spaces/reference/s3-compatibility/>
- limits: <https://docs.digitalocean.com/products/spaces/details/limits/>
- direct API/SigV4: <https://docs.digitalocean.com/products/spaces/how-to/use-aws-sdks/>

Google Cloud Storage XML API:

- interoperability/migration: <https://cloud.google.com/storage/docs/migrating>
- XML multipart uploads: <https://cloud.google.com/storage/docs/multipart-uploads>

Backblaze B2 S3-compatible API:

- S3-compatible API: <https://www.backblaze.com/docs/cloud-storage-s3-compatible-api>

These providers illustrate why capability overrides exist. Endpoint, region, addressing, copy support, multipart preconditions,
checksum behavior, and unsupported control-plane operations can differ even when basic object requests use the S3 protocol.

Azure Blob Storage
------------------

Microsoft primary references:

- Azure Blob REST API: <https://learn.microsoft.com/rest/api/storageservices/blob-service-rest-api>
- Shared Key authorization: <https://learn.microsoft.com/rest/api/storageservices/authorize-with-shared-key>
- Put Blob: <https://learn.microsoft.com/rest/api/storageservices/put-blob>
- Put Block: <https://learn.microsoft.com/rest/api/storageservices/put-block>
- Put Block List: <https://learn.microsoft.com/rest/api/storageservices/put-block-list>
- Copy Blob From URL: <https://learn.microsoft.com/rest/api/storageservices/copy-blob-from-url>
- Put Block From URL: <https://learn.microsoft.com/rest/api/storageservices/put-block-from-url>
- List Blobs: <https://learn.microsoft.com/rest/api/storageservices/list-blobs>
- Versioning for Azure Storage services: <https://learn.microsoft.com/rest/api/storageservices/versioning-for-the-azure-storage-services>

The implementation keeps the service version explicit because accepted block sizes and Shared Key canonicalization depend on
the service version. Shared Key support starts at the augmented Blob format introduced in `2009-09-19`; zero-length
`Content-Length` signing changes after `2014-02-14`, and empty `x-ms-*` header canonicalization changes at `2016-05-31`.
Current copy behavior uses synchronous Copy Blob From URL for the smaller path and Put Block From URL ranges for large
provider-side copies.

Unstorage
---------

Primary sources:

- repository: <https://github.com/unjs/unstorage>
- current Driver/Storage contracts: <https://github.com/unjs/unstorage/blob/main/src/types.ts>
- current storage implementation: <https://github.com/unjs/unstorage/blob/main/src/storage.ts>
- custom drivers: <https://unstorage.unjs.io/guide/custom-driver>
- built-in driver catalog: <https://unstorage.unjs.io/drivers>

The forward bridge targets `Storage`, not individual unstorage drivers. The reverse driver implements the stable Driver subset
needed for values, raw bytes, metadata, keys, clear, and disposal. `maxDepth` is advertised because the reverse driver applies
the depth filter itself.

RxDB
----

Primary sources:

- RxStorage guide: <https://rxdb.info/rx-storage.html>
- RxStorage interface: <https://github.com/pubkey/rxdb/blob/master/src/types/rx-storage.interface.d.ts>
- RxCollection implementation: <https://github.com/pubkey/rxdb/blob/master/src/rx-collection.ts>

The bridge accepts an RxCollection. RxDB retains responsibility for the selected RxStorage, replication, conflicts,
multi-instance behavior, wrappers, and licensing.

db0 and Drizzle
---------------

Primary sources:

- db0: <https://db0.unjs.io/>
- db0 repository: <https://github.com/unjs/db0>
- Drizzle ORM: <https://orm.drizzle.team/>
- Drizzle repository: <https://github.com/drizzle-team/drizzle-orm>

The db0 bridge targets the Database/dialect contract rather than connector names. Direct SQLite reuses that same record schema.
Drizzle keeps table/DDL ownership with the application because its schema builders and database behavior are dialect-specific.

Upstream issue and pull-request review
--------------------------------------

Current upstream issue/PR review was used to find failure modes that happy-path API docs do not reveal. The implementation does
not copy another library's behavior blindly; the issues are evidence for tests and invariants.

Bun S3/Rust work reviewed included fixes for retry coverage, exponential backoff, timeouts, manual redirect handling, option
propagation, multipart abort on writer error, long SigV4 inputs, in-place multipart part assembly, XML parsing, proxy handling,
and worker-termination lifetime safety. The repeated lessons are: signed redirects must not be followed automatically, remote
cleanup has its own lifecycle, part concurrency needs a memory budget, and retry policy must not be inferred from body type alone.

AWS SDK v3 issues reviewed included very large upload memory growth, unknown-size multipart completion hangs, empty-stream lockups,
stream chunk-integrity regressions, conditional-header gaps in `lib-storage`, browser decompression/checksum mismatches, socket
exhaustion, and S3-compatible provider deserialization/endpoint regressions. The project benchmark keeps the AWS SDK as a
baseline while retaining a smaller direct protocol client with independently testable semantics.

Azure SDK issues reviewed included paused-stream abort hangs, invalid upload buffer arguments producing zero-byte blobs, large
buffer/block-size constraints, historical stream/file data corruption, copy polling request noise, and concurrency/default-size
questions. These reinforce explicit size/concurrency limits, bounded block admission, real abort tests, and provider request-count
benchmarks.

Unstorage issues reviewed included non-atomic filesystem writes, S3 pagination/prefix bugs, XML entity decoding, file/prefix
collisions, SQL disposal, binary Redis storage, and Cloudflare Cache method binding. RxDB issues reviewed included OPFS/Expo file
truncation after crashes or rapid writes, large-replication corruption, and concurrency/benchmark questions. db0 issues reviewed
included connector/dialect exposure, caller-owned connections, deprecated sqlite3, and Drizzle result-shape mismatches. These are
why the OPFS project keeps ownership, collision semantics, partial-result failure, and backend capability differences explicit.

Deno KV issue review also covered historical reports about large prefix-list cost and selector/transaction limits:

- <https://github.com/denoland/deno/issues/20218>
- <https://github.com/denoland/deno/issues/19798>
- <https://github.com/denoland/deno/issues/19284>

The Deno KV physical key layout therefore indexes a logical entry by `(namespace, "entry", parentPath, name)`. Listing one
directory uses `(namespace, "entry", parentPath)` as the provider prefix, so descendants of a child directory are not part of
that prefix result. Physical body parts use the complete canonical path as one tuple component rather than expanding each path
segment into the provider prefix. This keeps exact lookup and direct-child enumeration aligned with the filesystem contract.

Recent Drizzle issue review included SQLite/libSQL transaction-lifetime failures and migration/data-loss cases:

- <https://github.com/drizzle-team/drizzle-orm/issues/6008>
- <https://github.com/drizzle-team/drizzle-orm/issues/5782>
- <https://github.com/drizzle-team/drizzle-orm/issues/4938>
- <https://github.com/drizzle-team/drizzle-orm/issues/5564>
- <https://github.com/drizzle-team/drizzle-orm/issues/2463>

These are not all adapter-runtime bugs, but they reinforce a deliberate contract here: the generic Drizzle bridge does not
claim universal cross-process atomic replacement or own application migrations. The caller keeps dialect/driver/table lifecycle
and can provide a stronger database-specific transaction strategy when that concrete driver proves the required semantics.

Project architecture and writing sources
----------------------------------------

The implementation was reviewed against the attached/current project guides covering:

- library-first capability composition;
- resource ownership and cancellation;
- short concrete naming and focused folders;
- compact code formatting;
- smooth narrative TSDoc/comments with invariants, examples, and lifecycle explanation;
- `node:test` plus `@std/expect` as the repository test API;
- runtime-neutral TypeScript and explicit runtime subpaths;
- verification against real runtimes and extracted release artifacts.

Older OPFS experiments were treated as intent/history only. The current repository, current project rules, and current upstream
contracts are the implementation authority for this pass.


Client protocol handoffs
------------------------

The detailed implementation contracts live in [s3.md](./s3.md) and [azure.md](./azure.md). The Testcontainers-backed interoperability
matrix is documented in [providers.md](./providers.md). These files separate protocol requirements from emulator evidence and
record the unsupported surface explicitly.
