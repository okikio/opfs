# Firebase independent SDK runner

The provider test compares project behavior with Firebase 13.2.0 against Firebase CLI 15.35.0 and storage-rules runtime
1.1.3. Run `deno task test:firebase-provider` from the repository root with Docker and the reviewed acquisition network
available. Testcontainers owns isolated resources; `tests/provider/firebase.ts` stages the maintained TypeScript files
and controls startup/cleanup. No candidate module enters the SDK runner.

`download.ts` verifies the original SDK, CLI and rules-runtime artifact digests before package execution. It applies a
60-second Fetch deadline and 128 MiB artifact admission bound. `sdk.ts` uses the official SDK to upload/read bytes,
inspect metadata and list names on the loopback emulator; it always awaits application deletion. Unsigned emulator
tokens and the authored rules are test-only.

The Node source stage now uses reviewed glibc Node26.13 bookworm-slim index
`sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68`; the original Temurin JRE pin remains
unchanged. The actual combined image must qualify libc/JRE/Node compatibility. The CLI/SDK transitive npm dependencies
still resolve during the test image build with install scripts disabled; the top-level artifact digests do not pretend
to pin that entire transitive graph.

The original provider, including its embedded JavaScript, is preserved byte-for-byte as inert `provider.ts.snapshot`;
`source-map.json` records its original size/hash. These historical bytes and existing receipts are not rewritten or
relabeled as a new TypeScript/native run. Current runner source requires separate strict checks and real provider
qualification.
