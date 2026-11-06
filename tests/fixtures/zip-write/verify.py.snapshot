"""Independent consumer: CPython standard-library zipfile, no project parsing code.

Usage from repository root:
  deno run --no-check tests/fixtures/zip-write/produce.ts | python3 tests/fixtures/zip-write/verify.py

The authored expected names/payloads below are the oracle. The script checks the
candidate output's flags, descriptors, local extents and directory through an
independent parser, rather than regenerating expected values with the writer.
"""
import hashlib
import io
import json
import platform
import struct
import sys
import zipfile

archive = sys.stdin.buffer.read(1024 * 1024 + 1)
assert len(archive) <= 1024 * 1024, "fixture unexpectedly exceeded 1 MiB"
expected = {
    "folder/": b"",
    "folder/é.txt": b"first second\n",
    "empty.txt": b"",
    "binary.bin": bytes([0, 255, 1, 128]),
}
with zipfile.ZipFile(io.BytesIO(archive)) as reader:
    assert reader.namelist() == list(expected)
    assert reader.testzip() is None
    for info in reader.infolist():
        assert reader.read(info) == expected[info.filename]
        assert info.compress_type == zipfile.ZIP_STORED
        assert info.flag_bits == 0x0808
        assert info.date_time == (1980, 1, 1, 0, 0, 0)
        name_length, extra_length = struct.unpack_from("<HH", archive, info.header_offset + 26)
        at = info.header_offset + 30 + name_length + extra_length + info.compress_size
        signature, crc, compressed, plain = struct.unpack_from("<IIII", archive, at)
        assert signature == 0x08074B50
        assert (crc, compressed, plain) == (info.CRC, info.compress_size, info.file_size)
print(json.dumps({
    "consumer": "CPython zipfile", "version": platform.python_version(),
    "entries": len(expected), "bytes": len(archive),
    "sha256": hashlib.sha256(archive).hexdigest(), "result": "passed",
}))
