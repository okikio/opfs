# QCOW2 native proof recipe for review

Signed acquisition, offline installation and the offline native producer completed successfully. Actual versions,
archive hashes, notices, original raw JSON hash and resource states are recorded in `provenance.json`. The native
producer compared every original raw byte for nine positive images and three unsupported controls. Its two original
filename-argument failures remain retained separately. Candidate runtime and installed-package validation remain
pending. Any rerun still needs its assigned resource window.

Use this exact public image, after inspecting its manifest and actual image ID:

`python:3.13.12-slim-bookworm@sha256:a58daefb915e1e03ad48f3ca4df8832065412c5c35cacb9d39f4229184de12b6`

The prior BinHex task observed arm64 child manifest `34b27ac66ecf318887b55ea3c71f0db9307895efe631210231a66cc3fa130cf9`
and image `5ae62b8a656b92aebda2441c1b4b872da0799b4deabca9f6c476f5940624ebef`. Those are historical observations; inspect
availability and the new task's actual platform/image/runtime rather than claiming they are current.

Create an owned `opfs-qcow2-acquire-20261105` container with `--memory 1g
--memory-swap 1g --cpus 1 --pids-limit 128`,
no mounts and no ports. Network is allowed only for signed Debian package acquisition. Copy `acquire.sh` and
`acquire-run.py` into `/acquire.sh` and `/acquire-run.py`, then start its fixed command
`/usr/local/bin/python3 -I /acquire-run.py /acquire.sh download`. Capture log, exit, OOM/quota/platform/image state and
`/receipts` before committing an admitted-download image. That stage ends before installation. From its exact image ID,
create a second equally bounded container with `--network none`, no ports or mounts, and command
`/usr/local/bin/python3 -I /acquire-run.py /acquire.sh install`. The wrapper requires the first stage to have succeeded.
This stage rechecks retained archive hashes/file set and installs them with dependency ordering from local files:
`apt-get --no-download --no-install-recommends -y install /receipts/debs/*.deb`. No download is permitted, and lack of a
complete local dependency closure fails closed. Capture all state/receipts before committing the final tools image.
Plain `dpkg -i` is deliberately avoided because a separate native task demonstrated its pre-dependency ordering failure;
no QCOW2 acquisition has been attempted. The script disables only the disposable base Docker archive-clean hook,
retaining its original contents. Before installation it admits and retains the actual APT closure: at most 256 archives,
64 MiB each, 256 MiB total, and 768 MiB declared installed bytes. Every archive records SHA-256,
package/version/source/architecture and installed size. The offline no-download APT phase installs only those retained
local archives; no refetch follows admission. Every new/upgraded package contributes its original copyright notice and
bounded complete common-license texts (1 MiB each, 8 MiB aggregate). Signed InRelease/source/keyring evidence, effective
APT configuration, original archive bytes, complete package before/after versions, native binaries/help, and actual
Python provenance remain. The wrapper limits the two process groups to a cumulative 180 seconds of active acquisition
execution and 4 MiB combined logs, carrying the download receipt into the offline phase. Coordinator image
inspection/commit time between stages is not charged as native execution. Each stage retains its own failure/log prefix.
Individual files are capped at 64 MiB; non-archive receipts are capped at 64 MiB/1,024 files including the live log. A
failed bound is retained as failure. No source downloaded from QEMU is compiled or executed.

Then create a separate owned offline producer from the exact derived tools image ID, with the same limits,
`--network none`, no mounts or ports. Copy this authored `create.py` to `/produce.py`, `acquire.sh` to `/acquire.sh`,
and `acquire-run.py` to `/acquire-run.py`, and `producer-run.py` to `/producer-run.py`. Its exact command is:

```sh
/usr/local/bin/python3 -I /producer-run.py
```

Use create → copy → start, never a source bind mount. Script hashing expects `/acquire.sh` beside `/produce.py`. Each
native child has a 60-second timeout and 8 MiB file-size limit. stdout/stderr go to bounded temporary files and
diagnostics are printed before a nonzero native command raises. The outer wrapper limits the complete process group to
210 seconds and 4 MiB combined diagnostics, preserving its first log prefix and deadline/exit receipt. The inner
producer also limits aggregate native diagnostic bytes to 4 MiB, raw plus base64 fixture bytes to 16 MiB across all nine
positives/three controls, and final serialized JSON to 32 MiB before writing it. The whole producer is bounded by 1 GiB
RAM, no additional swap, and PID 128. Inputs are fixed, authored files; no candidate imports, filesystem mounts, VM,
guest execution, KVM, or shell interpolation occurs.

The nine genuine positive fixtures cover version 2/3 at 512/4,096/65,536-byte clusters, sparse interiors, cluster and L1
crossings, two all-hole images, and a native zero-write image. Every original full raw byte is compared with QEMU
readback before JSON output. Native info/map/check and read-only pattern reads add scope evidence. The zero-write
command produced observed descriptor `8000000000005001`, a preallocated explicit-zero cluster. Its old physical bytes
remain unchanged in the native image. All-hole images end directly after serialized L1 entries; rounded metadata
protection does not invent physically available padding. No wire bytes are adapted to match the candidate.

Three genuine controls use QEMU compressed clusters, a backing file pointing only to the owned raw file, and an internal
snapshot. All must also reproduce original raw bytes through native QEMU. These valid unsupported profiles remain
distinct from malformed authored parser controls. All native failures remain fatal until actual output and command
grammar are reviewed; there is no skip branch.

Copy JSON only after producer exit 0, no OOM, and recorded resource state. Retain the exact raw JSON SHA before
formatting, every first failure, source script SHA, actual packages/tools/licenses, and images. This is an
original-raw/QEMU oracle independent of the TypeScript candidate, not two unrelated QCOW2 implementations. Remove only
these task-owned containers after evidence is copied. Benchmarks need a separate quiet-window approval and are not part
of this recipe.
