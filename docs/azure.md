# Azure Blob client protocol guide

## Purpose

This document defines the Azure Blob Storage REST contract implemented by `@okikio/opfs/azure`. It is intended for
maintainers changing authentication, service-version behavior, block upload, copy, conditional replacement, listing, or
Azurite interoperability.

The client uses the Blob REST API directly rather than wrapping the Azure SDK. That keeps the dependency graph small,
but it also means this repository owns the protocol work it chooses to implement. The source and tests must therefore
make the exact REST contract explicit.

```text
AzureClientType
      |
      +--> direct protocol use
      |
      `--> Azure object driver -> object adapter -> FileSystemType

Blob REST request construction
        |
        +--> SAS query authorization
        +--> Microsoft Entra bearer authorization
        +--> Shared Key signing
        `--> caller-defined headers
        |
        v
Web Fetch
        |
        +--> Azure Blob Storage
        `--> Azurite
```

Web Crypto owns HMAC-SHA256 for Shared Key. `@std/encoding` owns Base64, `@std/async/pool` owns bounded block
concurrency, and `@std/xml` owns list and block-list documents.

This guide uses these evidence classes:

- **Implemented** means current source contains the behavior.
- **Protocol** means current Microsoft REST documentation defines the behavior.
- **Emulator** means Azurite reproduces enough of the contract for local integration tests but is not treated as
  complete Azure parity.

The current implementation was reviewed against Microsoft Learn and current Azurite documentation on August 14, 2026.

## The client targets one container

`createAzureClient()` binds one endpoint and one container. Blob keys supplied to `head()`, `get()`, `put()`,
`delete()`, `copy()`, and `list()` are relative to that container.

A normal cloud endpoint looks like:

```text
https://account.blob.core.windows.net
```

The client constructs:

```text
https://account.blob.core.windows.net/container/path/to/blob
```

Azurite uses an account name in the endpoint path:

```text
http://127.0.0.1:10000/devstoreaccount1
```

which becomes:

```text
http://127.0.0.1:10000/devstoreaccount1/container/path/to/blob
```

This difference matters to Shared Key canonicalization. Microsoft documents that the emulator account segment appears
once in the URL path and is prefixed again by the signing account name. The implementation derives that duplicated
canonical-resource form from the URL rather than hard-coding an Azurite branch.

`AZURE_STORAGE_VERSION` defaults to `2026-04-06`. A caller can select another service version when it needs the size or
authentication behavior of an older REST contract.

The driver remains a separate public layer:

```ts
import { createAzureClient } from "@okikio/opfs/azure";
import { createAzureDriverFromClient } from "@okikio/opfs/driver/azure";
import { createObjectAdapter } from "@okikio/opfs/adapter/object";

