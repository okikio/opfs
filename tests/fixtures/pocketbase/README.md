# Pocketbase independent SDK runner

The provider test compares project behavior with PocketBase 0.28.1 against PocketBase 0.40.6. Run
`deno task test:pocketbase-provider` from the repository root with Docker and the reviewed acquisition network
available. Testcontainers owns isolated resources; `tests/provider/pocketbase.ts` stages the maintained TypeScript files
and controls startup/cleanup. No candidate module enters the SDK runner.

`download.ts` admits the architecture-specific executable ZIP and official SDK tarball by the original SHA-256/SHA-512
values before native extraction. `sdk.ts` authenticates, creates the three collection profiles, uploads the
independently authored file, and reads through official SDK file URLs. Integers and protected-file/view/update rules
retain their original profile.

The current oracle/server build uses reviewed Node26.13 bookworm-slim index
`sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68`. The prior Alpine index is preserved in the
provider snapshot. The new base needs `unzip`, acquired only from inherited signed Debian repositories; downloaded
package hashes, versions and signed repository metadata stay in `/fixture/receipts/`.

The original provider, including its embedded JavaScript, is preserved byte-for-byte as inert `provider.ts.snapshot`;
`source-map.json` records its original size/hash. These historical bytes and existing receipts are not rewritten or
relabeled as a new TypeScript/native run. Current runner source requires separate strict checks and real provider
qualification. The only remaining `.mjs` reference in the PocketBase runner names the upstream SDK’s published artifact;
it is not project-owned tooling.
