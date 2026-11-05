# Native AMQP replies

`independent.json` contains untouched RabbitMQ 4.4.0 frames from two fresh connections: a destructive auto-ack dequeue
and a mandatory confirmed publication. An independent literal producer sent the recorded commands. It has no runtime
import of the candidate AMQP implementation. Pika 1.4.4 seeded the six original bytes before the dequeue and
independently read the complete published original afterward. Full queue counts were zero after each action. The capture
is not a candidate round trip or a server performance measurement.

`provenance.json` records immutable source/image/artifact identities, actual runtime versions, resource ceilings,
successful receipts and retained failed attempt identities. The raw JSON is 10069 bytes with SHA-256
`aaafa0c0df2e25505b4f49d907adbe44a317092335a400ea1abbd2043d33a59a`. Do not format or rewrite it. The captured
credentials are public disposable fixture literals, not real account credentials.

`replay.ts` verifies hashes before a test or benchmark and releases the native frames only after each exact captured
producer command. The one-byte transport mode tests fragmentation without changing frame contents. The native replay
suite covers both operations in both transport modes. It does not establish TLS, persistent delivery, clustering, manual
acknowledgements or AMQP 1.0. The separate provider suite compares full 6-byte and 128-KiB originals through both Pika
and the candidate, including return/refusal behavior.

## Reproduce a new capture

Use the repository-pinned Node and Testcontainers versions. The test-only fixture in `tests/provider/amqp.ts` admits the
exact Pika wheel hash and literal raw dependency declarations before offline installation. Acquire and inspect that
wheel and the two immutable multiarchitecture image references from the provenance record before native execution. SDK
code is not a production dependency. The image architecture must match an explicit arm64 or x64 host.

`create.ts` requires two caller-selected environment values: `OPFS_AMQP_ORACLE_WHEEL` names the admitted wheel, and
`OPFS_AMQP_CAPTURE_OUTPUT` names a new output path. Output creation is exclusive so it cannot replace the original
fixture. Run it from the repository root under a 300-second outer deadline and a 256-MiB Node heap allowance. The heap
allowance is not a total process-memory cap. Do not overlap this native run with compilers, runtime suites or
benchmarks.

Testcontainers owns readiness, ephemeral ports, fixtures and cleanup. RabbitMQ has a 512-MiB memory-and-swap ceiling,
the independent Python oracle has 256 MiB, and each has half a CPU and 128 PIDs. All broker data is a 64-MiB tmpfs. No
host paths or Docker socket are mounted into either container. Readiness uses the image entrypoint's privilege drop to
avoid creating a root-owned Erlang cookie. The durable test queue avoids RabbitMQ's deprecated nonexclusive
transient-queue feature; owned tmpfs still makes it disposable. It does not request persistent messages or prove
persistence.

Retain stdout, stderr, all failures, the input hashes and complete container state before removal. The parent
verification run disabled Ryuk explicitly and owned emergency cleanup of only positively attributed task resources. A
standalone reproduction must also account for its Testcontainers reaper and cleanup policy rather than silently pulling
an unreviewed auxiliary image.

The `licenses/` directory preserves the reviewed Pika BSD notice, specification repository notice and RabbitMQ notices
separately. The specification XML also has AMQP specification and BSD modification notices; repository MPL is not a
blanket license for those materials. No server or SDK implementation is copied into production. The full images retain
their own component notices.
