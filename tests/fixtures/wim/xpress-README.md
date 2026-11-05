# Genuine ordinary XPRESS-Huffman WIM evidence

`xpress-produce.py` authors two image trees, captures/appends an ordinary WIM using genuine wimlib
`--compress=xpress --chunk-size=32768`, verifies it, applies both images and checks every complete authored file with
independent 7-Zip. It never imports OPFS or obtains an expected payload from the candidate decoder. It also calls the
native libwim decompressor API for every compressed chunk and checks the complete decoded resource SHA1, including image
metadata. Resource oracles retain complete bytes rather than success flags alone. The API is from the producer's
implementation family; it is not described as a second independently authored decompression algorithm.

The run used disposable bounded container `opfs-wim-producer-20261105`, 2 GiB/2 CPUs/256 PIDs, based on image
`opfs-seven-tools:20261105`, SHA256 `527d62a5244f4fa71833b4a105a4906ec1c1c7708f64ea2967fa04d96c551dd5`. Signed Debian
bookworm packages identify wimtools/libwim15 as 1.13.6-1; the actual tool reports wimlib-imagex/libwim 1.13.5. The
independent consumer reports 7-Zip 26.02. Receipts retain actual version strings, checked subprocess outcomes and the
warning that no optional whole-file integrity table exists. Applying/verifying resource hashes does not replace that
absent integrity-table check. No private or external file is copied into the fixture.

The original container command retained its old output path `/tmp/wim-independent.json`; the resulting bytes were copied
to `xpress-independent.json` only after producer exit 0. Regeneration commands are:

```sh
python3 tests/fixtures/wim/xpress-produce.py --output /tmp/wim-xpress-independent.json
python3 tests/fixtures/wim/xpress-audit.py /tmp/wim-xpress-independent.json > /tmp/wim-xpress-tail-receipt.json
```

Native creation times and GUIDs are not repaired; new WIM hashes will differ on regeneration. Authored files cover
100,000 deterministic random bytes stored without compression, 200,000 repeated bytes with extended match lengths,
32,767/32,768/32,769-byte boundaries, shared resources, empty files, Unicode names and differing files in two images.
The retained WIM contains 12 resources and 13 compressed chunks. Some chunks/resources are stored fallback data.

## Exact framing evidence and limits

`xpress-audit.py` is an authored interpretation of the pinned Microsoft/wimlib writer grammar. It first compares
complete output bytes against already established native resource oracles, then requires terminal canonical symbol 256,
exact packed extent and 16 through 31 remaining zero bits. All 13 compressed chunks satisfy those conditions; observed
zero bit counts are 17, 26, 27, 28 and 30. Extended 16-bit adjusted match lengths include 508, 3387, 32756, 32760
and 32763. The full measurements remain in `xpress-tail-receipt.json`.

This audit is not a third independent native consumer. The strict termination policy describes the selected writer
profile, not universal native decoder acceptance. Pinned wimlib decoding stops after expected output size and does not
check the extra end symbol. Its compressor explicitly emits that symbol and flushes alignment plus a zero coding word.
The Microsoft encoder describes the same termination and interleaved byte locations. Its decoder pseudocode omits the
encoder's 32-bit length escape; the selected 32 KiB chunk profile cannot require a valid match that large, so it refuses
invalid short extended words rather than inventing escape semantics. Plain XPRESS, other chunk sizes, LZX, LZMS,
solid/pipable WIM and arbitrary trailing-byte compatibility are outside this evidence.

## Immutable primary sources and retained bytes

The Microsoft
[MS-XCA download](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-xca/a8b7cb0a-92a6-4187-a23b-5e14273b96f8)
resolved to the primary PDF at <https://winprotocoldoc.z19.web.core.windows.net/MS-XCA/%5BMS-XCA%5D.pdf>. Acquired bytes
identify `[MS-XCA] v20240423`, release April 23, 2024, 1,144,541 bytes, SHA256
`e7806b36adc81b75f50bf57559c55420fcaadeb98a0435e8865d2eb3512d5e9e`. Sections 2.1.4.3 and 2.2.4 govern the selected
Huffman writer/reader grammar. This acquired-byte hash pins a potentially mutable download URL; it is not a signature
verification claim. Microsoft WIM 1.1's RTF hash and the header/resource structures remain pinned in
[README.md](README.md).

All implementation research below uses immutable
[wimlib cd5e231c348c255ae5088873b5a66ee0eb96fa07](https://github.com/ebiggers/wimlib/tree/cd5e231c348c255ae5088873b5a66ee0eb96fa07).
It is not claimed to be the exact source used to build the Debian binary.

| Source or retained file              | SHA256                                                             |
| ------------------------------------ | ------------------------------------------------------------------ |
| `src/xpress_decompress.c`            | `7e0efb7f3126c1017d6d3b0e7367780238d7a3a71214d19ee2abaeb98fae6db9` |
| `src/xpress_compress.c`              | `3b224523aab9b6b70fde30a536291c7b28502e83170195aab10a2d3a8c2b3d50` |
| `src/resource.c`                     | `188feebd2d110da66e540db5f57ee00e4ae58eada9be877bed7b9f4d62fb57fd` |
| `include/wimlib/decompress_common.h` | `4d637781f162dcc6edde13df36bb492c2373389aa92624d466a7c5eb46cf42bb` |
| `src/decompress_common.c`            | `eb0f8ad3cbc57ea3048d0db7bf2594436cd11e31ee4e3f73d816fb1aff515282` |
| `xpress-produce.py`                  | `f34e793640e0670f5dec399e42263e2d4407ac7319fa7712155b1040e4b8fee3` |
| `xpress-audit.py`                    | `7cd8b9b28a2cbf3466dcad79ff298e3a3a2858a4104546d9b67efa534e809a09` |
| `xpress-independent.json`            | `ff1d38c1568fd479a1ad387c040a6877eadb55028366f8a3f2c06305c2aa552c` |
| `xpress-tail-receipt.json`           | `dcb5b144209412d69e7ea199e9f49594a0d89026298c2b8968532ced8b4a6e90` |

No upstream implementation code is copied, linked or shipped as a runtime dependency. The researched wimlib code is
LGPL2.1-or-later and the tool reports GPL3-or-later. Test-only native tools do not become production dependencies.
Authored input, generator and framing audit use the repository license. Native full-file proof does not establish
Windows restoration, named-stream semantics, signatures or unsupported codec compatibility.
