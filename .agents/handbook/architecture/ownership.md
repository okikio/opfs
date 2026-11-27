# Choose ownership and placement separately

Artifact ownership describes what the project maintains. Placement describes where that artifact executes. A repository can use different ownership strategies for its web application, worker, operator tool and database migration.

| Artifact strategy | Maintained work | Evidence before adoption |
| --- | --- | --- |
| Upstream executable or image | Configuration, supported extensions, integration and deployment adaptation. | Exact version or digest, platform, entrypoint, required features, writable paths, startup and shutdown. |
| Published package | A consumer or adapter, dependency lock, packaging and integration. | Public exports, available release, supported runtime, installed bytes and a real consumer. |
| Owned source or maintained fork | Product behavior, patch set, tests and upstream integration. | Source identity or import record, license, extension points, migration impact and upgrade path. |

Choose placement from the actual host contract: a local process, browser, managed service, virtual machine or container platform may each fit. Assess identity, network access, storage, resource limits and operational ownership independently. The fact that an image contains a particular runtime does not prove that its private source is a supported package API.

Shared platform resources have their own owner. Borrow the documented outputs of a network, registry or database platform instead of letting each application create or delete them. Application instances own their scoped data, routes and credentials. Deployment operations own candidate admission, mutation ordering, acceptance and recovery.

Distinguish an application workspace from enforced tenant isolation. Verify authorization, data filters, object paths and credentials. A namespace or prefix organizes data only within the access controls that enforce it. When requirements need independent instances, record that choice and its maintenance cost.

Execution isolation is another contract. A process or container launcher does not by itself supply job claims, cancellation, stale-result rejection, artifact custody or cleanup. Trace the complete protocol before describing a runner as a sandbox or durable worker.
