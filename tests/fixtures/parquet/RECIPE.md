# Reviewable native Parquet fixture recipe

The exact two wheels were acquired, inspected and installed offline. The first native producer run succeeded and
retained 22 genuine files after reciprocal full-value/null-mask checks. See [README.md](README.md) for actual versions,
fixture profiles, original hashes and license boundaries. Candidate runtime, static and installed-package verification
remain separate evidence. The production module has no dependency on any tool described here.

Use public CPython base
`python:3.13.12-slim-bookworm@sha256:a58daefb915e1e03ad48f3ca4df8832065412c5c35cacb9d39f4229184de12b6`. Before creating
a job, inspect its actual manifest/platform and local image ID. It must be Linux arm64; retain that identity and actual
Python version. Do not silently switch to a mutable image tag if the base is unavailable.

Each stage has 1 GiB memory, memory-plus-swap also 1 GiB (no additional swap), one CPU and PID limit 128. Use create,
copy exact reviewed scripts, then start; no host bind mounts. Retain input SHA-256, created/actual state, stdout/stderr,
exit and OOM status, then stop and remove only these exact owned containers after copying evidence. A process deadline
is not a hard timing guarantee for Docker daemon operations; coordinate the host wait and terminate a stuck owned job
explicitly.

## Acquire two original wheels

Network is enabled only for `acquire.py`, using the two exact PyPI-origin artifact URLs/sizes/SHA-256 embedded in that
script. Release metadata was inspected separately in `.tmp/research/parquet/native-candidates.json`; no source build,
dependency resolver or upstream setup is needed. These are registry hash-pinned wheels, not signed APT packages, and the
distinction must remain explicit in the resulting provenance.

The script admits at most two artifacts, each at most 64 MiB and at most 96 MiB combined. Redirects remain on
`https://files.pythonhosted.org`. Whole-wheel SHA-256 must match before ZIP inspection. Across both archives,
decompressed member sizes total at most 512 MiB; at most 10,000 members per wheel and 128 MiB per member. Refuse
duplicate/traversing names, symlinks, encrypted entries, unsupported ZIP methods, and startup `.pth` files. Hash every
decompressed member through bounded chunks. Retain exact original METADATA, WHEEL and RECORD, original embedded
license/NOTICE/COPYING files (1 MiB each/8 MiB combined), and ELF architecture descriptions. The acquisition receipt is
bounded to 4 MiB. Require a 180-second acquisition deadline; a separate parent timeout must also retire its owned
container if necessary.

Create the first container with the exact inspected base and network bridge, then copy `acquire.py` to `/acquire.py` and
run:

```sh
/usr/local/bin/python3 -I /acquire.py
```

Copy `/receipts` only after success; inspect actual dependency metadata, licenses and ELF identities before
installation. Retain the base Python license as well. Commit the stopped acquisition container to an exact derived image
ID for the next stage; that ID is a local receipt, not a publicly pullable reproducibility claim.

## Install admitted artifacts without network

Create a new container from that exact acquired image ID with `--network none`. Copy `install.py` to `/install.py`; run:

```sh
/usr/local/bin/python3 -I /install.py
```

The script rechecks both admitted artifacts' exact hashes and invokes only
`pip install --no-index --no-deps --no-compile` with those local paths. It retains combined diagnostic output with a 4
MiB cap, a 120-second deadline and whole process-group retirement on failure. Installed version metadata is read without
importing PyArrow or DuckDB. No third-party engine is run in this stage. Preserve any
missing-library/platform/dependency failure rather than adding unreviewed packages. Commit the successful tools
container to an exact local image ID with original receipts intact.

## Produce offline, independently of the TypeScript reader

Only after actual acquisition/installation receipts are reviewed, create a fresh `--network none` container from the
exact successful tools image ID. Copy `create.py` to `/produce.py`, `producer-run.py` to `/producer-run.py`, and
`acquire.py` plus `install.py` beside them for the exact script hashes. Run:

```sh
/usr/local/bin/python3 -I /producer-run.py
```

The authored producer imports PyArrow 20.0.0 and DuckDB 1.3.2. It uses one thread, DuckDB's 256 MiB memory policy, no
automatic extension installation, and only fixed authored paths/SQL/data. PyArrow native thread counts are one. The
outer wrapper owns a 180-second process-group deadline and a cumulative 4 MiB diagnostic cap; the producer caps
child-created files at 8 MiB, each fixture at 2 MiB, aggregate raw-plus-base64 fixture accounting at 16 MiB and final
JSON at 32 MiB. Wrapper stdout retains the bounded native output.

Twenty positive fixtures cover empty, required, optional and many-page arrays, all five supported physical types,
multiple row groups, v1/v2 data pages, and page CRC present/absent. Every original physical value and null mask must
agree through both engines before retention. Native page encoding/codec declarations are recorded and asserted.
Floating-point NaN value semantics and signed zero are checked separately; no universal NaN payload preservation is
claimed. INT64 extremes are packed losslessly as original little-endian bytes rather than unsafe JSON numbers.

DuckDB's official v1.3.2 source at immutable commit `0b83e5d2f68bc02dfefde74b846bd039f078affa`,
`extension/parquet/parquet_extension.cpp`, explicitly permits `DICTIONARY_SIZE_LIMIT 0` to disable dictionaries. The
inspected source SHA-256 is `fd2508e250a5aa9ef71d3d79ba5ecafce58c150ceaee7407a4e4ebe825700a45`. The producer still
asserts actual native page encoding declarations; a flag does not replace evidence. A native mismatch is a retained
diagnostic for review, not permission to modify fixture bytes or broaden the reader.

Two further genuine dictionary/Snappy files are refusal controls, still cross-read completely by both engines. No claim
is made yet about an independent reader rejecting corrupted CRCs: default checksum verification can vary. The PyArrow
reader explicitly enables its verification option for every positive file.

Copy `/tmp/independent.json`, `/tmp/native.log` and `/tmp/native-state.json` only after exit 0 with no OOM. Preserve the
original compact JSON unchanged; a repository-formatted copy needs a separate hash and semantic equality proof. Retain
every first failure and exact pre-/post-repair script digest. Final fixtures never import candidate TypeScript code and
the production library never imports either native engine.
