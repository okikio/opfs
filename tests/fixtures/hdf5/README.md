# Genuine classic HDF5 bytes and raw numeric oracles

`independent.json` was produced by the historical Python source, now retained as inert `produce.py.snapshot`, without
importing candidate TypeScript. It contains an actual earliest-format HDF5 file, 37 original numeric arrays authored
before serialization, and seven separately produced unsupported-profile files. Original integers are decimal strings, so
JSON does not round 64-bit values. Special floats have explicit textual labels.

The producer asserts exact bytes through three paths: authored values' original file-order byte arrays, physical extents
returned by native `get_offset()` and `get_storage_size()`, and h5py/h5dump complete reads. Each
`h5dump -d /NAME -b FILE
-o BINARY FILE` output must equal the original bytes. h5py and h5dump both use HDF5, so these
are independent of the candidate, not independent implementations of HDF5. `layout.json` is a separate Python `struct`
audit of the actual source bytes, not the candidate's parsed output.

The native file has superblock 0, eight-byte addresses/lengths, root header at 96, classic TREE at 136, local HEAP
header at 680, and end of allocation/source size 21312. The root TREE is level zero with eight SNOD children. Its first
lower key is the empty heap string; each subsequent lower key equals the prior upper key, and each upper key equals its
child's final literal name. The 40 direct links include 37 datasets, the hard alias, soft link and subgroup. Datasets
use object-header 1, dataspace 1, datatype 1 and contiguous layout 3. The native empty `(0, 3)` dataset has undefined
storage address and zero length; the scalar has rank zero and one stored element. No source bytes were repaired.

## Primary grammar

The immutable HDFGroup release `hdf5_1.14.6` resolves to commit `7bf340440909d468dbb3cf41f0ea0d87f5050cea`. The selected
classic grammar is
[`doxygen/dox/H5.format.2.0.dox`](https://github.com/HDFGroup/hdf5/blob/7bf340440909d468dbb3cf41f0ea0d87f5050cea/doxygen/dox/H5.format.2.0.dox),
SHA-256 `e13aaf8e7fe9ebbb2beb1ebfd84a5c5eb27f963bbb509d50e74b9e9162471bf5`. Its superblock, group TREE/SNOD/HEAP, header
message, datatype, dataspace and layout tables define this reader's byte grammar. The native 16-byte object-header-v1
prefix includes four reserved bytes after header-data length; its observed framing is retained in `layout.json` and
exercised by the tests. Pinned
[`src/H5Olayout.c`](https://github.com/HDFGroup/hdf5/blob/7bf340440909d468dbb3cf41f0ea0d87f5050cea/src/H5Olayout.c),
SHA-256 `a5c68bc06df3af2e4e6016929e48287d457836f7fffe3e3801225a68a06e848e`, provides the version-3 layout decoder
context. The modern [official format specification](https://support.hdfgroup.org/documentation/hdf5/latest/_f_m_t3.html)
is context, not an immutable release pin.

## Current TypeScript and native C workflow

`produce.ts` authors all 37 original numeric datasets as explicit file-order bytes, then compiles the test-only
`native.c`. The native HDF5 API writes an earliest-format classic file with the hard alias, soft link and nested child.
It reads complete datasets and separate coordinate selections, checks native datatype/rank/shape, and reports observed
object/data addresses and storage sizes. TypeScript compares those outputs and allocated physical extents against the
original bytes. Separate `h5dump -b FILE` calls must reproduce every original byte too. Both paths use libHDF5; neither
is an independent HDF5 implementation, and the new route makes no h5py claim.

The native writer also preserves all seven intended refusal profiles: latest format, chunked, gzip-filtered, compound,
unallocated, a 400-dataset tree and a 512-byte userblock. These files retain native header observations; their role is
reader refusal coverage, not a claim that the candidate supports these layouts. Native versions can choose different
addresses, trees and object encodings, so the new route never copies the historical layout numbers above into results.

Run from the repository root in a disposable runner with Node 26, a C compiler, signed Debian `libhdf5-dev`,
`hdf5-tools` and util-linux `prlimit` installed:

```sh
node tests/fixtures/hdf5/produce.ts --output /tmp/hdf5-native-new.json
```

The default compile command uses
`cc -std=c11 -Wall -Wextra native.c -I/usr/include/hdf5/serial -lhdf5_serial -o NATIVE`. `--source`, `--cc`,
`--include`, `--library`, `--h5dump` and `--prlimit` make those tool paths explicit when the reviewed runner differs.
The exact executed compiler/native/CLI commands and source hashes are retained. `--output` must name a new file:
exclusive creation refuses to overwrite existing evidence. Native children have a 16 MiB kernel per-file limit,
60-second deadline with SIGKILL and 4 MiB captured-output budget. Regular files are admitted before reading; the tool
removes only its owned temporary tree. These bounds do not impose a filesystem quota.

This TypeScript/C workflow has not yet run. It needs compiler and bounded native qualification before its output can be
admitted as new evidence. The existing `independent.json`, `layout.json`, `receipt.json` and acquisition records remain
unchanged. The exact Python snapshot retains its original source hash and historical receipt identity.

## Historical native toolchain and reproduction

The parent reviewed and authorized `acquire.sh` and `produce.py`. Acquisition used a disposable Linux ARM64 container
with 1 GiB memory, one CPU and 128 PIDs, no host mounts or published ports, from exact existing base image
`sha256:f1d61877be7f1023016b35716b2424f3f3d77825a875853130311bdb0d9fe43e`. Signed Debian repositories supplied
`python3-h5py`, `python3-numpy`, `hdf5-tools` and their dependency graph. `acquisition/` retains every downloaded
package's SHA-256, exact metadata/version and available copyright/license text. The actual producer used
`/usr/bin/python3` 3.11.2, h5py 3.7.0, NumPy 1.24.2 and HDF5/h5dump 1.10.8, rather than assuming the base image's
`python3` was identical.

The temporary tool image was `sha256:9bea68e2feecada0bd6376a5a349b10fa7c5d5e0ce13b46b5354e499520d6125`. The producer ran
with `--network none` and the same quotas:

```sh
/usr/bin/python3 /produce.py --output /tmp/hdf5-independent.json
```

Acquisition and production both exited zero without OOM. The unformatted native JSON SHA-256 is
`4b38fa96e379405f48a64430d1b83fac4265a669f0367804ec2f0ccf9cdeeccb`; formatting the retained JSON may change its
transport hash without changing the contained file hashes or native receipts. The recipe's subprocess output cap is
checked after capture; fixed authored inputs and the container memory limit bound the test-only job. No claim of a hard
streaming subprocess-output cap is made. Both owned stopped containers and the temporary tool image were removed after
receipts were copied. The original base image was retained. There is no production HDF5 SDK, Python, OS package
acquisition or implicit filesystem walk.

That historical recipe used the recorded base, `acquire.sh` with network access only for signed package acquisition, and
the original `produce.py` command above in a fresh offline container. Inspect all assertions and exit status before
accepting output. Do not replace a failed native result with candidate output. New native versions or layout profiles
need new receipts, not a rewrite of this fixture's provenance.
