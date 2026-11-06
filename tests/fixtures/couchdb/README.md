# Couchdb independent SDK runner

The provider test compares project behavior with Nano 11.0.8 against CouchDB 3.5.3. Run
`deno task test:couchdb-provider` from the repository root with Docker and the reviewed acquisition network available.
Testcontainers owns isolated resources; `tests/provider/couchdb.ts` stages the maintained TypeScript files and controls
startup/cleanup. No candidate module enters the SDK runner.

`oracle.ts` uses Nano through its published CommonJS factory, with a narrow checked TypeScript boundary. It retains
genuine attachment creation/read behavior, literal document IDs and the SDK-specific encoded attachment-name argument.
The 30-second timer and outer 45-second command deadline remain separate from the 1 MiB fixture byte policy. SDK calls
remain independent of candidate parsing.

The pinned Node22.22 bookworm-slim oracle image already supports native TypeScript; the Node and CouchDB image pins are
unchanged. `npm ci` still verifies the exact no-dependency Nano lock with scripts disabled.

The original provider, including its embedded JavaScript, is preserved byte-for-byte as inert `provider.ts.snapshot`;
`source-map.json` records its original size/hash. These historical bytes and existing receipts are not rewritten or
relabeled as a new TypeScript/native run. Current runner source requires separate strict checks and real provider
qualification.
