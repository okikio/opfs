# Pubsub independent SDK runner

The provider test compares project behavior with @google-cloud/pubsub 6.3.2 against the pinned Google Cloud SDK 592.0.0
Pub/Sub emulator. Run `deno task test:pubsub-provider` from the repository root with Docker and the reviewed acquisition
network available. Testcontainers owns isolated resources; `tests/provider/pubsub.ts` stages the maintained TypeScript
files and controls startup/cleanup. No candidate module enters the SDK runner.

`oracle.ts` uses the official v1 publisher/subscriber gRPC clients, fixed emulator endpoint and insecure private-network
credentials. It retains native topic/subscription creation, publish and one-message pull, 10-second RPC limits, no RPC
retries and explicit retirement of both clients even when an operation fails. Protobuf byte strings are interpreted as
base64 if the SDK supplies strings; native byte arrays are preserved directly.

The pinned Node22.22 bookworm-slim oracle image already supports native TypeScript. The emulator/image pins and exact
SDK lock digest are unchanged; acquisition remains separate from offline/private-network behavior.

The original provider, including its embedded JavaScript, is preserved byte-for-byte as inert `provider.ts.snapshot`;
`source-map.json` records its original size/hash. These historical bytes and existing receipts are not rewritten or
relabeled as a new TypeScript/native run. Current runner source requires separate strict checks and real provider
qualification.
