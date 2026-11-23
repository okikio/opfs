# Genuine ARC producers and stored-block oracles

`independent.json` retains two complete unmodified ARC files, their exact SHA-256 receipts, full file-description
blocks, authored stored-block expectations, native consumer diagnostics and tool/source hashes. `Produce.java` invokes
IIPC's real ARCWriter. `ProduceJwat.java` invokes JWAT's real writer and reader. Neither implements an ARC encoder. The
historical Python program compared every native-consumer stored block to authored bytes and ran the independent warcio
consumer; no candidate OPFS code participates in generation.

The payloads are authored offline: a complete HTTP response, binary bytes containing a false ARC record header, a second
response at the same URL and an empty non-HTTP block. There is no network crawl, third-party captured content or copied
upstream executable source. Producers write the bytes and declared lengths themselves. The fixtures are inert JSON;
normal TypeScript tests do not load Java, acquire jars or execute this generator.

## Actual producer and consumer results

| Producer                      | Uncompressed ARC SHA-256                                           | Descriptor framing                                                                        | Consumer evidence                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| JWAT 1.2.1                    | `62d5ae421b17787d568116aca1e9c1c21fe0734e7df49450cba64256d5893877` | Two descriptor lines inside length, separator LF outside                                  | Native JWAT strict: five compliant records; warcio 1.7.5: five records, no warnings, all stored blocks exact       |
| IIPC webarchive-commons 3.0.5 | `432a5650b6939238c731fbef17796c7c7e60a927684c175584cd4b8c39884a98` | One additional blank LF counted inside descriptor length; no outside descriptor separator | Native JWAT lax: five compliant records; strict: descriptor error retained; warcio: warning then ArchiveLoadFailed |

This is a real compatibility finding. Warcio reports `Record not followed by newline`, consumes the first capture header
while looking for a separator and then fails when it sees the stored HTTP status line as the next ARC header. The
fixture retains the warning and failure. It does not add or remove a newline to make warcio pass.

JWAT's lax implementation explicitly treats excessive newline bytes in a version 1 descriptor as compatibility metadata.
It omits that counted byte from its reconstructed descriptor payload. Therefore its descriptor output is **not** the
oracle for the physical descriptor extent. The historical Python fixture generator separately checked the unchanged
producer's raw bytes against the exact authored two-line descriptor layout plus the producer-specific counted LF. Normal
reader tests compare `read(0)` with that entire raw declared descriptor block, not the native consumer's trimmed
reconstruction. JWAT's strict diagnostics and both producer files remain separate evidence.

Warcio's [primary documentation](https://github.com/webrecorder/warcio#arc-files) explicitly says it reads but does not
write ARC. It is used only as a consumer here. Full stored blocks use `ArchiveIterator(no_record_parse=True)` so an HTTP
header or entity decoder does not silently change the oracle.

## Exact tools and source receipts

The native producer artifacts are published by their primary projects on Maven Central:

