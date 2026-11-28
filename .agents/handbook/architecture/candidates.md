# Keep candidate and deployment identities traceable

A candidate is the exact result being reviewed. It may be a package archive, executable, image, static site or source change. Record the source, dependency locks, effective build configuration and resulting artifact identity.

Keep these identities separate:

| Identity | Why it matters |
| --- | --- |
| Source revision and local changes | Establishes what was authored and reviewed. |
| Build inputs and toolchain | Establishes how the artifact was produced. |
| Artifact digest or immutable version | Identifies the bytes being installed or executed. |
| Environment configuration | Determines behavior that is selected at runtime. |
| Proposed infrastructure or migration plan | Binds an operation to a target and observed state. |
| Deployed instance | Establishes what the intended consumer actually uses. |

Reuse an artifact only while its effective build inputs are unchanged and the repository's provenance contract permits reuse. A frontend that embeds its public origin may need different bytes for another environment. Rebuild and retest changed bytes instead of describing them as an unchanged promotion.

Verify publication separately from source availability. A source tag does not prove that a package is downloadable or that an image can be pulled on the intended platform. Check the consumer identity and installed artifact before making a delivery claim.

For deployment, use [preview](../procedures/preview.md) and [promotion](../procedures/promotion.md). Preserve the prior artifact and configuration identities needed for the actual recovery contract. Application rollback and database recovery can require different actions.
