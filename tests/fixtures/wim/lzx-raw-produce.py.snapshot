#!/usr/bin/env python3
"""Authored raw+verbatim WIM adaptation checked by genuine native consumers.

The raw block is authored from the pinned WIM grammar. Its successor is produced
by libwim's native LZX compressor. This is not a genuine wimlib raw-block output.
Only the changed resource is appended; logical bytes, hashes and filenames stay
identical to the retained genuine LZX fixture. No candidate code is invoked.
"""
import argparse
import base64
import ctypes
import ctypes.util
import hashlib
import json
import pathlib
import shutil
import struct
import subprocess
import tempfile


def run(command):
    return subprocess.run(command, capture_output=True, check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    original = args.input.read_bytes()
    fixture = json.loads(original)
    resource = next(resource for resource in fixture["nativeResources"] if resource["decoded"] == 200000)
    expected = base64.b64decode(resource["chunks"][0]["decoded"])
    assert expected == b"A" * 32768
    lib = ctypes.CDLL(ctypes.util.find_library("wim"))
    lib.wimlib_create_compressor.argtypes = [ctypes.c_int, ctypes.c_size_t, ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p)]
    lib.wimlib_compress.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p]
    lib.wimlib_compress.restype = ctypes.c_size_t
    lib.wimlib_free_compressor.argtypes = [ctypes.c_void_p]
    lib.wimlib_create_decompressor.argtypes = [ctypes.c_int, ctypes.c_size_t, ctypes.POINTER(ctypes.c_void_p)]
    lib.wimlib_decompress.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p]
    lib.wimlib_free_decompressor.argtypes = [ctypes.c_void_p]
    compressor, decompressor = ctypes.c_void_p(), ctypes.c_void_p()
    assert lib.wimlib_create_compressor(2, 32768, 50, ctypes.byref(compressor)) == 0
    try:
        assert lib.wimlib_create_decompressor(2, 32768, ctypes.byref(decompressor)) == 0
        try:
            native_input = b"A" * 32763
            buffer = ctypes.create_string_buffer(32768)
            count = lib.wimlib_compress(native_input, len(native_input), buffer, 32768, compressor)
            assert count > 0
            native_packed = buffer.raw[:count]
            # WIM header: type3, explicit-size bit0, length5, zero word alignment.
            bits = "0110" + format(5, "016b") + "0" * 12
            header = b"".join(int(bits[i:i + 16], 2).to_bytes(2, "little") for i in range(0, 32, 16))
            raw = header + struct.pack("<III", 1, 1, 1) + b"A" * 5 + b"\0"
            combined = raw + native_packed
            assert len(combined) < len(expected)
            decoded = ctypes.create_string_buffer(len(expected))
            assert lib.wimlib_decompress(combined, len(combined), decoded, len(expected), decompressor) == 0
            assert decoded.raw == expected
        finally:
            lib.wimlib_free_decompressor(decompressor)
    finally:
        lib.wimlib_free_compressor(compressor)
    resource["chunks"][0] = {"packed": base64.b64encode(combined).decode(), "decoded": base64.b64encode(expected).decode(),
                              "compressed": True, "expected": len(expected)}
    chunks = [base64.b64decode(chunk["packed"]) for chunk in resource["chunks"]]
    offsets = []
    current = 0
    for chunk in chunks[:-1]:
        current += len(chunk)
        offsets.append(current)
    packed_resource = b"".join(struct.pack("<I", offset) for offset in offsets) + b"".join(chunks)
    archive = bytearray(base64.b64decode(fixture["base64"]))
    archive.extend(b"\0" * (-len(archive) % 8))
    offset = len(archive)
    archive.extend(packed_resource)
    table_size = int.from_bytes(archive[48:55], "little")
    table_offset = int.from_bytes(archive[56:64], "little")
    matches = [at for at in range(table_offset, table_offset + table_size, 50) if archive[at + 30:at + 50].hex() == resource["sha1"]]
    assert len(matches) == 1
    at = matches[0]
    assert archive[at + 7] == 4
    archive[at:at + 7] = len(packed_resource).to_bytes(7, "little")
    struct.pack_into("<Q", archive, at + 8, offset)
    resource.update(offset=offset, stored=len(packed_resource))
    wim, seven = shutil.which("wimlib-imagex"), shutil.which("7zz") or shutil.which("7z")
    assert wim and seven
    consumers = []
    with tempfile.TemporaryDirectory(prefix="opfs-lzx-authored-") as directory:
        root = pathlib.Path(directory)
        path = root / "raw-and-verbatim.wim"
        path.write_bytes(archive)
        verification = run([wim, "verify", str(path)])
        for image in fixture["images"]:
            destination = root / str(image["index"])
            destination.mkdir()
            run([wim, "apply", str(path), str(image["index"]), str(destination), "--no-acls"])
            for file in image["files"]:
                expected_file = base64.b64decode(file["base64"])
                assert (destination / file["path"]).read_bytes() == expected_file
                extracted = run([seven, "x", "-so", "-y", str(path), str(image["index"]) + "/" + file["path"]])
                assert extracted.stdout == expected_file
                consumers.append({"image": image["index"], "path": file["path"], "exact": True, "exitCode": extracted.returncode})
    result = {"evidenceProfile": "authored-raw-prefix-and-native-verbatim-successor",
              "originalFixtureSha256": hashlib.sha256(original).hexdigest(), "originalWimSha256": fixture["sha256"],
              "base64": base64.b64encode(archive).decode(), "sha256": hashlib.sha256(archive).hexdigest(),
              "nativeResources": fixture["nativeResources"], "images": fixture["images"],
              "rawPrefix": base64.b64encode(raw).decode(), "nativeSuccessor": base64.b64encode(native_packed).decode(),
              "nativeFullChunkExact": True, "consumers": consumers,
              "verify": {"exitCode": verification.returncode, "stdout": verification.stdout.decode(), "stderr": verification.stderr.decode()}}
    args.output.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
