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

## Current TypeScript acquisition and producer

The recipe above records the historical Python execution. Its exact producer and process owner now remain inert as
`create.py.snapshot` and `producer-run.py.snapshot`. Their hashes are in `source-map.json`; the old native JSON,
provenance and image/runtime receipts are unchanged. Do not execute a snapshot or relabel those receipts as TypeScript.

The current native producer is `create.ts`, with its whole-process owner in `producer-run.ts`. A new run requires a
separately reviewed Linux Node image containing the admitted QEMU tools and Debian `/bin/dash`; the historical Python
tools image is not a current Node recipe. Copy the relative fixture layout, including the imported `../acquire.ts` and
`../group.ts`, without mounting the worktree or adding candidate library sources. From that copied tree run:

```sh
node /tool/qcow2/producer-run.ts --producer /tool/qcow2/create.ts \
  --output /tmp/qcow2-review/independent.json --receipts /tmp/qcow2-review/receipts
```

Both destinations must be fresh. The wrapper creates the receipt directory, retains the first bounded diagnostic bytes,
kills only its own new Linux process group on a limit/fault, and records retirement faults separately. The producer uses
one fresh temporary directory and removes that owned directory after the run. It compares all native readback bytes
before publishing JSON through a fresh `.next` file and rename. Failed evidence never replaces the checked-in fixture.
Output is capped at 32 MiB; raw plus base64 fixture content is capped at 16 MiB. Each QEMU command inherits an 8 MiB
individual-file hard/soft limit, has a 60-second deadline and contributes to the 4 MiB native diagnostic budget. The
wrapper retains the separate 210-second/4 MiB whole-process limits.

The file limit comes from Debian dash's
[documented 512-byte `ulimit -f` units](https://manpages.debian.org/bookworm/dash/dash.1.en.html): 16,384 blocks is 8
MiB. `/bin/dash` and a constant command apply the bound before `exec`; QEMU filenames/options remain separate argv
values. A failure to set the limit prevents QEMU from running. Substituting another shell can change the units and is
not part of this recipe.

The current acquisition is `acquire-run.ts`, `acquire.sh` and shared `../apt.ts`. The shell retains native signed APT
operations; Node performs inert archive admission, complete offline archive byte/set rechecks, notice collection and
receipt inventory. No current QCOW2 tool invokes Python. Copy `apt.ts`, `acquire.ts` and `group.ts` under `/tool` and
preserve the `qcow2/` source directory. Start from the official
`node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68` image, inspecting
its actual platform/config and recording each derived image ID as described in the
[shared acquisition guide](../acquisition.md). Use these commands in separate created/copied containers with the
resource envelope above:

```sh
node /tool/qcow2/acquire-run.ts download --script /tool/qcow2/acquire.sh \
  --admission /tool/apt.ts --receipts /receipts
# Retain admission, resource and terminal state; commit only the exact owned successful download image.
node /tool/qcow2/acquire-run.ts install --script /tool/qcow2/acquire.sh \
  --admission /tool/apt.ts --receipts /receipts
```

Download requires a fresh receipt directory. Installation requires the successful retained download receipt with no
cleanup faults, then debits the same 180-second/4 MiB combined allowance. Its container must have `--network none`; the
wrapper does not create or inspect containers. Each shell process inherits the same 64 MiB file cap as before. APT
retries are disabled and each HTTP/HTTPS transport has a 20-second timeout. Native signed index, keyring, effective
configuration, before/after package/source versions, exact retained archive SHA/extent and notice evidence remain. The
new runtime receipt records the actual Node executable SHA and complete Node license instead of claiming a Python
runtime. The current `source-map.json` binds original shell/Python sources to their inert snapshots.

These new recipes have not produced the old acquisition or native receipts. Qualify the TS and shell sources, run the
two controlled stages, record the actual new closure, tools, image and resources, then run the independent producer.
Signed Debian repositories can publish new package revisions; the new manifest must state what was actually admitted. Do
not claim byte-identical output or reuse an old package/runtime receipt merely because the requests are unchanged.
