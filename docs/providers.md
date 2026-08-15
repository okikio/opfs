Object-provider integration tests
=================================

Purpose
-------

The direct S3 and Azure clients own HTTP protocol behavior that a pure mock
cannot prove.  This guide explains the local provider environment used to test
real signing, request routing, range transfer, multipart/block state, copy,
listing, and filesystem translation without requiring cloud credentials for
every maintainer run.

The provider environment supplements deterministic unit tests.  It does not
replace Amazon S3 or Azure specifications.


Local topology
--------------

`tests/provider/compose.yml` starts two independent object services:

```text
Deno test process
    |
    +--> http://127.0.0.1:8333
    |       SeaweedFS S3 endpoint
    |       bucket: opfs-test
    |       SigV4 credentials: admin / secret
    |
    `--> http://127.0.0.1:10000/devstoreaccount1
            Azurite Blob endpoint
            Shared Key development account
```

The compose file pins explicit provider versions so a maintainer does not get a
silent protocol change because `latest` moved:

```text
chrislusf/seaweedfs:4.41
mcr.microsoft.com/azure-storage/azurite:3.36.0
```

SeaweedFS is used as an actively maintained independent S3-compatible server.
Its role is interoperability testing.  Amazon S3 documentation remains the
source of truth for AWS-specific request behavior.

Azurite is Microsoft's local Azure Storage emulator.  It runs only the Blob
service for this test matrix, with telemetry disabled and in-memory persistence.
`--skipApiVersionCheck` allows the direct client to exercise the configured
current REST version even when the emulator has not yet added an identical
version allow-list.  This option does not make Azurite behavior identical to the
Azure cloud service.


Run the provider suite
----------------------

The canonical maintainer command is:

```sh
mise run test-providers
```

The task performs this lifecycle:

```text
docker compose up -d
        |
        v
poll S3 and Azure HTTP endpoints
        |
        v
deno ci frozen-lock dependency install
        |
        v
deno test tests/provider.test.ts
        |
        v
always docker compose down -v
```

Cleanup is registered before readiness polling.  A failing test therefore does
not intentionally leave provider volumes or containers behind.  On readiness
failure, the task prints compose logs before cleanup so the environment failure
remains diagnosable.

The GitHub Actions `providers` job calls the same mise task.  CI does not carry a
second provider-startup implementation.



Provider benchmarks compare equivalent layers
--------------------------------------------

The provider environment also backs an explicit benchmark matrix:

```sh
mise run bench-providers
```

S3 is measured as:

```text
AWS SDK v3 baseline
Bun native S3Client baseline
@okikio/opfs direct SigV4 client
direct ObjectStore adapter
FileSystemType with metrics none
FileSystemType with metrics basic
```

Azure is measured as:

```text
@azure/storage-blob baseline
@okikio/opfs direct Azure REST client
direct ObjectStore adapter
FileSystemType with metrics none
FileSystemType with metrics basic
```

Write cases include the same post-write metadata request when the project client returns verified object metadata. Multipart is a
separate benchmark from a small replacement because request-count and commit topology are different. This avoids presenting an
SDK/client request-plan difference as facade overhead.

The Bun provider run is separate because its native S3 implementation is runtime-specific. The local Bun filesystem benchmark
also compares Node-compatible `copyFile` with `Bun.write(destination, Bun.file(source))`; the project does not switch the adapter
copy path until measurements justify the change.

These loopback benchmarks are overhead diagnostics, not cloud throughput claims. They should be repeated against controlled real
provider environments before using them to choose production concurrency, retry, or part sizes.

What the live tests prove
-------------------------

The S3 path validates:

 -  a real SigV4 HTTP request accepted by an independent S3-compatible server;
 -  PUT and HEAD;
 -  byte-range GET;
 -  create-only conditional replacement;
 -  multipart stream upload with a legal non-final part size;
 -  provider-side copy;
 -  prefix listing;
 -  delete cleanup;
 -  `ObjectStoreType -> AdapterType -> FileSystemType` translation.

The Azure path validates:

 -  Shared Key accepted by Azurite;
 -  explicit container creation;
 -  Put Blob and Get Blob Properties;
 -  byte-range GET;
 -  create-only conditional replacement;
 -  Put Block / Put Block List streaming upload;
 -  same-account server-side copy;
 -  prefix listing;
 -  delete cleanup;
 -  `ObjectStoreType -> AdapterType -> FileSystemType` translation.

These are end-to-end HTTP tests.  The provider receives the actual headers,
query fields, body bytes, XML, and signatures created by the library.


What the live tests do not prove
--------------------------------

A provider emulator/compatible server cannot prove all details of a cloud
service.  The suite does not use it as an oracle for:

 -  exact AWS canonical-request text;
 -  AWS-only embedded error bodies returned with HTTP 200;
 -  every S3 service limit;
 -  Azure Shared Key string-to-sign construction independent of Azurite;
 -  every historical Azure service-version size limit;
 -  cloud identity/role acquisition;
 -  region routing and redirects;
 -  provider throttling behavior;
 -  cloud durability or consistency guarantees;
 -  billing, lifecycle, retention, encryption, replication, or versioning.

Those behaviors are covered by deterministic protocol tests where possible and
remain candidates for opt-in real-cloud suites.


Why the matrix keeps both test styles
-------------------------------------

A mock can assert an exact canonical signature, but it can accidentally accept a
request no real server would parse.  A container can prove the request works,
but an emulator can also be more permissive than the cloud service.

The two test styles therefore protect different failure classes:

| Test style | Strong at | Weak at |
| ---------- | --------- | ------- |
| Deterministic request test | Exact canonical text, headers, limits, branch selection | Real HTTP parser/auth integration |
| Local provider container | Real socket/HTTP/auth/protocol interoperability | Complete cloud parity |
| Optional real cloud | Actual provider behavior | Cost, credentials, availability, reproducibility |

A client change that affects signing, multipart/block state, copy, conditional
writes, or provider errors should add or update the deterministic test **and**
the provider test when the behavior is supported by the local implementation.


Future provider breadth
-----------------------

S3 compatibility should eventually be tested against more than one independent
implementation when that adds a materially different contract.  Useful future
candidates include Cloudflare R2, Backblaze B2 S3, DigitalOcean Spaces, and a
real Amazon S3 bucket through opt-in CI.  These should not all become mandatory
Docker services merely to increase a provider count.

The selection criterion is behavioral diversity:

 -  different addressing requirements;
 -  missing copy or conditional-write behavior;
 -  different multipart error behavior;
 -  non-AWS region/signing expectations;
 -  list/pagination differences that affect the portable contract.

Azure should similarly gain an opt-in cloud test for the newest service version.
Azurite remains valuable because it gives every contributor a deterministic
Shared Key integration without cloud credentials.
