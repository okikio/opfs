# Independent Kafka originals and typed fixture tools

This directory preserves an independently executed Java/literal-wire investigation and ports its small capture and
semantic verifier to TypeScript. It does not implement a public Kafka client, storage driver or filesystem adapter. The
[reviewed next sequence](../../../planning/storage/KAFKA.md) defines the proposed client and remaining gates.

The original bounded native run used Apache Kafka 4.4.0, the official Java producer/consumer, an authored literal
framing probe, and JDK builtin CRC32C. Java appended records at offsets 0/1/2, the literal probe read them and appended
its own records at 3/4/5, and Java read those originals back. Samples distinguish null/empty binary key/value, include
128 KiB of arbitrary bytes, duplicate ordered headers, and exact millisecond timestamps.

The retained `native-second/fixture-terminal.json.snapshot` records successful native execution and fixture retirement.
The original `terminal.json.snapshot` remains **failed**: a later semantic check expected `CreateTime` instead of the
actual Java `Enum.name()` value `CREATE_TIME`. `recovery.json.snapshot` separately qualifies the unchanged bytes with
the narrow corrected expectation. Its SHA-256 is `5f0af31519558311b4448ae20b169967d7f0b0ffb8e0e4e1d82d90d74cf0b4f2`.
Never rewrite the failed terminal as successful or attribute that Java execution to the new TypeScript tools.

`source-map.json` records original source paths, exact snapshot identities and every retained native output hash.
Previous Python sources are inert `history/*.py.snapshot`, never imported or executed. Historical `KafkaOracle.java` and
`CrcOracle.java` remain unchanged under `oracle/`; the new source-only Admin oracle has separate ownership described
below. Primary request/response schemas, upstream notices and attribution investigation remain inert snapshots. The
distribution's incorrect protobuf/JLine notice is retained alongside the separate upstream protobuf/OTel supplement.
That supplement supports the reviewed isolated test use; it does not establish a reproduced build or repair upstream
public redistribution rights. No SDK JAR is copied into this repository or its public package.

## What each current tool owns

`manifest.ts` writes the Java oracle's typed binary input contract and decodes its complete terminal envelope. Its
originals are restated independently from the literal probe's record builder. It retains known acknowledgments even when
later native cleanup failed. `records.ts` supplies the literal batch and slow Castagnoli reference. `wire.ts` bounds
every field before reading it; int64 offsets/timestamps stay bigint.

`probe.ts` creates a **fresh** output directory and connects only to an explicitly supplied disposable loopback port. It
sends the same classic ApiVersions0/Metadata4/Produce3/Fetch4/ListOffsets1 profile and saves raw request/response bytes
with correlations and hashes. A response is bounded to 4 MiB before allocation; chunks are read in at most 64 KiB
pieces. One 45-second capture deadline and five-second inactivity bound cover its fresh per-exchange connections.
Partial response bytes and a framing receipt survive failure. Socket retirement is awaited independently. Produce
attempts always remain subject to semantic/oracle review; framing cannot decide whether a mutation succeeded.

After separate source/artifact/broker/lifecycle qualification, the literal commands are:

```sh
node tests/fixtures/kafka/probe.ts read --port ACTUAL_OWNED_LOOPBACK_PORT \
  --topic opfs-native-proof --partition 0 --offset 0 --output FRESH_READ_DIRECTORY
node tests/fixtures/kafka/probe.ts append --port ACTUAL_OWNED_LOOPBACK_PORT \
  --topic opfs-native-proof --partition 0 --offset 3 --output FRESH_APPEND_DIRECTORY
```

These are templates for the existing independently reviewed native sequence, not a broker launcher. The broker, original
Java programs and serial ordering must already be owned by that sequence. No provider, compiler or image workload is
authorized by a source-only port.

The verifier reads only original regular files. To qualify the port against retained evidence, root can run:

```sh
node tests/fixtures/kafka/verify.ts tests/fixtures/kafka/native-second opfs-native-proof
```

