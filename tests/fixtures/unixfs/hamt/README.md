# Native fanout-256 HAMT evidence

`produce.py` runs Kubo 0.43.1 offline against independently authored files. The candidate reader is not imported. The
script verifies the retained release archive and executable, forces directory sharding with `--max-directory-links=4`,
and compares native complete file reads, selected ranges and directory listings with those originals. The successful
`independent.json` receipt contains 126 blocks, 18 shards and 108 complete originals. Root and nested native listings
match the authored names, and every native file and selected range matches original bytes.

Run the recipe inside a disposable Linux ARM64 container with the verified Kubo archive copied to `/kubo.tar.gz` and
this script copied to `/produce.py`:

```sh
python3 /produce.py --archive /kubo.tar.gz --output /tmp/hamt-independent.json
```

The producer base is `opfs-seven-tools:20261105`, image SHA256
`527d62a5244f4fa71833b4a105a4906ec1c1c7708f64ea2967fa04d96c551dd5`. It needs Python 3 only. Use no network, no host bind
mounts, a 2 GiB memory ceiling, two CPUs and 256 processes. Copy the result out only on exit zero. No Kubo dependency is
introduced into the published library.

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

`hash-produce.py` compiles the exact original public-domain Austin Appleby `MurmurHash3.cpp` and header named in
`primary.json`, then calls the reference x64-128 function with seed zero. A small explicit C ABI wrapper serializes the
first output word big-endian to match Boxo. The retained `hash-reference.json` contains 135 vectors, including every
input length from zero through 129, UTF8 names and a 4096-byte input, plus compiler, wrapper and command receipts. This
was separately executed with the existing Apple Clang 21.0.0 on ARM64 macOS. It is not candidate output and creates no
production compiler or native dependency.

To reproduce, retrieve both exact pinned original files into a supplied source directory, then run:

```sh
python3 tests/fixtures/unixfs/hamt/hash-produce.py \
  --source /path/to/pinned-smhasher-src --output /tmp/hash-reference.json
```

All four Kubo `block put` Murmur3 probes refused insecure hashes. Their exact errors are retained in `independent.json`;
none count as successful hash-byte verification. Kubo's genuine path results independently exercise the complete native
routing convention against original file contents.

`receipts.json` preserves raw producer JSON hashes separately from formatted repository JSON hashes. Formatting changes
receipt layout only; retained archive CAR bytes, serialized blocks, original file bytes and native outputs stay exact.

## Authored hash-exhaustion boundary

`adapt.py` builds deliberately degenerate eight-shard chains using a literal name's independently produced reference
hash. These are authored wire cases, not topology emitted by the genuine importer. `authored.json` retains successful
Kubo complete/range reads for trimmed and left-zero-padded bitmaps, plus native refusal of a ninth shard with
`sharded directory too deep`. The supplied file content is authored before encoding; no candidate output determines
expectations.

The bounded offline container identified in `container.json` ran:

```sh
python3 /adapt.py --archive /kubo.tar.gz \
  --hash-reference /hash-reference.json --output /tmp/hamt-authored.json
```

It exited zero without OOM. Only the successful receipt left the container, which was then removed. The outer producer
succeeds only when the first two variants match original bytes and the ninth-level variant refuses as expected. The raw
receipt SHA256 is `b5368ec2ab861af64f0d9d4b785be1d42924e5c72283d8bd502f54a41fda8dba`.