const client = createAzureClient(options);
const driver = createAzureDriverFromClient(client);
const adapter = createObjectAdapter(driver);
```

The driver adds provider requirements, limits, generic optimization metadata, deterministic planning, and physical
request metrics. The adapter translates Blob keys/prefixes into the filesystem primitive contract.

## Optimizations are independently controllable

`blockUpload` : Defaults to true. Large/streamed complete replacements can stage blocks with bounded concurrency and
commit a block list. When disabled, the client does not advertise native stream-write/multipart behavior. Materialized
values above the single Put Blob ceiling fail rather than silently changing physical upload strategy.

`serverCopy` : Defaults to true when the selected authorization strategy can support the source and destination
semantics used by the client. When disabled, the client does not advertise provider-side copy and the object
adapter/facade can select an honest fallback.

Both switches are exposed by the client and through `driver.inspect().optimizations`. A future cache, prefetch,
block-selection, or copy optimization that changes observable behavior must be inspectable and independently
disableable.

## Authorization is explicit

`AzureCredentialType` supports four strategies:

| Kind         | Wire mechanism                         | Intended use                                    |
| ------------ | -------------------------------------- | ----------------------------------------------- |
| `sas`        | SAS fields remain in the request query | Browser/server delegated access                 |
| `bearer`     | `Authorization: Bearer ...`            | Microsoft Entra access token                    |
| `shared-key` | Canonical Shared Key HMAC-SHA256       | Trusted server and Azurite                      |
| `headers`    | Caller returns authorization headers   | Provider/host integration not otherwise modeled |

The client does not read environment variables. Credentials are supplied by the caller, and bearer tokens can be refresh
functions resolved immediately before the request.

Shared Key credentials contain an account name and Base64 account key. The account key is a root-level storage
credential. It should not be embedded in an untrusted browser bundle. Browser applications normally use a scoped SAS or
a Microsoft Entra flow with suitable permissions.

### Shared Key string to sign

The implementation follows the Blob service Shared Key format:

```text
HTTP verb
Content-Encoding
Content-Language
Content-Length
Content-MD5
Content-Type
Date
If-Modified-Since
If-Match
If-None-Match
If-Unmodified-Since
Range
CanonicalizedHeaders
CanonicalizedResource
```

The signer supports the augmented Blob Shared Key format from service version `2009-09-19` onward. Earlier versions are
rejected rather than being signed with modern rules that only look plausible.

Two canonicalization rules change with the selected service version:

- `2014-02-14` and earlier sign a zero byte `Content-Length` as the literal `0`. Later versions contribute an empty line
  for the same header.
- Versions before `2016-05-31` omit empty `x-ms-*` headers from `CanonicalizedHeaders`. Version `2016-05-31` and later
  retain them as `name:\n`.

Canonical `x-ms-*` headers that participate in the selected version are:

1. converted to lowercase names;
2. normalized by collapsing linear whitespace outside quoted strings while preserving whitespace inside quoted strings;
3. sorted by code-unit order;
4. emitted as `name:value\n`.

The quoted-string rule is significant for metadata and other extension headers. For example, `alpha   beta`
canonicalizes to `alpha beta`, while the two spaces inside `alpha "beta  gamma"` remain two spaces. Collapsing the
quoted value would sign different bytes from the value Azure receives.

The canonical resource starts with:

```text
/account-name/request-path
```

then appends lowercase query names in sorted order. Repeated values are sorted and joined with commas.

The signature is:

```text
Base64(HMAC-SHA256(base64DecodedAccountKey, UTF8(stringToSign)))
```

and the HTTP header is:

```text
Authorization: SharedKey account-name:signature
```

## Metadata is validated before provider I/O

Azure Blob metadata names and values have a stricter contract than generic object-store metadata. A metadata key must
start with an ASCII letter or underscore. Later characters can only be ASCII letters, digits, or underscores. Metadata
values must be ASCII. Names are case-insensitive at the service, so the client also rejects two caller keys that differ only
by case. The client validates these rules before it creates an upload or block-list request. This prevents a known-invalid
metadata object from reaching Azure after upload work has already started.

The object adapter uses `okikio_opfs_kind` for its private directory marker. The underscore form is intentional: the older
`okikio-opfs-kind` spelling contains hyphens and Azure rejects it as an invalid metadata key.

The deterministic unit suite signs Azurite requests with the documented `devstoreaccount1` key and a fixed timestamp. It
freezes exact signatures on both sides of the `2014-02-14` zero-length change, verifies the `2016-05-31` empty-header
change, and rejects Shared Key versions older than `2009-09-19`. This makes the tests independent from the
implementation clock and catches service-version canonicalization drift.

A low-level streamed body using Shared Key must provide `content-length` because the signer cannot know the stream
length without consuming it. High-level `put()` avoids this problem by splitting the stream into known-size block
requests.

## The service version controls write limits

Azure Blob limits changed across REST service versions. The client resolves the relevant limit from the selected version
instead of assuming the newest size everywhere.

`AZURE_LIMITS` records the values used by planning:

| Operation/era                           | Client limit |
| --------------------------------------- | ------------ |
| Maximum committed blocks                | 50,000       |
| Maximum uncommitted blocks              | 100,000      |
| `Copy Blob From URL` synchronous copy   | 256 MiB      |
| Old `Put Block`                         | 4 MiB        |
| 2016-05-31 through 2019-era `Put Block` | 100 MiB      |
| Current `Put Block`                     | 4,000 MiB    |
| Old `Put Blob`                          | 64 MiB       |
| 2016-05-31 through 2019-era `Put Blob`  | 256 MiB      |
| Current `Put Blob`                      | 5,000 MiB    |

The implementation selects:

```text
Put Block limit
  version >= 2019-12-12 -> 4,000 MiB
  version >= 2016-05-31 ->   100 MiB
  older                 ->     4 MiB

Put Blob limit
  version >= 2019-12-12 -> 5,000 MiB
  version >= 2016-05-31 ->   256 MiB
  older                 ->    64 MiB
