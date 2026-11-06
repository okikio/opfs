# Native QCOW2 fixture proof

`independent.json` contains nine genuine QEMU images and three valid unsupported controls. Original raw bytes were
authored before conversion, and every byte was compared with complete native QEMU readback before the JSON was written.
The producer imports no TypeScript candidate code. QEMU info/map/check and read-only pattern commands add layout
evidence; they are not a second unrelated QCOW2 implementation. Candidate runtime and installed-package checks remain
pending.

The positive images cover versions 2/3, 512/4,096/65,536-byte clusters, sparse interiors, cluster/L1 crossings, all-hole
images, and a genuine preallocated explicit-zero cluster. The zero descriptor is `8000000000005001`: its old physical
cluster exists, while guest reads return zeros. The all-hole images end after eight serialized L1 bytes at offset 12,288
(physical size 12,296); a full final allocation cluster need not exist on disk. Rounded metadata protection is not a
claim that padding past physical EOF is available.

The unsupported controls contain genuine compressed clusters, an owned backing file dependency, and an internal
snapshot. They also reproduced every original raw byte through QEMU. Refusing them is an intentional initial reader
profile; it does not make those native files universally invalid. Malformed parser tests remain separate authored
controls.

The unchanged compact producer JSON is 3,766,663 bytes, SHA-256
`76506edfd3ce44dfdc3cd0b6a0e8b8a43a7d65caa5a63838c48b92e77812dbff`. Formatting the checked-in JSON is tracked separately
from that original hash. The final producer exited 0 without OOM in 0.483 seconds under 1 GiB memory, no additional
swap, 1 CPU, PID 128, network none, and no host mounts. It admitted 6,531,538 combined original/base64 bytes, 9,582
native diagnostic bytes and a 20,873-byte complete log, within the documented bounds.

Two initial executions failed because authored `qemu-io` command arguments omitted their owned image filenames, first in
a read command and then in the write/zero command. The original inputs, native diagnostics, hashes and stopped resource
states were retained. Repairs only added those filenames; no native wire bytes, skipped commands or accepted reader
grammar were changed to hide a producer failure. The subsequent real L1 EOF geometry qualified the reader's
serialized-L1 bounds independently of that command repair.

## Reproduce the native tools and outputs

The historical `RECIPE.md` section used `acquire.sh`, `acquire-run.py`, `create.py` and `producer-run.py`. They describe
signed package download/admission, a separate offline local-archive installation, then offline native production with
finite process-group lifetime, combined diagnostics, fixture/output sizes and resource limits.

Actual qemu-img/qemu-io version is 7.2.22, Debian package `1:7.2+dfsg-7+deb12u18+b3`, with Python 3.13.12 on Linux
arm64. The grammar reference is QEMU v9.2.0 commit `ae35f033b874c627d81d51070187fbf55f0bf1a7`; it is not the installed
producer version. The exact public base and actual task-local derived image IDs are in `provenance.json`. The installed
local image is not a publicly pullable complete toolchain pin.

Signed acquisition admitted six archives (2,672,468 bytes, 12,665,856 declared installed bytes). Its two stages used
4.224 seconds and 4,283 log bytes, exited 0 without OOM, and stayed within the documented limits. `provenance.json`
records all actual archive SHA/package/source/version/architecture fields, executed script hashes, native versions,
resource states, original JSON hash and first failures. `licenses/` retains the original changed-package copyright
notices, complete common-license texts and Python image license. Those receipts concern test tools; production code has
no QEMU or Python dependency.

The eight-lane benchmark passed its complete original-byte preflights on Node 26.13.0, Linux arm64, Mitata 1.0.34 under
the same one-CPU/1-GiB/no-swap/offline limits. Full raw distributions are preserved losslessly with raw/gzip hashes in
`provenance.json`; only scalar results are summarized. No other Docker containers were observed at the start and end,
which does not prove continuous host inactivity or a universal speed ratio.

The maintained native producer is now TypeScript: `create.ts` and `producer-run.ts`, with explicit fresh output and
receipt arguments. The [current producer section](RECIPE.md#current-typescript-acquisition-and-producer) explains its
full-byte readbacks, file/process/output bounds, relative source layout and required new Linux Node/QEMU recipe.
Original Python producer and acquisition sources remain inert snapshots. `acquire.sh` now delegates bounded archive
admission, offline byte rechecks and notices to `../apt.ts`; no current QCOW2 tool invokes Python. These source ports
require a new controlled acquisition/producer run and have not produced the historical native JSON or receipts.
