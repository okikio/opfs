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
Previous Python sources are inert `history/*.py.snapshot`, never imported or executed. Original Java oracle sources
remain unchanged under `oracle/`. Primary request/response schemas, upstream notices and attribution investigation
remain inert snapshots. The distribution's incorrect protobuf/JLine notice is retained alongside the separate upstream
protobuf/OTel supplement. That supplement supports the reviewed isolated test use; it does not establish a reproduced
build or repair upstream public redistribution rights. No SDK JAR is copied into this repository or its public package.

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
The TypeScript port has not yet been executed by this source change; a passing replay is a new verifier result over old
native evidence, not a fresh broker/provider qualification.

**Metadata4 semantics remain unqualified.** The retained run checks that metadata frames have the right correlation, not
that their brokers/leaders/replicas/ISR/cluster fields were semantically decoded. The verifier explicitly reports
`metadataSemanticClaim: false`. Closing that gap precedes trusting production leader preflight. Whole-wire page overflow
and unknown append/cleanup controls also remain future candidate tests, not proof supplied by Java poll limits.

A fresh native repeat must retain the reviewed one-broker 1 GiB RAM/swap, one CPU and 128 PID envelope, broker heap 256
MiB, and at most one serial 128 MiB auxiliary JVM. Preserve the 32 MiB data tmpfs, bounded secondary tmpfs/logs, exact
admitted broker image and five-JAR client classpath from `history/kafka-native-recipe.md.snapshot`. The Testcontainers
owner must preserve readiness, terminal diagnostics, partial outcomes and exact cleanup. The old recipe's Python launch
commands are historical source identity only; a maintained native launcher must be typed and qualified before a new run.