```

`Put Block From URL` uses the version table published on the current REST page: 4,000 MiB from version `2020-04-08`
onward and 100 MiB before that point. Microsoft's same page currently contains a contradictory prose sentence that still
says the operation is limited to 100 MiB. The version table is also consistent with the service's modern block-blob
capacity model, so the client follows the table. This contradiction is recorded as an upstream documentation risk rather
than hidden. The Docker suite uses small ranges and therefore does not prove the 4,000 MiB ceiling; an opt-in real Azure
test must protect that limit before it is treated as independently verified.

`blockSize` defaults to 8 MiB. The constructor rejects a configured block size above the selected service-version limit.
A known body can require a larger block size to remain within 50,000 committed blocks; the planner chooses the larger
legal size and rejects an impossible request before starting the commit.

## High-level upload has two paths

A materialized `Uint8Array` at or below the selected `Put Blob` limit uses one `Put Blob` request with:

```text
x-ms-blob-type: BlockBlob
```

A larger materialized body or a stream uses uncommitted blocks:

```text
source bytes
    |
    v
fixed-size chunks
    |
    +--> Put Block A
    +--> Put Block B      bounded by `concurrency`
    +--> ...
    `--> Put Block N
    |
    v
Put Block List
    |
    v
Get Blob Properties
```

Block IDs are deterministic Base64 values derived from zero-padded sequential numbers. Every request in one upload
therefore has a stable order and the commit document can list exactly the intended blocks.

`Put Block` requests intentionally do not receive destination `If-Match` or `If-None-Match`. Uncommitted blocks are not
yet the authoritative destination blob. The precondition and final metadata belong on `Put Block List`, which is the
operation that commits the new block blob.

The XML block list is generated through `@std/xml/stringify`, so block IDs are serialized by a real XML implementation
rather than hand-escaped text.

When `ObjectPutOptionsType.size` is supplied, the final streamed byte count must match. A mismatch rejects the operation
before final commit.

Unlike S3 multipart uploads, Azure uncommitted blocks do not have a separate abort REST operation. Failed uploads can
leave uncommitted blocks until Azure cleans them up according to service policy. Documentation and tests therefore must
not describe stream cancellation as an atomic remote rollback.

## Range reads use the Blob range contract

`get()` maps package range fields to:

```text
x-ms-range: bytes=start-end
```

`at` is the zero-based first byte. `length` controls the inclusive final byte. When no length is supplied, the range
remains open-ended.

The client reports `rangeRead: true` because Azure Blob Storage can satisfy the range at the provider rather than
materializing the complete object in the library first.

## Server-side copy preserves the Azure model

Azure has more than one URL-based copy primitive. The client selects between them rather than presenting one fictitious
universal copy call.

For a source up to 256 MiB, `copy()` uses synchronous `Copy Blob From URL`. For a larger source, it performs ranged
`Put Block From URL` operations and then commits them with `Put Block List`.

```text
Get Blob Properties(source)
        |
        +-- <= 256 MiB --> Copy Blob From URL
        |
        `-- > 256 MiB --> Put Block From URL range 1
                            Put Block From URL range 2
                            ...
                                   |
                                   v
                              Put Block List
