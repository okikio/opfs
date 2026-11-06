> Historical execution record. Python sources below are now inert `.py.snapshot` data, not current commands. Current
> authored controls and their weaker proof boundary are documented in [README.md](README.md).

# Shapefile native evidence recipe and execution receipt

Acquisition and offline producer execution completed after separate recipe reviews. The retained state files record
actual image, exit status, memory, CPU, PID, network and ownership facts. The first producer failure remains beside the
successful receipt; it was a native object-API convention, not a repaired candidate result.

Public base inspected directly through the official Docker registry:
`docker.io/library/python:3.13-slim-bookworm@sha256:a5a7017efc5969e00ae2b91c8eb0631049a569652aa4ffc4501769049ae45c72`.
Exact raw index SHA equals that digest. Its Linux ARM64 descriptor is
`sha256:aed314f1f0c7e988b7aee5d889414ec977430bad37770966c52aff5366a13a06`, with image annotation Python
3.13.18-slim-bookworm and official docker-library/python revision `152874b138f0b1c4699fbdcb52b174608cfbfff5`. Raw index
and descriptor receipts are ignored at `.tmp/implementation/shapefile-research/python-{index,base}.json`. This is a
public immutable base, not a vanished local cache ID. The ARM64 pull resolved to image
`8353ef33b6dea0ccf6eaf7d09905c675d0bd8f3bd38ac43d7171cf62f0e35e79`; actual Python was 3.13.18. The offline tool image
was `6e19aff0fb8859a5426c813de2bf5c66866c6c4cb96d1f48fdac5c086d5d07c1`.

Acquisition: approved base only, 1 GiB RAM with swap disabled, 1 CPU, PID 128, no host mounts or published ports. Copy
`acquire.py.snapshot` to an owned container path; the historical invocation was
`timeout 90s python3 /acquire.py /tool/pyshp-acquired`. No pip/setup/system package installation. Download only the
73,744-byte PyPI wheel `pyshp==3.1.6`, SHA256 `be8cd9436dcbde477c63ea789f7dcdea3af19f17ea84f2744bfc12efe9145d1e`; URL is
embedded literally in the script. Reject every redirect before following. Check whole-wheel size/hash before ZIP
inspection. Admit at most 128 members, 512 KiB/member, 2 MiB total declared expansion; refuse duplicates,
backslash/empty/dot/parent paths, encrypted/special/link/directory entries and unsupported methods. Only root
`shapefile.py` and exact `pyshp-3.1.6.dist-info/` members are admitted. Preserve every actual member SHA and exact
source/METADATA/license snapshots. No package import occurs. If actual roots differ, retain the refusal and request a
narrow recipe revision rather than broadening automatically.

Inspect the actual wheel after acquisition, including direct imports and MIT license. PyPI metadata says no default
dependencies (only optional stubs extra), but this is not an execution guarantee. Native source candidate is pinned
GeospatialPython/pyshp 3.1.6 commit `7708b60d598904e35022d840d70ec071a0c4a465`, `src/shapefile.py`, SHA256
`211b44002f628ea9ad697b365a413fbac73e801f2b2337b391ca91c29eeffec5`. The package is test-only and never a production
import.

Execution is separately reviewed after inert inspection. Commit only owned acquisition state to a tool image, then run
`produce.py.snapshot` offline with network none, 1 GiB RAM/swap disabled, 1 CPU, PID 128, no mounts/ports and a
90-second outer deadline. Copy the reviewed producer into the new container and use only that pinned wheel through
zipimport. No candidate source is copied/imported. Capture bounded container logs/exit/OOM/resource facts, actual
version/image, scripts and hashes. Copy output only on exit 0, retain first failures before repairs. Remove only
task-owned stopped containers and tool image after durable receipts; preserve public base and unrelated workspace
containers.

The candidate-free producer writes Point, PolyLine, Polygon, MultiPoint and empty component sets, with Null rows at
their exact ordinals. It compares every coordinate/part and native attribute value to authored originals; a separate
standard-library struct parser compares every SHX tuple and raw DBF field byte, including exact integer
9007199254740993, Unicode text and blank flags. Reader and writer are from one project, so this is not cross-vendor
conformance. It also makes one explicitly authored deletion-flag mutation of each nonempty genuine DBF and records the
native reader's suppressed ordinal without presenting that mutation as genuine writer output. Candidate indexing must
still preserve the original physical row alignment.

Actual producer observations must settle DBF version/reserved/trailer behavior and genuine coordinate/part layouts
before claims. The ESRI primary specification is a copyrighted white paper: retain its primary URL and inspected SHA256
`bd025d588c1ba69428fc36d55e2c6e963c5cd068e54fd9cb1e2706e1962b18c8`, not a wholesale published PDF copy. There is no
codec, CRS transform, text-encoding inference, numeric conversion, topology or full-dBASE conformance claim.

The successful producer emitted five profiles. DBF headers are 129 bytes and nonempty rows are 66 bytes; this writer
omits the optional EOF marker. The first run expected no MultiPoint parts in the native object API. PyShp instead
synthesizes `[0]` for a nonempty MultiPoint although its stored record has no part array. The approved harness repair
retains physical `parts: []`, records `nativeParts` separately, and verifies stored coordinates and parts with an
independent standard-library byte parser. The candidate continues to expose physical parts. See
`produce-first.py.snapshot` and `producer-first-failure.log` for the unchanged first attempt.
