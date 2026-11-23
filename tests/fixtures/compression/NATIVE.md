# Native Brotli and Zstandard fixtures

This corpus checks the package wrapper against native command-line output. The input is authored binary bytes, including
every byte value and repeated text. It contains one complete stream and an empty stream for each format. The producer
decodes each complete stream with the corresponding command-line tool and compares every original byte. The TypeScript
tests then decode those retained streams through the package API and compare the same authored payload.

The recorded signed Debian packages are `brotli` version `1.0.9-2+deb12u1` and `zstd` version `1.5.4+dfsg2-5` on arm64.
These are fixture tools, not runtime dependencies. Some host Web codecs and these tools can share underlying codec
libraries; this evidence does not establish implementation diversity, a security audit or all-format conformance.

With Python 3 and the reviewed native tools available, run from the repository root:

```sh
python3 tests/fixtures/compression/produce.py
```

The default output is the adjacent `native.json`. Use `--output /temporary/path/native.json` to compare a reproduction
before changing the retained corpus. Tool calls have a 30-second deadline and reject nonzero exits. The script performs
no package installation or network requests. Package acquisition and version approval remain the maintainer's job.

`native-provenance.json` pins the script and complete fixture JSON. Each encoded stream also has its SHA-256 in the
fixture. If tools or producer inputs change, regenerate, inspect full-byte consumer comparisons and refresh receipts
rather than silently preserving old provenance. The recorded local container base is diagnostic; it is not a public,
complete producer image that another machine can pull.

The package delegates codec parsing and internal window allocation to the native runtime. Tests cover small producer
chunks, complete output, empty input, truncation, work limits and TAR composition on supported hosts. Unsupported hosts
must refuse before acquiring the source reader. Those explicit capability refusals are not successful codec execution.
