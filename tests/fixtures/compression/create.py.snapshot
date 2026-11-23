"""Independent gzip/zlib producer; stdlib only, never imported by production.

The compressed TAR uses the independent tarfile PAX fixture from the sibling
directory. Run tar/create.py first when intentionally refreshing both fixtures.
"""
import base64
import gzip
import hashlib
import json
import pathlib
import platform
import struct
import zlib

root = pathlib.Path(__file__).parent
tar = json.loads((root.parent / "tar" / "independent.json").read_text())["pax"]
payload = bytes(range(256)) + b"independent compression payload\x00\xff"


def encode(data, kind):
    if kind == "gzip":
        return gzip.compress(data, mtime=0)
    compressor = zlib.compressobj(level=6, wbits=15 if kind == "deflate" else -15)
    return compressor.compress(data) + compressor.flush()


result = {"producer": "Python " + platform.python_version() + " stdlib gzip/zlib " + zlib.ZLIB_VERSION,
          "payload": base64.b64encode(payload).decode(), "formats": {}}
ordinary = gzip.compress(payload, mtime=0)
header = bytearray(ordinary[:10])
header[3] = 0x1f  # FTEXT, FHCRC, FEXTRA, FNAME, FCOMMENT.
header += struct.pack("<H", 4) + b"X\x00Y\xff" + b"fixture.bin\0" + b"independent producer\0"
fhcrc_offset = len(header)
header += struct.pack("<H", zlib.crc32(header) & 0xffff)
with_headers = bytes(header) + ordinary[10:]
assert zlib.decompress(with_headers, wbits=31) == payload
result["gzipHeaders"] = {"bytes": base64.b64encode(with_headers).decode(),
                         "sha256": hashlib.sha256(with_headers).hexdigest(), "fhcrcOffset": fhcrc_offset}
for kind in ["gzip", "deflate", "deflate-raw"]:
    encoded = encode(payload, kind)
    expanded = encode(b"A" * (1024 * 1024), kind)
    result["formats"][kind] = {"bytes": base64.b64encode(encoded).decode(), "sha256": hashlib.sha256(encoded).hexdigest(),
                               "empty": base64.b64encode(encode(b"", kind)).decode(),
                               "expanded": base64.b64encode(expanded).decode(), "expandedSize": 1024 * 1024,
                               "tar": base64.b64encode(encode(base64.b64decode(tar["archive"]), kind)).decode()}
root.joinpath("independent.json").write_text(json.dumps(result, indent=2) + "\n")
