# Native ORC qualification recipe

## Current TypeScript and native C++ workflow

The current workflow passed a separate native qualification of all eighteen intended ORC profiles, comparing complete
original values through the admitted Arrow C++ writer/reader. The run used Node 26.13.0 and Debian C++ 12.2.0 in a
network-disabled 1 GiB runner, without OOM, signals or cleanup faults. Those directions share one native ORC
implementation; no second native ORC engine or new PyArrow execution is claimed. Keep its output separate from the
frozen JSON and historical receipts. Candidate-reader acceptance of newly generated images is a separate check.

The [Parquet recipe](../parquet/RECIPE.md#current-typescript-and-native-c-workflow) explains the common archive
admission, toolchain, process and container budgets. ORC needs the same pinned PyArrow wheel and C++ libraries but no
DuckDB CLI. Use `--orc` when acquiring its single input:

```sh
node tests/fixtures/parquet/acquire.ts --orc --output /tmp/orc-receipts-new
# Review its exact hash receipt, then copy to the separate offline runner.
node tests/fixtures/orc/install.ts --receipts /tmp/orc-receipts-new --output /tmp/orc-cpp-new
node tests/fixtures/orc/producer-run.ts --artifacts /tmp/orc-cpp-new --output /tmp/orc-native-new
```

`create.ts` feeds authored little-endian originals and separate validity bytes into the public C++ API in
`../arrow/native.cpp`. Both file versions, all three row counts, all three null layouts and seven physical types remain.
Readback compares exact integers/masks, IEEE float values and signed zeros, with no NaN payload identity claim. Separate
authored protobuf envelope checks retain version, compression, stripe offsets/lengths/counts, DIRECT/DIRECT_V2 encoding
receipts and the `contentLength` equation. Modern SHORT/INT/LONG remain genuine refusal controls; the port does not add
candidate RLEv2 support.

The optional `launch.ts` creates one explicitly named install or native container from an already present immutable
image ID. It never pulls, builds or commits an image. Install accepts the pinned official Node 26 base; the native stage
must use a separately prepared image containing the admitted C++ subset and signed compiler tools. It verifies no
network, mounts, added capabilities, devices or ports before start, then retains attachment, copied result and final
exit/OOM receipts. Preparing and reviewing the derived native image remains the operator's explicit step:

```sh
node tests/fixtures/orc/launch.ts --stage install --image-id sha256:<actual-node-base-image-id> --name opfs-orc-install-<unique-suffix> --receipts <admitted-arrow-archive-directory> --output <new-install-receipt-directory>
node tests/fixtures/orc/launch.ts --stage native --image-id sha256:<reviewed-derived-tools-image-id> --name opfs-orc-native-<unique-suffix> --output <new-native-receipt-directory>
```

Successful qualification must retain all eighteen native images and full comparisons. In particular, the 8192-row
nonnull profile must still produce multiple stripes, and actual wire encodings must match their intended versions.
Different byte serialization or stripe counts must be reported as a changed profile, not silently attributed to the old
Python run. The new qualification independently reconfirmed 32 stripes for 8192-row nonnull/mixed-null cases and seven
for all-null cases, in both versions; it did not replace the frozen historical images.

## Historical Python evidence

The following commands and results describe the executed historical workflow. Its tools now remain exact inert
`.py.snapshot` sources, not current executable entrypoints.

The recorded installation and native-production run completed on November 5, 2026. [provenance.json](provenance.json)
and [receipts](receipts/) retain their actual inputs, limits, outcomes and the first installation failure. The
TypeScript reader has no runtime SDK dependency. This recipe installs only a previously inspected, SHA-admitted test
wheel in an offline disposable container.

## Inputs and admission

Use the exact public multi-platform Python reference:

`python:3.13.12-slim-bookworm@sha256:a58daefb915e1e03ad48f3ca4df8832065412c5c35cacb9d39f4229184de12b6`

Inspect the current image and platform before use. The earlier Parquet tools image is not assumed available. Preserve
pull/inspection failures. Actual image ID, architecture, Python version and its original license must be retained.

Reuse only this already acquired and inert-inspected artifact:

- PyArrow 20.0.0, CPython 3.13 / manylinux_2_28 aarch64 wheel, 40,677,027 bytes, SHA-256
  `991f85b48a8a5e839b2128590ce07611fae48a904cae6cab1f089c5955b57eb5`.
- Original host wheel and acquisition metadata are under `.tmp/research/parquet/acquisition-receipts/`. Before copying,
  verify exact bytes/hash and extract the PyArrow entry from the original acquisition JSON without altering the retained
  original. The new `/receipts/acquisition.json` must contain exactly that single entry.
- Reuse the original WHEEL/METADATA/RECORD/member/ELF inspection receipts and embedded PyArrow LICENSE/NOTICE, not a
  claim that registry hashing is signed APT. PyArrow has no mandatory runtime wheel dependencies in this admitted
  artifact; its five requirements are test-extra-only.
- No DuckDB, second wheel, Maven/Java, compiler, upstream setup script or newly fetched dependency is part of this
  recipe.

Review the actual wheel, image, resource settings and prior-stage receipts before admitting execution. Source review and
successful installation do not establish native-engine behavior.

## Stage 1: offline installation

Create an owned container from the exact inspected public image, with
`--network none --memory 1g --memory-swap 1g --cpus 1 --pids-limit 128` and no host mounts. Use create → `docker cp` →
start. Copy `install.py` and only the admitted wheel plus one-artifact receipt to `/receipts`. Run
`/usr/local/bin/python3
/install.py` with an outer deadline of 150 seconds.

The script rechecks size/SHA before pip, uses `--no-index --no-deps --no-compile`, retains at most 4 MiB combined
diagnostics, retires the process group after its 120-second deadline and reads installed metadata without importing
PyArrow. The script creates container-owned `/tmp/orc-install` for `install.json` and `install.log`; `/receipts` remains
untouched input. Copy those outputs from the stopped container even after failure. Retain install JSON/log, script SHA,
container limits/image/state/exit/OOM and actual Python/license receipts before deriving a task-owned tools image. No
SDK engine execution is admitted by this installation stage alone.

## Stage 2: candidate-independent native fixtures

After reviewing the successful installation receipt, create an offline container from that exact recorded derived image
under the same quotas/no-mount policy. Copy:

- `create.py` → `/produce.py`
- `install.py` → `/install.py` (provenance hash input)
- `producer-run.py` → `/producer-run.py`

Run `/usr/local/bin/python3 /producer-run.py` with a 210-second outer deadline. The wrapper has a 180-second
process-group deadline and a cumulative 4 MiB stdout/stderr cap. The producer admits each file at 2 MiB, cumulative
original and encoded binary at 16 MiB and final JSON at 32 MiB. Its file-size limit is 32 MiB. PyArrow CPU and I/O pools
are each one thread. All paths, values and filenames are fixed authored inputs in an owned temporary directory.

Eighteen genuine files cover versions 0.11/0.12, empty/37/8192 rows and nonnullable/mixed-null/all-null columns. Every
BOOLEAN, BYTE, SHORT, INT, LONG, FLOAT and DOUBLE original is checked after native readback, including signed endpoints,
bigint, NaN, infinity and signed zero. Original typed little-endian bytes and null masks are retained. An independent
authored Python Protobuf framing examiner records actual content-length basis, stripes, and encodings. It asserts DIRECT
for the supported columns and DIRECT_V2 for modern SHORT/INT/LONG controls. These are assertions about actual emitted
bytes; failure remains a diagnostic rather than permission to rewrite fixtures or relax the reader.

Native writer and reader share Apache C++ ORC through PyArrow. This proves real wire/original-value interoperability
against our separate TypeScript decoder; it does not prove agreement between two independent native ORC implementations.
The authored alternate content-length-convention test is not a native fixture.

Copy `/tmp/independent.json` only after producer exit 0, no wrapper failure and container state inspection. Retain all
first failures unchanged. Preserve raw JSON hash separately if repository formatting later changes presentation. Keep
original binary/value/mask blobs unchanged. No benchmark is authorized by this recipe.

## Stopped-container launcher

`launch.py` separates installation from native execution. Review and authorize each invocation separately. It never
pulls images, commits tools images or automatically starts the other stage. Supply the inspected actual local
`sha256:...` image ID, an unused `opfs-orc-install-...` or `opfs-orc-native-...` name, and a fresh output directory. The
installed stage additionally takes a private `--receipts` directory containing only `acquisition.json` and
`wheels/<admitted wheel>`.

```sh
python3 tests/fixtures/orc/launch.py --stage install --image-id sha256:<actual-python-image-id> --name opfs-orc-install-<unique-suffix> --receipts <private-one-wheel-directory> --output <new-install-log-directory>
python3 tests/fixtures/orc/launch.py --stage native --image-id sha256:<approved-derived-tools-image-id> --name opfs-orc-native-<unique-suffix> --output <new-native-log-directory>
```

These are two distinct reviewed commands, not a combined execution instruction. Before `docker start`, the launcher
retains actual Linux/ARM64 image inspection and a fresh-created container inspection. It checks exact image ID and
command, never-started state, 1 GiB memory and swap, 1 CPU, PID128, no network/mounts/ports, no added
capabilities/devices, all capabilities dropped and no-new-privileges. `docker create --pull never` prevents an implicit
image acquisition. Inputs are copied only into the stopped container. Raw create/copy/inspect failures remain in the
fresh log directory; existing outputs are never overwritten.

Commands have at most 30-second diagnostics deadlines and 4 MiB per-command logs. The combined start attachment is
capped at 5 MiB. All setup and attachment work shares the stage's 150/210-second deadline. Failure cleanup can take at
most 30 seconds for stop and 30 seconds for final inspection, plus bounded child retirement. Use an outer process
deadline of 240 seconds for install and 300 seconds for native. Preserve the launcher receipt and final stopped/OOM
state; no container or image is deleted automatically.
