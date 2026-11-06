# Native fanout-256 HAMT evidence

`produce.py.snapshot` runs Kubo 0.43.1 offline against independently authored files. The candidate reader is not
imported. The script verifies the retained release archive and executable, forces directory sharding with
`--max-directory-links=4`, and compares native complete file reads, selected ranges and directory listings with those
originals. The successful `independent.json` receipt contains 126 blocks, 18 shards and 108 complete originals. Root and
nested native listings match the authored names, and every native file and selected range matches original bytes.

The historical recipe ran in a bounded offline Linux ARM64 container. Its exact source is now inert
`produce.py.snapshot`; current TypeScript commands follow below. Native tools remain fixture-only dependencies.

## Byte conventions under investigation

`primary.json` pins the sources used to specify the selected native writer profile. The current UnixFS draft describes
fixed-size little-endian bitmaps and least-significant-bit routing. The pinned Kubo/Boxo implementation instead uses a
high-bucket-byte-first bitmap with leading zero bytes omitted, and consumes the big-endian bytes of Murmur3 x64's first
64-bit result from the front. These are observable differences, not alternative spellings for one contract. The
candidate must identify this native profile explicitly rather than silently claiming universal draft conformance.

`go-bitfield` right-aligns a short bitmap in the full 32-byte field. Bucket `i` uses byte `31 - floor(i / 8)` and bit
`i % 8` after padding. Link names begin with two uppercase hexadecimal bucket characters. A two-character name points to
another shard; any suffix is the literal entry name. SHA2-256 verifies acquired blocks; Murmur3 only routes names and is
not a security or authenticity check.

The recipe retains physical bitmaps and link names for native shards. It also tries a separate native `block put`
Murmur3 hash probe. A native refusal remains in the receipt and does not count as a successful hash-byte oracle.

## Retained failures

The first native execution stopped at the recipe's assumption that `dag get` returned a bare base64 string. It actually
returned DAG-JSON's bytes wrapper. The original failure log is retained at
`.tmp/implementation/unixfs-hamt-producer-20261105.log`. The repaired recipe strictly decodes
`{ "/": { "bytes": "unpadded-base64" } }` as specified by the
[primary DAG-JSON bytes contract](https://ipld.io/specs/codecs/dag-json/spec/). This was a test-recipe serialization
error; no native archive bytes were changed. A later successful receipt must be labeled separately from this failed
attempt.

The second native execution reached the complete file/range comparisons, then failed because the recipe expected
`ls --enc=json` to return JSON. Pinned Kubo `core/commands/ls.go` has a CLI post-run function which prints a table
directly, regardless of the requested encoder. The revised recipe retains the exact encoder probe and parses the
explicitly requested finite native table profile. `failures.json` preserves both original tracebacks and their byte
hashes. Neither failed attempt produced a successful interoperability receipt.

## Independent routing hash oracle

`hash-produce.py.snapshot` compiles the exact original public-domain Austin Appleby `MurmurHash3.cpp` and header named
in `primary.json`, then calls the reference x64-128 function with seed zero. A small explicit C ABI wrapper serializes
the first output word big-endian to match Boxo. The retained `hash-reference.json` contains 135 vectors, including every
input length from zero through 129, UTF8 names and a 4096-byte input, plus compiler, wrapper and command receipts. This
was separately executed with the existing Apple Clang 21.0.0 on ARM64 macOS. It is not candidate output and creates no
production compiler or native dependency.

The historical ctypes harness is retained as inert `hash-produce.py.snapshot`. The current executable-wrapper command
below uses the same exact original reference source files and checks every result against this retained vector set.

All four Kubo `block put` Murmur3 probes refused insecure hashes. Their exact errors are retained in `independent.json`;
none count as successful hash-byte verification. Kubo's genuine path results independently exercise the complete native
routing convention against original file contents.

`receipts.json` preserves raw producer JSON hashes separately from formatted repository JSON hashes. Formatting changes
receipt layout only; retained archive CAR bytes, serialized blocks, original file bytes and native outputs stay exact.

## Authored hash-exhaustion boundary

`adapt.py.snapshot` builds deliberately degenerate eight-shard chains using a literal name's independently produced
reference hash. These are authored wire cases, not topology emitted by the genuine importer. `authored.json` retains
successful Kubo complete/range reads for trimmed and left-zero-padded bitmaps, plus native refusal of a ninth shard with
`sharded directory too deep`. The supplied file content is authored before encoding; no candidate output determines
expectations.

The bounded offline container identified in `container.json` ran the historical `adapt.py.snapshot` source with the
pinned archive and native hash-reference receipt. Current TypeScript commands use separate output paths.

It exited zero without OOM. Only the successful receipt left the container, which was then removed. The outer producer
succeeds only when the first two variants match original bytes and the ninth-level variant refuses as expected. The raw
receipt SHA256 is `b5368ec2ab861af64f0d9d4b785be1d42924e5c72283d8bd502f54a41fda8dba`.

## Current TypeScript tooling

From the repository root, use Node 22.18 or later. Native Kubo commands need the bounded offline Linux ARM64 runner and
the exact archive described in the [parent fixture guide](../README.md). Copy the shared `native.ts` and `wire.ts` with
the fixture tree; a single isolated `.ts` file is not the complete input.

```sh
node --max-old-space-size=256 tests/fixtures/unixfs/hamt/produce.ts --archive /kubo.tar.gz --output /tmp/new-hamt.json
node --max-old-space-size=256 tests/fixtures/unixfs/hamt/hash-produce.ts --source /pinned-smhasher --compiler /usr/bin/clang++ --output /tmp/new-hash-reference.json
node --max-old-space-size=256 tests/fixtures/unixfs/hamt/adapt.ts --archive /kubo.tar.gz --hash-reference /tmp/new-hash-reference.json --output /tmp/new-hamt-authored.json
```

`produce.ts` retains all 108 originals, native shard framing, literal directory names, full/range byte checks and
optional hash probe refusals. `adapt.ts` retains two native-positive depth-eight cases and the required native
`sharded directory too deep` refusal for depth nine. Authored topology is explicitly distinct from importer output;
refusal/spawn failure are distinct.

`hash-produce.ts` admits each original C++/header hash before compilation. Its new small executable wrapper calls the
unchanged x64-128 function with seed zero and serializes the first word big-endian. This replaces ctypes mechanics, not
the independent algorithm. It runs all 135 inputs and compares every digest with the historical reference. Source files
are limited to 1 MiB, wrapper inputs to 4 KiB, each command to 60 seconds/1 MiB per pipe and the complete hash run to
two minutes. No Go compiler or candidate hash implementation is needed.

All five Python sources are now inert snapshots mapped with exact bytes/SHA in source maps. Historical JSON, native
failures and execution receipts remain unchanged. New scripts own fresh temporary directories, retain independent
primary/cleanup failures and refuse existing output paths. Shared Kubo archive, command and 32 MiB JSON bounds are
documented in the parent guide; outer native memory/CPU/filesystem limits still belong to the caller. Qualify new
execution receipts before replacing any historical evidence.
