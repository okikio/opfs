# Supabase independent SDK runner

The provider test compares project behavior with storage-js 2.12.2 against the pinned Supabase Storage API and pgvector
PostgreSQL containers. Run `deno task test:supabase-provider` from the repository root with Docker and the reviewed
acquisition network available. Testcontainers owns isolated resources; `tests/provider/supabase.ts` stages the
maintained TypeScript files and controls startup/cleanup. No candidate module enters the SDK runner.

`download.ts` admits the exact storage-js tarball using its original SHA-512 before native tar extraction. `sdk.ts` uses
that independent SDK with caller-supplied native Fetch and a fixed private-network route. Setup retains private/public
buckets, allowed/hidden files and the explicit JWT/RLS profiles. No GoTrue login or hosted gateway authentication is
implied.

The SDK runner now uses reviewed Node26.13 bookworm-slim index
`sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68`; the server/database pins remain unchanged.
The previous runner index is preserved in the provider snapshot.

The original provider, including its embedded JavaScript, is preserved byte-for-byte as inert `provider.ts.snapshot`;
`source-map.json` records its original size/hash. These historical bytes and existing receipts are not rewritten or
relabeled as a new TypeScript/native run. Current runner source requires separate strict checks and real provider
qualification.