- [IIPC webarchive-commons 3.0.5](https://repo.maven.apache.org/maven2/org/netpreserve/commons/webarchive-commons/3.0.5/)
- [JWAT ARC1.2.1](https://repo.maven.apache.org/maven2/org/jwat/jwat-arc/1.2.1/)

Every acquired jar used by the harness has an exact SHA-256 in `independent.json` and `produce.py.snapshot`. This
includes the source jars, IIPC's selected runtime dependencies, JWAT's archive/common/gzip jars and its pinned Bouncy
Castle tool dependency. They remain test-only tools; none appears in production imports or package manifests. A fixed
artifact hash identifies tested bytes; it is not a claim that every dependency has received a security audit.

Relevant exact source-file SHA-256 values, read directly from the pinned source jars:

| Primary source                                  | SHA-256                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| IIPC 3.0.5 `org/archive/io/arc/ARCWriter.java`  | `0055b736b0ae8f7e00dfb4931d296ca049fb886ada5a2ba62606b6f083898d26` |
| JWAT 1.2.1 `org/jwat/arc/ArcVersionHeader.java` | `3101b190eb49e87d52e65f13b3b7aae5c27da1856b6543218410675d9a0a7ce9` |
| JWAT 1.2.1 `org/jwat/arc/ArcWriter.java`        | `ef910b844b8cf98ffad74776f745515b72583aee6ccce67da2107388de1a31ff` |
| JWAT 1.2.1 `org/jwat/arc/ArcVersionBlock.java`  | `355a58f2ff23f1f02dac7f8df5f317a5d3d72027d1a246cfc1f3ddfed2e88468` |

The older Internet Archive primary writer source was also inspected at immutable revision
[`92f434e24e038e4f7c81087023a7463b4a009998`](https://github.com/internetarchive/webarchive-commons/tree/92f434e24e038e4f7c81087023a7463b4a009998).
That is context, not a claim that its tree equals the published IIPC 3.0.5 artifact. The source-jar receipts above
identify the writer that actually ran. The normative historical reference is
[Internet Archive's 1996 ARC 1.0 reference](https://archive.org/web/researcher/ArcFileFormat.php). Its prose and
examples have spacing ambiguities; the module names its exact separator policy instead of promoting a tolerant consumer
to normative authority.

Recorded environment: CPython 3.14.7, warcio 1.7.5, six 1.17.0, official Eclipse Temurin 17.0.21+9 macOS/aarch64. The
Java archive was acquired temporarily from
[the official immutable release](https://github.com/adoptium/temurin17-binaries/releases/tag/jdk-17.0.21%2B9), with
`OpenJDK17U-jdk_aarch64_mac_hotspot_17.0.21_9.tar.gz` SHA-256
`78b08c7f5a0598242d5719c022e19479cb4a3aa45c37c19726a757a469ed1c15`, matching its published checksum. No global Java
installation or production dependency was added. Each producer JVM uses `-Xmx64m -XX:MaxMetaspaceSize=128m`.

## Reproduce

The historical command used CPython, pinned warcio/six and a caller-selected JDK. Its exact source is now inert
`produce.py.snapshot`. The current command below requires pre-acquired, hash-admitted jars; it performs no network
acquisition and does not execute Python.

In the historical run, subprocess failures propagated through `check=True`; neither producer ran in an unchecked shell
pipeline. Payload bytes, URLs and dates are fixed. IIPC's native descriptor uses its own current timestamp; that
timestamp and the whole-file hash can change on regeneration. No timestamp or descriptor bytes are rewritten to hide
that difference. JWAT's authored metadata and bytes are deterministic for the pinned tools. The runtime provenance field
also changes with the selected interpreter/JDK. A regenerated receipt is new evidence and should be reviewed before
replacing the retained fixture.

Both IIPC webarchive-commons and JWAT are distributed under Apache-2.0; warcio is Apache-2.0, six is MIT and the pinned
Bouncy Castle jar has its own MIT-style license. The official Temurin build is GPLv2 with the Classpath Exception. No
upstream implementation source or captured third-party web pages are embedded in this fixture. The Java and Python
harnesses and all payload bytes are authored here. Retained output/diagnostics identify the independent tools without
claiming full historical ARC conformance or deployed-provider behavior.

## Current TypeScript harness

Use Node 22.18 or later with the selected native tools already available:

```sh
node --max-old-space-size=128 tests/fixtures/arc/produce.ts --java /path/to/jdk/bin/java --tools /tmp/opfs-arc-tools --output /tmp/new-arc-receipt.json
```

The source imports no candidate parser, installs no packages and never mounts an image. It creates one fresh temporary
root, runs native tools with a 45-second command deadline and a 4 MiB quota on each captured pipe, admits regular files
before reading them, and retains both primary and cleanup errors. It writes only to a new output path with exclusive
creation. A signalled or unstarted child cannot count as a native format refusal. The outer runner owns
whole-process/native memory, CPU and filesystem quotas. The command above caps V8 heap at 128 MiB; that is not a native
process memory limit.

All 12 runtime/source jars must match the retained SHA-256 identities before either Java harness runs. Each JVM retains
`-Xmx64m` and `-XX:MaxMetaspaceSize=128m`. Native JWAT checks all four complete authored stored blocks for both
producers, while the TypeScript harness separately checks the physical descriptor extent and retained strict/lax status
distinction. Jar files are limited to 32 MiB, archives to 16 MiB, diagnostics/source files to 1 MiB and the receipt to 4
MiB. No warcio run or source-jar extraction is claimed: `warcioRerun: false` and `historicalSourceReceipts` make those
evidence boundaries explicit. The source jars themselves are hash-admitted.

Keep each new receipt separate from `independent.json` and review native versions, complete byte comparisons and
resource receipts before replacing any historical evidence. Native timestamps/metadata can change wire hashes. The
source mapping preserves old bytes and hashes without claiming that TypeScript produced the old output, or that these
cases establish whole-format conformance.