```

The large-copy block size is increased when required to remain at or below 50,000 committed blocks. It is also
constrained by the selected REST version's `Put Block From URL` range limit.

The copy feature is advertised only when the selected service version supports URL-copy operations and the configured
credential type lets the client derive a source authorization strategy.

For same-client copies:

- SAS includes its authorization on the generated source URL;
- Shared Key can authorize the destination and a same-account source;
- bearer credentials can use `x-ms-copy-source-authorization` from service version `2020-10-02` onward;
- custom header authorization is not assumed to work for the source, so the portable `copy` capability is disabled.

Cross-account copy has additional source-authorization requirements. A Shared Key for the destination account cannot
sign a different account's source. Use a source SAS or a suitable bearer/source authorization design rather than
assuming one account key grants cross-account access.

Source conditions map to the `x-ms-source-*` condition family where the selected operation supports them. Destination
`If-Match` / `If-None-Match` apply to the single synchronous copy or to the final block-list commit for multipart copy.

## Listing is container pagination, not a directory API

`list()` requests the container with `restype=container&comp=list` and maps:

| Package field | Azure query field |
| ------------- | ----------------- |
| `prefix`      | `prefix`          |
| `delimiter`   | `delimiter`       |
| `limit`       | `maxresults`      |
| `cursor`      | `marker`          |

`Blob` entries become `ObjectEntryType`. `BlobPrefix` entries become child prefixes. `NextMarker` is returned as the
next cursor.

The Azure object driver and filesystem adapter interpret directory markers and provider prefixes. The Azure client
itself retains object/blob terminology because Azure has no native filesystem directory in the Blob service contract
used here.

## Errors retain Azure request evidence

`AzureError` keeps:

```text
HTTP status
Azure error code when present
x-ms-request-id when present
original Response
```

Azure can return XML or provider-specific text. The error parser uses structured XML when available and retains the
response even when a field is missing.

The client has a configurable transport retry policy built on `@std/async/retry`. Client options control retry count,
exponential delay, jitter, and an optional per-attempt timeout. The policy retries 408, 429, 5xx, and transport failures
for replayable requests. Authorization is rebuilt on every attempt, which matters for refreshable bearer/custom
credentials and Shared Key dates. Redirects are manual so authorization is not silently carried to another authority.

A one-shot `ReadableStream` receives one attempt. The low-level `request()` API also accepts `retry: false` because
replayability does not prove that a provider-specific operation is safe to repeat. `request: { retries: 0 }` disables
automatic retry for the client. A request admitted for only one attempt bypasses the retry engine entirely. A zero-delay policy
remains valid even though the underlying standard helper requires a positive maximum timeout. Provider-specific `Retry-After`
interpretation is not yet modeled.

`getMetrics()` returns request, retry, terminal-failure, response, and optional Fetch-duration counters.
`metrics: "none"` is the baseline benchmark setting; `basic` counts; `timing` adds monotonic duration.

`AbortSignal` reaches every Fetch operation. Cancellation ends local admission and HTTP work where Fetch can abort it.
It does not guarantee that Azure failed to accept a request before the signal reached the network stack.

## Azurite is an integration target, not the specification

`tests/provider/fixture.ts` uses the official `@testcontainers/azurite` module with the pinned Azurite image and the
well-known development account. Testcontainers chooses a free mapped host port, so the concrete endpoint changes per run
while the account identity remains `devstoreaccount1`.

The test uses Shared Key, creates a disposable logical Azure container through the client's signed low-level request,
then exercises PUT, HEAD, range GET, conditional create, block upload, server-side copy, list, delete, the Azure driver,
and the object filesystem adapter.

Azurite is intentionally treated as an emulator. Its documentation states that it provides best-effort Azure Storage
compatibility and can differ from the cloud service. A green Azurite suite therefore proves real HTTP/authentication
interoperability, not complete conformance with every Azure version or feature.

The deterministic unit suite remains responsible for exact Shared Key string construction, version-dependent limits,
condition placement, and source bearer version gates.

Before release, an opt-in real Azure Blob test should run against a disposable container with short-lived CI credentials
when organizational secret policy permits it.

## Known non-goals

The current direct client does not claim full Azure Storage coverage. Important features outside this focused contract
include:

- hierarchical namespace/Data Lake Gen2 filesystem semantics;
- append blobs and page blobs;
- leases as a first-class high-level API;
- snapshots/version-ID aware filesystem paths;
- customer-provided encryption-key convenience APIs;
- immutability policies and legal holds;
- blob index tags;
- asynchronous `Copy Blob` polling workflows;
- batch operations;
- account/container administration beyond low-level requests;
- adaptive provider throttling beyond the configured exponential retry policy, including provider-specific `Retry-After`
  scheduling;
- Microsoft Entra token acquisition itself.

`request()` can reach an unmodeled REST operation when a caller supplies the correct method, query, headers, and body. A
feature should become a typed public operation only when its ownership, failure behavior, version gates, and tests are
explicit.

## Primary specification sources

Review these Microsoft sources before changing protocol behavior:

- Shared Key authorization: https://learn.microsoft.com/rest/api/storageservices/authorize-with-shared-key
- Versioning for Azure Storage services:
  https://learn.microsoft.com/rest/api/storageservices/versioning-for-the-azure-storage-services
- Put Blob: https://learn.microsoft.com/rest/api/storageservices/put-blob
- Put Block: https://learn.microsoft.com/rest/api/storageservices/put-block
- Put Block List: https://learn.microsoft.com/rest/api/storageservices/put-block-list
- Put Block From URL: https://learn.microsoft.com/rest/api/storageservices/put-block-from-url
- Copy Blob From URL: https://learn.microsoft.com/rest/api/storageservices/copy-blob-from-url
- List Blobs: https://learn.microsoft.com/rest/api/storageservices/list-blobs
- Azurite: https://learn.microsoft.com/azure/storage/common/storage-use-azurite

The REST documentation is authoritative for Azure. Azurite source and behavior are integration evidence for the emulator
only.