It compares every original key/value/header byte, exact offsets/timestamps, all original batch CRC32C scopes, native
acknowledgments, earliest/latest offsets and JDK CRC32C agreement. It never imports production OPFS code or runs Java.
The TypeScript verifier replay passed in isolated receipt `ed586560-2fc0-4994-8fdb-99c4782f03e1`, with
`semanticFullBytes: true`, `crc32c: true` and `metadataSemanticClaim: false`. This is a new TS verifier execution over
retained native evidence, not a fresh broker/provider qualification or execution of every current capture tool.

**The original retained run does not qualify Metadata4 semantics.** It checks that metadata frames have the right
correlation, not that their brokers/leaders/replicas/ISR/cluster fields were semantically decoded. Its verifier
explicitly reports `metadataSemanticClaim: false`. Closing that gap precedes trusting production leader preflight.
Whole-wire page overflow and unknown append/cleanup controls also remain future candidate tests, not proof supplied by
Java poll limits.

A fresh native repeat must retain the reviewed one-broker 1 GiB RAM/swap, one CPU and 128 PID envelope, broker heap 256
MiB, and at most one serial 128 MiB auxiliary JVM. Preserve the 32 MiB data tmpfs, bounded secondary tmpfs/logs, exact
admitted broker image and five-JAR client classpath from `history/kafka-native-recipe.md.snapshot`. The Testcontainers
owner must preserve readiness, terminal diagnostics, partial outcomes and exact cleanup. The old recipe's Python launch
commands are historical source identity only; a maintained native launcher must be typed and qualified before a new run.

## Repeat the independent Metadata4 comparison

`metadata.ts` is a candidate-independent pure Metadata4 response decoder. The new authored
`oracle/AdminMetadataOracle.java` uses the admitted public Java Admin API to observe the configured topic and partition.
They do not change historical Java sources, snapshots, source maps or receipts. The
[Metadata qualification sequence](../../../planning/storage/KAFKA.md#independent-metadata4-qualification-to-run-next)
defines fresh native capture, comparison, adversarial controls, the binary Admin output and its limits.

The fresh 6 November 2026 run in `native-metadata/` compared the complete decoded cluster ID, broker tuples, selected
topic/internal flag, partition leader, replica assignment order and ISR membership with the public Admin observation.
`terminal.json` records success, full captured-byte hashes, the exact five-JAR closure and no operation or cleanup
failures. `resources.json` retains the actual container admission and kernel tmpfs observations. `source.json`
identifies the source used for this run and its separately compiled Java receipt. The native broker was Apache Kafka
4.4.0 on the pinned image; the auxiliary Admin program was compiled for Java 17 and executed by that image's JDK 25.

To repeat it, first acquire the admitted five JARs and compile `oracle/AdminMetadataOracle.java` in the documented
bounded offline compiler. Supply those resulting directories explicitly; this command neither resolves dependencies nor
compiles Java. It starts one owned broker, creates one fresh topic and removes its owned resources before returning:

```sh
node tests/fixtures/kafka/qualify.ts --classes /ABS/OFFLINE_CLASSES \
  --jars /ABS/ADMITTED_FIVE_JARS --evidence /ABS/FRESH_EVIDENCE_DIRECTORY
```

The evidence directory must not exist. Failed runs retain their raw/partial exchange, bounded native stdout and terminal
failure receipt. Do not replace a failed receipt with a later success. The first run exposed Docker's empty tmpfs
`Mounts` summary; the maintained owner checks the live kernel mount table for all five exact size/security policies.
Strict types, syntax controls, lint and formatting passed in isolated receipt `c3ca4fff-3a18-4991-a273-d415f845e9b6`;
the malformed-frame controls also run through `deno task quality`.

This is a stable **one-broker observation**, not qualification of a production Kafka parser, leader recovery, TLS/SASL,
replication or native error semantics. The older `metadataSemanticClaim: false` receipt stays unchanged.

Admin success cannot supply Metadata4 wire error codes or throttle evidence. Its public controller observation with
`bootstrap.servers` is not an independent multibroker controller identity. Read actual topic internal flags from the
SDK, compare replica assignment order and ISR membership deliberately, and retain every new proof separately.
