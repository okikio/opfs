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
acknowledgements or AMQP 1.0. The historical provider run compared full 6-byte and 128-KiB originals through both Pika
and the candidate, including return/refusal behavior. The replacement native-client profile below separately passed its
provider case with rabbitmq-c: both original sizes in both directions, confirmation, return, empty/missing queues and
authentication refusal. Its native execution is separate from these frozen Pika captures.

## Current native client and TypeScript workflow

`tests/provider/amqp.ts` now builds a test-only image from the pinned official Node 26 bookworm base. Its Dockerfile
uses only inherited signed Debian package sources for `gcc`, `libc6-dev`, `librabbitmq-dev` and `util-linux`. It retains
downloaded `.deb` digests, installed package identities, APT sources and signed InRelease receipts in the image. No
Python, pip, Pika wheel or downloaded setup script runs. The new SDK is an explicit changed test profile; it does not
inherit the historical Pika execution claim.

The authored `native.c` shim calls the public
[rabbitmq-c 0.11 API](https://github.com/alanxz/rabbitmq-c/blob/v0.11.0/librabbitmq/amqp.h) for topology, confirmed
publication, destructive auto-ack dequeue and passive queue counts. The SDK owns wire framing and complete message
reads. It checks the advertised RabbitMQ version, preserves the same durable queue and limits, and reports successful
seed publication only after an actual Basic.Ack for sequence 1. A mandatory return, nack, close, unrelated frame or
timeout cannot become a successful confirmation. No candidate AMQP code supplies these native results. Debian's
[librabbitmq-dev package](https://packages.debian.org/bookworm/librabbitmq-dev) and the image's
`/usr/share/doc/librabbitmq4/copyright` identify the independent SDK and its MIT notice.

`client.ts` bounds native commands to 15 seconds with SIGKILL, 2 MiB diagnostics and a 4 MiB kernel per-file limit.
Native socket opening, handshake, RPCs and confirmation waits also use five-second limits. Full message bodies are
limited to 1 MiB. The provider's outer container command has a 20-second KILL deadline. The SDK image runs as UID/GID
65534 with all capabilities dropped and `no-new-privileges`; source, binary, package and immutable image identities are
emitted into the verification log. Existing 512/256-MiB memory=swap, half-CPU, PID-128, owned network, ephemeral port
and broker tmpfs limits remain. Testcontainers owns start, readiness and cleanup.

From the repository root, run the existing provider task in the isolated qualification runner:

```sh
deno task test:amqp-provider
```

The test still compares both complete original sizes in both directions and checks empty queues, mandatory return 312
plus acknowledgement, a missing queue and a refused password. Build acquisition needs network access; operations use the
owned broker network. This plaintext fixture makes no TLS, persistence, clustering, manual-ack or AMQP 1.0 claim. Keep
this run separate from compilers and benchmarks.

To retain a new literal frame capture, set `OPFS_AMQP_CAPTURE_OUTPUT` to a new destination and invoke `create.ts` with
the repository-pinned Node. Keep a 300-second outer deadline and a 256-MiB Node heap allowance. Retain the new capture,
all source/package/image identities, complete byte comparisons and final exit/OOM state separately from the old JSON.
`create.ts` uses exclusive output creation and no longer accepts a Python wheel setting. The shared library receives no
new production dependency. The TypeScript/native-C replacement is source-complete and awaits actual execution.

## Historical Pika reproduction

The following recipe describes the executed historical profile. Exact old provider and capture source remain in
`pika-provider.ts.snapshot` and `pika-create.ts.snapshot`; they are inert audit material, not current commands.

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
