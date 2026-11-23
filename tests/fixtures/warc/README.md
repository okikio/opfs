# Independent WARC producer fixtures

`independent.json` contains immutable uncompressed WARC 1.0 and 1.1 bytes produced with
[Webrecorder warcio 1.7.5](https://github.com/webrecorder/warcio/tree/v1.7.5), an independent Python implementation
licensed under Apache-2.0. The payload text, fixed IDs, dates and generator in `produce.py.snapshot` are authored for
this repository. No upstream source code or third-party captured web pages are copied. `warcio` and its `six` dependency
are test-only fixture tools and are not runtime package dependencies.

Each archive contains a binary/UTF-8 resource whose bytes include fake WARC delimiters, an HTTP response with different
block and entity digests, and an empty resource. `warcio.archiveiterator.ArchiveIterator(check_digests=True)` reads the
producer output, validates both digests and supplies the expected full stored blocks. The generator also checks block
lengths and authored entity bytes, and Python `hashlib` supplies independent SHA-256/Base32 verification oracles. A
producer or oracle failure raises an exception and makes the command fail. This proves those fixed examples, not
complete WARC conformance, HTTP replay or crawler interoperability.

The old command used a temporary uv environment with warcio 1.7.5 and six 1.17.0. Its exact project-owned source is now
inert `produce.py.snapshot`; the normal repository workflow does not execute Python.

Recorded generation environment: CPython 3.14.7, warcio 1.7.5, six 1.17.0. The script records the Python version as
provenance; that field can change with the interpreter even when the archive bytes do not. No clocks, credentials,
network captures or candidate OPFS implementation participate in generation. Regeneration requires package acquisition;
the normal TypeScript tests consume saved JSON offline.

| Archive | SHA-256 of decoded WARC bytes                                      |
| ------- | ------------------------------------------------------------------ |
| WARC1.0 | `82bfab8237949e5d4be7d1d4ac8040cd00d1bc55771e4d89eb794f30b323d10a` |
| WARC1.1 | `1b98b770872ec94c091b40d54439c16179c7f17f04d5efff6e6e99a5f4f2a971` |

Tests separately author malformed headers, duplicate metadata, unsupported records and wrappers, range/budget policies,
and corruption. They are adversarial examples, not falsely labelled genuine producer files. No ARC fixture or ARC
support is claimed.

## Current TypeScript controls

Run from the repository root, choosing a new receipt path:

```sh
node --max-old-space-size=128 tests/fixtures/warc/produce.ts --output /tmp/new-warc-controls.json
```

`produce.ts` imports no candidate OPFS code and acquires no packages. It authors fixed wire/file controls from the
original payloads and compares those complete originals with the retained historical fixture. Its receipt explicitly
sets `independentValidation: false`: framing and Node digest calculations are authored controls, not a new independent
producer/parser or validator run.

The producer accepts only the fixed authored case set, admits at most 1 MiB of historical JSON and refuses a receipt
over 1 MiB. The command above places a 128 MiB V8 heap limit around the run; native memory and whole-process limits
remain the outer runner's responsibility. It uses exclusive creation and refuses to overwrite an existing output. Keep
new receipts separate from `independent.json`, which still supplies the existing tests' historical independent proof.
`source-map.json` records the old source bytes and SHA-256 without relabelling old receipts as TypeScript executions.
The new source does not promise the historical wire hashes or broader format conformance.
