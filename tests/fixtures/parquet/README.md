# Independent Parquet values and page profiles

`independent.json` contains 22 genuine files written by PyArrow 20.0.0 or DuckDB 1.3.2. The authored Python producer
compared every original value and null mask through **both** engines before retaining any file. Neither engine imports
the candidate TypeScript reader. These test-only engines are not library dependencies.

The [current TypeScript recipe](RECIPE.md#current-typescript-and-native-c-workflow) replaces Python package installation
with inert ZIP admission and direct C++ linking. Its separate native qualification passed all 22 profiles, with complete
original values compared through Arrow C++ 20.0.0 and DuckDB CLI 1.3.2. Its DuckDB CLI is a new artifact profile, not a
replay of the old Python wheel. Original tools remain exact inert `.py.snapshot` files; the historical recipe and frozen
proof remain below. The original compact JSON is 1,388,965 bytes, SHA-256
`86a16246d99ee9c500d1ea0e9ec7fa8e90b2a22bcc759c7ed70a16bdb368596c`. Repository JSON formatting, if applied later,
changes that serialization hash; each native file and each original-value/mask blob has its own retained digest.

Twenty files cover five physical types (BOOLEAN, INT32, INT64, FLOAT, DOUBLE), empty/required/nullable/many-page arrays
and actual row-group metadata. Each PyArrow scenario has v1 and v2 page configurations, with and without page CRCs.
Empty files have no data-page evidence, regardless of writer configuration. DuckDB files use PLAIN uncompressed values
and annotate INT32/INT64 with their identity signed integer meaning. Its empty file has no row group. The large files
have two 2,048-row groups. Two further files are real dictionary and Snappy controls: both native readers accept them;
this preview profile refuses values. The original native bytes are never rewritten to fit the candidate profile.

Original values are little-endian blobs, with independent one-byte-per-row masks. They include signed INT64 extremes
beyond safe Number, nulls, signed zero, infinities and NaN. Compare floating values by IEEE value semantics; no NaN
payload bit-identity guarantee is claimed. PyArrow explicitly enables page checksum verification while cross-reading the
valid files. No claim is made here about DuckDB's checksum setting or independent corruption rejection.

The first native generation succeeded without retry, in an offline, unmounted, 1 GiB memory=swap, one-CPU, PID-128
container with bounded diagnostics and a 180-second process-group deadline. Python was 3.13.12 on Linux AArch64.
Acquisition was a separate hash-admitted wheel inspection, followed by an offline installation that read installed
distribution metadata without importing the engines.

The official wheel SHA-256 values are `991f85b48a8a5e839b2128590ce07611fae48a904cae6cab1f089c5955b57eb5` (PyArrow) and
`b3e519de5640e5671f1731b3ae6b496e0ed7e4de4a1c25c7a2f34c991ab64d71` (DuckDB). The base is the inspected public Python
image `python:3.13.12-slim-bookworm@sha256:a58daefb915e1e03ad48f3ca4df8832065412c5c35cacb9d39f4229184de12b6`. Derived
local images are execution receipts, not publicly pullable immutable reproduction artifacts. No Maven, npm, source setup
script or APT package is involved in these native wheels.

Original notices are retained under [licenses/](licenses/). PyArrow's bundled license includes third-party notices.
DuckDB's wheel ships only an experimental Spark license, so the separate engine MIT license was retained from official
v1.3.2 commit `0b83e5d2f68bc02dfefde74b846bd039f078affa`; the Spark notice is not presented as the engine license.
Python's original license is retained too. Production code was authored against the pinned grammar, with no native
engine source copied into it.

Native cross-engine success establishes the fixture bytes and original values. Candidate reader tests, static
compilation and installed-package verification are separate proof stages and must be reported separately.
