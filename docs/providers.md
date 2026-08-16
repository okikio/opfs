Object-provider integration tests
=================================

Purpose
-------

The direct S3 and Azure clients own HTTP protocol behavior that a pure mock cannot prove. This guide explains the local provider
fixtures used to test real signing, request routing, ranges, multipart/block state, copy, listing, and filesystem translation
without requiring cloud credentials for every maintainer run.

Provider containers supplement deterministic protocol tests. They do not replace the Amazon S3 or Azure Blob specifications.
They also do not become a production dependency or a storage abstraction. Testcontainers exists only in development tooling.

Testcontainers owns provider lifecycle
--------------------------------------

`tests/provider/fixture.ts` uses Testcontainers for Node.js instead of a repository-owned Docker Compose and polling harness:

```text
node:test
   |
   v
ProviderFixture
   |
   +--> Testcontainers GenericContainer
   |       |
   |       `--> SeaweedFS 4.41
   |              S3-compatible API
   |
   `--> @testcontainers/azurite
           |
           `--> Azurite 3.36.0
                  Azure Blob API
```

The images remain pinned:

```text
chrislusf/seaweedfs:4.41
mcr.microsoft.com/azure-storage/azurite:3.36.0
```

Testcontainers chooses free host ports and waits for the exposed service instead of requiring fixed `8333` and `10000` host
ports. The S3 fixture combines listening-port and HTTP readiness. The official Azurite module owns its emulator-specific startup
contract, uses in-memory persistence, skips only Azurite's API-version allow-list check, and exposes the mapped Blob endpoint.

SeaweedFS still uses `GenericContainer` because the Testcontainers Node catalog does not provide a SeaweedFS module. The code
uses the official Azurite module because Testcontainers recommends a focused module when one exists instead of duplicating that
container's configuration in every project.

`ProviderFixture` owns every container it starts. `close()` is idempotent and attempts to stop every owned container even if one
cleanup operation fails. Partial construction also stops SeaweedFS if Azurite cannot start. This keeps acquisition and cleanup in
one place instead of spreading lifecycle work across shell traps, readiness polling, and the test body.

Testcontainers is an interim compute layer
------------------------------------------

The project deliberately does not treat Testcontainers as the final runtime/provider abstraction. Testcontainers Node currently
centers Docker-compatible container runtimes. Its documentation covers Docker directly and documents setup/limitations for
Podman, Colima, and Rancher Desktop.

That is sufficient for the current local service fixtures. It is not the model for future Apple `container`, WSL containers,
microVMs, cloud VMs, Kubernetes, or other compute providers. A future environment/provider layer can replace how fixtures are
started while preserving this test contract:

```text
provider fixture
     |
     +--> endpoint
     +--> credentials
     +--> lifecycle ownership
     `--> diagnostics

protocol/client tests consume only those facts
```

The provider test therefore does not inspect Docker container IDs or Docker networks after startup. Those are fixture mechanics,
not S3/Azure test semantics.

Run the provider suite
----------------------

The canonical command is:

```sh
mise run test-providers
```

The task is intentionally small:

```text
mise
  |
  +--> deno ci
  |
  `--> node --test tests/provider.test.ts
                 |
                 `--> Testcontainers owns startup/readiness/cleanup
```

`node:test` remains the repository test runner. Testcontainers supplies resources to the test; it does not become a second test
framework.

GitHub Actions calls the same mise task. The workflow installs mise, asks mise for the Deno and Node versions required by the
provider job, and then runs `mise run test-providers`. GitHub Actions owns only job topology, permissions, runner selection,
timeouts, and secrets. It does not duplicate provider startup commands.

Playwright owns browser lifecycle separately
--------------------------------------------

Testcontainers and Playwright solve different lifecycle problems:

```text
node:test + Testcontainers
    S3/Azure service interoperability

Playwright Test
    Chromium/Firefox/WebKit runtime interoperability
    Window/Worker/ServiceWorker/iframe/storage lifecycle
```

The browser matrix stays under `tests/browser/`. Playwright owns browser installation, isolated `BrowserContext` instances,
persistent profiles, traces, retries, and Vite fixture-server lifecycle. Provider tests do not launch browsers, and browser tests
do not launch provider containers merely to share a framework.

Provider benchmarks keep startup outside timed work
----------------------------------------------------

The same Testcontainers fixture owns provider startup for:

```sh
mise run bench-providers
```

`bench/providers.ts` starts SeaweedFS and Azurite once, obtains their random host endpoints, and passes those endpoints to the
actual benchmark programs. Container startup, image pull, and readiness time therefore do not enter a Mitata sample.

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

Small replacement and multipart/block cases remain separate. Different request plans must not be reported as facade overhead.
Loopback results are diagnostics about client/abstraction cost, not cloud-throughput claims.

What the live tests prove
-------------------------

The S3 path validates:

- a real SigV4 HTTP request accepted by an independent S3-compatible server;
- PUT and HEAD;
- byte-range GET;
- create-only conditional replacement;
- multipart stream upload with a legal non-final part size;
- provider-side copy;
- prefix listing;
- delete cleanup;
- `ObjectStoreType -> AdapterType -> FileSystemType` translation.

The Azure path validates:

- Shared Key accepted by Azurite;
- explicit container creation;
- Put Blob and Get Blob Properties;
- byte-range GET;
- create-only conditional replacement;
- Put Block / Put Block List streaming upload;
- same-account server-side copy;
- prefix listing;
- delete cleanup;
- `ObjectStoreType -> AdapterType -> FileSystemType` translation.

The provider receives the actual headers, query fields, bytes, XML, and signatures created by the library.

What the live tests do not prove
--------------------------------

A compatible server or emulator cannot prove every detail of a cloud service. The suite does not use it as the oracle for:

- exact AWS canonical-request text;
- AWS-only HTTP-200 embedded error bodies;
- every S3 service limit;
- Azure Shared Key construction independently of Azurite;
- every historical Azure service-version size limit;
- cloud role/identity acquisition;
- region routing and redirects;
- provider throttling;
- cloud durability or consistency guarantees;
- billing, retention, encryption, replication, or versioning.

Those cases belong to deterministic protocol tests where possible and opt-in real-cloud suites when a local provider cannot
represent the behavior faithfully.

Why the matrix keeps both test styles
-------------------------------------

| Test style | Strong at | Weak at |
| ---------- | --------- | ------- |
| Deterministic request test | Exact canonical text, headers, limits, branch selection | Real HTTP parser/auth integration |
| Testcontainers provider | Real socket/HTTP/auth/protocol interoperability | Complete cloud parity |
| Optional real cloud | Actual provider behavior | Cost, credentials, availability, reproducibility |

A client change that affects signing, multipart/block state, copy, conditions, retries, cancellation, or provider errors should
update the deterministic test and the provider integration when the local implementation can represent that behavior.

Future provider breadth
-----------------------

The current fixture is deliberately small. Additional S3-compatible services should be added only when they exercise a materially
different contract, not to increase a provider count. Useful differences include addressing, copy/condition support, multipart
errors, non-AWS region behavior, and pagination.

Network-fault fixtures are also a useful next layer. Testcontainers provides a Toxiproxy module, which can be used to prove
retry, timeout, cancellation, and cleanup behavior against a real socket path without adding unreliable sleeps to the tests.
That belongs in a focused failure suite rather than the normal happy-path provider test.
