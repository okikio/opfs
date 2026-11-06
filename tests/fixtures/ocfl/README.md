# Independent OCFL 1.1 producer and extractor evidence

`independent.json` is inert full-byte output from
[zimeon/ocfl-py](https://github.com/zimeon/ocfl-py/tree/a480226d54cf8d03d71ab8c56eb69ae8a78e231d), immutable revision
`a480226d54cf8d03d71ab8c56eb69ae8a78e231d`. Installed version: `2.1.0`; interpreter: CPython `3.14.7`. The installed
`ocfl/object.py` SHA-256 is `123e732088523c2fb65b60e58159d9d41c39be8303132cf572e0f7f66018d745`.

The independently authored inputs are visible in inert `produce.py.snapshot`. The upstream `Object.build()` writes two
genuine OCFL 1.1 objects, using SHA-512 and SHA-256 respectively, each with three versions. `Object.validate()` accepts
both objects. Its independent `Object.extract()` reproduces each version's complete authored filename/byte mapping. The
retained files include root declaration, root and version inventory JSON, inventory sidecars, and content. Nothing in an
upstream inventory, declaration, path, digest or content file is rewritten. The corpus includes modifications, deletion,
restoration, rename, logical aliases, forward-delta physical reuse, empty files, binary bytes and a mail message.

Each retained physical and extracted file has its full base64 bytes and SHA-256. Normal runtime tests recompute physical
file hashes, select every independently extracted logical file, compare exact bytes, verify inventory/content digests,
and compose the genuine mail content with the MIME reader. The extracted expectations originate from the authored input
and are checked by the independent extractor before being saved; candidate output never defines an oracle.

## Current authored controls

Run `node tests/fixtures/ocfl/produce.ts --output /ABS/NEW-ocfl.json` with Node 22.18 or later. The output path must not
exist. Stage this directory with `../iso/native.ts` and `../codec.ts` in an isolated runner. No Python or SDK
acquisition occurs.

The current harness authors both digest profiles, each three-version state, the first-occurrence content manifest and
all original payloads. Every inventory is compared structurally with the frozen native inventory; every physical content
byte and every complete extracted filename/byte mapping must match. New inventory whitespace and matching digest
sidecars are authored, so new file hashes need not match the historical writer’s serialization. Historical sidecar
digests are checked against the historical inventory bytes separately.

The output says `independentNativeRerun: false`. It does not invoke `ocfl-py`, run its validator/extractor or establish
new independent conformance. `independent.json` and its native evidence remain unchanged. `source-map.json` records the
exact historical Python source hash and inert snapshot; new receipts do not replace frozen native output.

## Historical independent execution

The old producer used the pinned Python package described above and is preserved as `produce.py.snapshot`; it is
retained for inspection, not execution.

The producer and its transitive Python dependencies are test-only acquisitions. They are absent from package imports and
manifests. This is interoperability evidence for one implementation profile, not a deployed storage test, full OCFL
validation suite or cryptographic authenticity proof. Authored malformed cases in `tests/ocfl.test.ts` separately
exercise reader safety rules. The producer's default `content_path_normalization="uri"` is used without alteration; all
authored physical filenames in this corpus are ASCII. The reader's literal percent and Unicode path policy has separate
authored regressions.

The upstream software is MIT-licensed. The fixture bytes originate from this repository's authored inputs; the following
notice records the independent producer's license without embedding executable upstream source:

```text
MIT License

Copyright (c) 2018 Simeon Warner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Normative source receipt

The reader's specification review uses primary repository
[OCFL/spec at 2637866930ce26c52b50510aa91cbed9c1c4b0a4](https://github.com/OCFL/spec/tree/2637866930ce26c52b50510aa91cbed9c1c4b0a4/1.1/spec).
The unchanged `1.1/spec/index.md` SHA-256 is `3d02c6c68e542f471d9252cf1f02cd97e94615e3063930507fb2c33aa31d8f6e`;
`1.1/spec/inventory_schema.json` SHA-256 is `3f87a36951c25464824a25273e1480fd68448668f05ee7fa5af0115716b0b82c`. These
identify primary source bytes, separately from producer fixture bytes. In section 3.3, requirement E011 explicitly
forbids a padded version name that loses its leading zero. Tests therefore admit 100 versions named `v0001`..`v0100`,
reject mixed widths, and reject `v001`..`v100` padding overflow.
