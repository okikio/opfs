---
"@okikio/opfs": minor
---

### Bind exact byte reads to one object revision

The optional `source` subpath opens immutable byte snapshots or remote objects pinned to a strong ETag or native
generation. Shared byte/request budgets reject excessive work before another read. S3 and Azure refuse incompatible
revision kinds and invalid range responses rather than returning bytes from an unintended extent.

`adapter/read` exposes an explicitly read-only namespace and rejects writes before source consumption. Independent
extensions can use `testing/source` to check exact reads, invalid extents, cancellation and fixture cleanup without
loading a test runner or service on import. See the source and extension guides for ownership and capability limits.
