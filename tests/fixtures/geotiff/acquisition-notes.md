# GeoTIFF test-tool acquisition history

The public Python ARM64 manifest digest `a5a7017efc5969e00ae2b91c8eb0631049a569652aa4ffc4501769049ae45c72` resolved to
actual image `8353ef33b6dea0ccf6eaf7d09905c675d0bd8f3bd38ac43d7171cf62f0e35e79`. Acquisition was bounded to 1 GiB RAM,
no swap, 1 CPU and 128 PIDs, with no mounts or published ports. This is test-tool installation, not a production
dependency or native format interoperability result.

The first attempt admitted 102 signed Debian archives: 58,395,884 downloaded bytes and 227,525,632 declared installed
bytes. Their exact hashes remain in `acquisition.json`. The original package baseline remains byte-preserved in
`packages-before.tsv.snapshot`. Source scripts, apt configuration, complete bounded logs and terminal state are
retained.

The first installation used a sorted `dpkg -i` glob. It failed on Python pre-dependencies: python3-minimal needed
python3.11-minimal installed first, and python3 needed python3-minimal first. The container exited 1 without OOM after
26.2 seconds. Some packages were installed but the resulting tool state was incomplete. The exact original scripts
remain `.first.snapshot` files; `acquisition-first.log` records the failure.

The separately approved continuation used the exact admitted archives, verified every hash, preserved the original
baseline and ran with network disabled. Apt refused that partially configured state without an explicit fix-broken
operation. The second attempt exited 100 without OOM after 0.33 seconds. Its 758-byte log and state are retained as
`continuation-first.*` and `continue-first*.snapshot`.

The next reviewed continuation adds `--fix-broken --no-remove` while retaining `--no-download`, no recommends, network
disabled and the same 102-archive hash gate. It may repair only task-owned installation state; it cannot remove packages
or acquire a replacement dependency. The final continuation exited 0 without OOM after 2.59 seconds; its 8161-byte log
and resource state are retained as `continuation.*`. All 102 changed-package notices were collected against the original
baseline, totaling 1,754,924 bytes. `runtime.json` records system Python 3.11.2, base Python 3.13.18, NumPy 1.24.2,
tifffile 2023.2.3 and GDAL 3.6.2. The exact resulting tool image is recorded in `tool-image.json`. The separately
approved offline native producer subsequently passed; see `README.md`, `producer-run.json` and `producer-state.json` for
its actual proof and limits. Successful tool installation alone is not native format proof.
