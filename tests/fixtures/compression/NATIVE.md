# Native Brotli and Zstandard fixtures

This corpus checks the package wrapper against native command-line output. The input is authored binary bytes, including
every byte value and repeated text. It contains one complete stream and an empty stream for each format. The producer
decodes each complete stream with the corresponding command-line tool and compares every original byte. The TypeScript
tests then decode those retained streams through the package API and compare the same authored payload.

The recorded signed Debian packages are `brotli` version `1.0.9-2+deb12u1` and `zstd` version `1.5.4+dfsg2-5` on arm64.
These are fixture tools, not runtime dependencies. Some host Web codecs and these tools can share underlying codec
libraries; this evidence does not establish implementation diversity, a security audit or all-format conformance.

With Node and the reviewed native tools available, run from the repository root:

```sh
node tests/fixtures/compression/produce.ts --output /tmp/native-codecs-next.json
```

An explicit output destination is required so a comparison run cannot silently replace retained `native.json`. Current
tool calls have a 90-second deadline and reject nonzero exits. The script performs no package installation or network
requests. Package acquisition and version approval remain the maintainer's job.

`native-provenance.json` pins the original Python script, now inert as `produce.py.snapshot`, and complete historical
fixture JSON. Each encoded stream also has its SHA-256 in the fixture. If tools or producer inputs change, regenerate,
inspect full-byte consumer comparisons and refresh receipts rather than silently preserving old provenance. The recorded
local container base is diagnostic; it is not a public, complete producer image that another machine can pull.

The TypeScript tool records its own source, shared harness hash, runtime and observed native tool versions. Historical
package versions above are not assertions about an unexecuted new run. Follow the
[codec evidence workflow](../codecs.md) to compare a new output and preserve historical receipts when source or tool
identities differ.

The package delegates codec parsing and internal window allocation to the native runtime. Tests cover small producer
chunks, complete output, empty input, truncation, work limits and TAR composition on supported hosts. Unsupported hosts
must refuse before acquiring the source reader. Those explicit capability refusals are not successful codec execution.
