# Check the service contract the journey needs

A service is ready for a named operation, consumer, environment and execution identity. Select the cards that apply to the agreed journey. They describe evidence to collect, not a platform to install.

Skills: `build-apis`, `build-auth`, `build-data`, `build-workflows`, `use-utils`.

| Dependency | Card |
| --- | --- |
| Packages, tooling and generated dependencies | [Packages and artifacts](packages.md) |
| Databases and retained state | [Data and recovery](data.md) |
| Application endpoints and background roles | [HTTP and runtime health](http.md) |
| Network routes and workload identity | [Connectivity](network.md) |
| Invitations, notifications and other messages | [Email](email.md) |
| Uploads, downloads and retained object versions | [Object storage](objects.md) |
| Model calls and agent execution | [Models and runners](models.md) |
| Sign-in, cross-repository activation, content and presentation | [Connected user actions](connected.md) |

Bind each operation to current source, supported client behavior and provider documentation. Apply [service verification](../procedures/service-contracts.md) and record its scope in the [service record](../project/services.md). A credential's presence or a dashboard screenshot is insufficient evidence of the required consumer operation.

Separate one-time setup, cheap deployment checks and capability revalidation. Refresh a result when its relevant identity, client, configuration, topology or provider contract changes. Preserve already valid evidence when those inputs remain unchanged.
