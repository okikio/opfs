# Provider and filesystem baseline tests

## Purpose

S3 and Azure Blob have two kinds of external baseline:

1. protocol/API clients such as the AWS SDK and Azure SDK;
2. filesystem clients such as AWS Mountpoint and Azure BlobFuse.

They answer different questions. SDK/provider tests validate object protocol behavior. Filesystem-client benchmarks
compare the performance and semantics of a mature provider-to-filesystem translation against this package's own
driver/adapter/facade stack.

## Testcontainers owns disposable protocol providers

`tests/provider/fixture.ts` starts local provider services with Testcontainers for Node.js.

```text
node:test / Mitata
       |
 ProviderFixture
       |
       +-- SeaweedFS
       |     S3-compatible endpoint
       |
       `-- Azurite
             Azure Blob endpoint
```

The fixture uses mapped host ports and Testcontainers-owned readiness/cleanup. There is no repository-owned Docker
Compose lifecycle, fixed provider port, curl readiness loop, or shell trap for these services.

The provider fixture is test infrastructure only. Public package code does not import Testcontainers.

## SeaweedFS S3 target

SeaweedFS is used as one independent S3-compatible implementation. The test config supplies endpoint, bucket, region,
and test credentials to:

```text
AWS SDK
project S3 client
project S3 driver
project S3 adapter
FileSystemType
```

Tests cover the implemented shared contract, including:

- signed put/head/get/delete;
- byte ranges;
- conditional create/replace where supported by the fixture;
- multipart streamed replacement;
- server-side copy;
- prefix/delimiter listing;
- filesystem directory/object translation.

SeaweedFS does not define Amazon S3 semantics. AWS-specific limits and canonical signing behavior remain covered by
deterministic protocol tests and AWS primary documentation.

## Azurite target

The official `@testcontainers/azurite` module supplies a Blob endpoint and test account credentials.

The provider suite exercises:

```text
Azure SDK
project Azure client
project Azure driver
project Azure adapter
FileSystemType
```

Coverage includes:

- Shared Key authentication against the emulator;
- blob put/head/range/delete;
- block upload and block-list commit;
- server-side copy;
- container listing/prefix translation;
- filesystem translation.

Azurite is an emulator. A green Azurite result is interoperability evidence, not proof of every cloud Azure service
version or feature.

## Provider benchmark staircase

`bench/provider.bench.ts` keeps every layer visible.

S3:

```text
AWS SDK
  -> project S3 client
  -> project S3 driver
  -> project object adapter
  -> facade metrics:none
  -> facade metrics:basic
```

Azure:

```text
Azure SDK
  -> project Azure client
  -> project Azure driver
  -> project object adapter
  -> facade metrics:none
  -> facade metrics:basic
```

These are separate benchmark samples, not one chain executed for each operation. The staircase wording means each result
adds one project layer over the same configured provider.

`bench/bun-provider.bench.ts` adds Bun's native S3 client as another S3 baseline when Bun is available.

Container startup and image pull are completed before measured Mitata cases begin.

## Physical versus logical metrics

The provider client/driver can report physical counters such as requests, retries, responses, failures, and
multipart/block work. The facade reports logical filesystem operations and facade buffering.

A benchmark should not infer provider requests from logical operations. One logical large write can become many physical
parts.

## AWS Mountpoint baseline

AWS Mountpoint is a separate filesystem-client comparator. It translates file operations to S3 and deliberately supports
a subset of ordinary filesystem semantics.

The package does not assume Mountpoint is a generic S3-compatible implementation. The benchmark target should use Amazon
S3 when that is the intended conformance/performance comparison. A custom endpoint can be used for local experimentation
when Mountpoint supports the selected endpoint configuration, but that does not turn the result into an AWS-supported
compatibility claim.

Mountpoint setup/mount lifecycle is external to the normal Testcontainers provider fixture because it is a host
FUSE/system client. After the mount exists, set:

```sh
OPFS_MOUNTPOINT_S3_ROOT=/path/to/mount
mise run bench-filesystem-clients
```

The benchmark then measures:

```text
raw Node fs against the mount
Node file driver against the mount
file adapter against the driver
FileSystemType against the adapter
```

This shows the project overhead when the provider-to-filesystem translation is owned by Mountpoint rather than by the
package's S3 client/driver.

## Azure BlobFuse baseline

BlobFuse is the analogous Azure Blob filesystem-client comparator. It also has caching/configuration semantics that can
change observable filesystem behavior and performance.

Provision/mount BlobFuse externally, then run:

```sh
OPFS_BLOBFUSE_ROOT=/path/to/mount
mise run bench-filesystem-clients
```

The same raw -> driver -> adapter -> facade staircase is measured.

Caching mode and write mode must be recorded with benchmark results. A cached BlobFuse read is not semantically
equivalent to a direct uncached REST read simply because both return the same bytes in one sample.

## Why filesystem-client mounts are not a default CI job

Mountpoint and BlobFuse need operating-system packages, FUSE support, mount permissions, and cleanup. Those requirements
are materially different from a disposable HTTP test container.

The repository therefore provides a canonical benchmark program and mise task, while the runner owns system-level mount
setup. A dedicated privileged benchmark runner can automate installation/mounting without making ordinary pull-request
CI depend on FUSE privileges.

## Comparable operations only

Filesystem clients do not necessarily implement all POSIX operations, and object stores do not naturally have POSIX
semantics. The benchmark therefore starts from supported operations rather than treating an unsupported operation as a
slow operation.

For each baseline, record:

```text
operation
native/support status
cache mode
write mode
payload size
concurrency
elapsed/throughput
request/physical metrics when available
```

A performance comparison is valid only when the operation semantics being compared are close enough to answer the same
question.

## Real cloud suites

Local provider fixtures should be supplemented by opt-in cloud suites before high-confidence releases of protocol
changes.

Amazon S3:

- short-lived credentials;
- disposable bucket/prefix;
- explicit cleanup;
- same deterministic operation set used locally where service semantics match.

Azure Blob:

- short-lived identity/SAS credentials;
- disposable container/prefix;
- explicit cleanup;
- service-version coverage relevant to the changed code.

Cloud credentials must never become required for ordinary portable tests.

## Failure injection

Network fault injection is still future work. Toxiproxy or another socket-level test service can add latency, reset,
timeout, retry, cancellation, and multipart/block cleanup scenarios around the real provider clients.

It should remain test-fixture infrastructure. The public OPFS/client/driver architecture must not depend on a
fault-injection service.
