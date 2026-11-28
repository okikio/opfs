# Give each file and task a clear owner

Place maintained code where its behavior belongs. Preserve the repository's current layout and native manifests. Create a new file when it has a real consumer and a cohesive responsibility, not to reproduce a sample directory tree.

Use the [structure guide](../../guides/naming-and-folder-structure-guide.md)
to review dash-separated names, split large modules by responsibility and
integrate maintained tool packages into native workspace discovery. Trace the
consumer graph before a move; keep framework discovery and public contracts
explicit. Directory shape and manifests alone do not prove the integration.

| Responsibility | Appropriate owner |
| --- | --- |
| Product purpose and first useful action | Project entry documentation. |
| Runtime dependencies and supported execution | The runtime's native manifest and lockfile. |
| Public operations and data shapes | The package, API or schema that implements them. |
| Configuration and defaults | One validated source at the owning composition point. |
| Application behavior | Product source and durable behavior tests. |
| Repeated operational logic | Existing tooling or the capability owner. |
| Environment resources | The project's selected deployment configuration. |
| Source and upgrade relationships | Git ancestry or an explicit source-import record. |
| Temporary investigation | A project-approved ignored location outside shipped artifacts. |

Use one public task interface for recurring operations. CI should select the event, candidate and target, then invoke those operations. Thin wrappers can forward arguments and replace themselves with the real command. Substantial logic belongs with a tested owner rather than being repeated across shell, CI and application code.

Bind every procedure to a verified [command record](../project/commands.md). Use native discovery and stable selection patterns for tests and packages where supported. Check new, renamed and deleted files; do not create a list that silently omits the next test.

Separate cache reuse, live access checks and immutable artifacts. A dependency cache hit does not prove service readiness. A package consumer must check installed files, and an image consumer must check the final image. Keep temporary evidence, secrets and development-only files out of package contents.

Use concise domain names and useful comments for ownership, units, defaults and lifecycle. Formatting and generated-file changes should remain distinguishable from behavior changes in the review.
