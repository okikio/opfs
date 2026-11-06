#!/usr/bin/env python3
"""Genuine XPRESS-Huffman WIM fixtures; test-only Debian wimtools and7-Zip.

Run in the disposable bounded producer container. The parent copies output
only after this checked process exits0. No candidate reader establishes oracles.
"""
import argparse
import ctypes
import ctypes.util
import random
import struct
import base64
import hashlib
import json
import pathlib
import shutil
import subprocess
import tempfile


def run(args, **options):
    return subprocess.run(args, check=True, capture_output=True, **options)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    wim = shutil.which("wimlib-imagex")
    seven = shutil.which("7zz") or shutil.which("7z")
    assert wim and seven, "Native producer and independent consumer are required"
    random_bytes = random.Random(20261105).randbytes(100000)
    images = [
        {"hello.txt": b"authored WIM first image\n", "random.bin": random_bytes, "long.bin": b"A" * 200000,
         "boundary32767.bin": b"abCD" * 8191 + b"XYZ", "boundary32768.bin": b"abcd" * 8192, "boundary32769.bin": b"abcd" * 8192 + b"!", "nested/data.bin": bytes(range(256)) * 3,
         "duplicate.bin": bytes(range(256)) * 3, "empty": b"", "unicode/caf\u00e9.txt": b"UTF16 filename oracle\n"},
        {"hello.txt": b"authored WIM second image\n", "shared.bin": bytes(range(256)) * 3,
         "empty": b"", "different.txt": b"new image member\n"},
    ]
    with tempfile.TemporaryDirectory(prefix="opfs-wim-fixture-") as directory:
        root = pathlib.Path(directory)
        archive = root / "two-images.wim"
        receipts = []
        for index, expected in enumerate(images, 1):
            folder = root / str(index)
            folder.mkdir()
            for name, value in expected.items():
                target = folder / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(value)
            command = [wim, "capture" if index == 1 else "append", str(folder), str(archive), "Image" + str(index), "--no-acls"]
            if index == 1:
                command += ["--compress=xpress", "--chunk-size=32768"]
            result = run(command)
            receipts.append({"operation": command[1], "exitCode": result.returncode,
                             "stdout": result.stdout.decode(), "stderr": result.stderr.decode()})
        verification = run([wim, "verify", str(archive)])
        listing = run([seven, "l", "-slt", str(archive)])
        consumers = []
        for index, expected in enumerate(images, 1):
            destination = root / ("extracted" + str(index))
            destination.mkdir()
            run([wim, "apply", str(archive), str(index), str(destination), "--no-acls"])
            for name, value in expected.items():
                assert (destination / name).read_bytes() == value
                path = str(index) + "/" + name
                result = run([seven, "x", "-so", "-y", str(archive), path])
                assert result.stdout == value, (path, result.stderr, result.stdout)
                consumers.append({"image": index, "path": name, "sevenPath": path,
                                  "exitCode": result.returncode, "exact": True})
        data = archive.read_bytes()
        # Direct native API oracle proves complete decoded resource bytes, including metadata.
        lib = ctypes.CDLL(ctypes.util.find_library("wim"))
        lib.wimlib_create_decompressor.argtypes = [ctypes.c_int, ctypes.c_size_t, ctypes.POINTER(ctypes.c_void_p)]
        lib.wimlib_decompress.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p]
        lib.wimlib_free_decompressor.argtypes = [ctypes.c_void_p]
        codec = ctypes.c_void_p()
        assert lib.wimlib_create_decompressor(1, 32768, ctypes.byref(codec)) == 0
        native_resources = []
        try:
            table_size = int.from_bytes(data[48:55], "little")
            table_offset = int.from_bytes(data[56:64], "little")
            assert not data[55] & 4, "This fixture expects a directly stored lookup table"
            for at in range(table_offset, table_offset + table_size, 50):
                size = int.from_bytes(data[at:at + 7], "little")
                flags = data[at + 7]
                start, decoded = struct.unpack_from("<QQ", data, at + 8)
                raw = data[start:start + size]
                chunks, output = [], bytearray()
                if flags & 4:
                    count = (decoded + 32767) // 32768
                    width = 4 if decoded < 2**32 else 8
                    table_length = (count - 1) * width
                    offsets = [0] + [int.from_bytes(raw[i:i + width], "little") for i in range(0, table_length, width)] + [size - table_length]
                    for index in range(count):
                        packed = raw[table_length + offsets[index]:table_length + offsets[index + 1]]
                        expected = min(32768, decoded - index * 32768)
                        dest = ctypes.create_string_buffer(expected)
                        if len(packed) == expected:
                            body = packed
                        else:
                            assert lib.wimlib_decompress(packed, len(packed), dest, expected, codec) == 0
                            body = dest.raw
                        chunks.append({"packed": base64.b64encode(packed).decode(), "decoded": base64.b64encode(body).decode(),
                                       "compressed": len(packed) != expected, "expected": expected})
                        output.extend(body)
                else:
                    output.extend(raw)
                assert len(output) == decoded
                expected_sha1 = data[at + 30:at + 50].hex()
                assert hashlib.sha1(output).hexdigest() == expected_sha1
                native_resources.append({"flags": flags, "offset": start, "stored": size, "decoded": decoded,
                                         "sha1": expected_sha1, "body": base64.b64encode(output).decode(), "chunks": chunks})
        finally:
            lib.wimlib_free_decompressor(codec)

        result = {
            "producer": run([wim, "--version"]).stdout.decode(),
            "consumer": run([seven, "i"]).stdout.decode(),
            "source": {"wimlibRevision": "cd5e231c348c255ae5088873b5a66ee0eb96fa07",
                       "microsoftRtfSha256": "397772cca016508194d13ac860633b56b4f2f94cbf7476e2112f557ad61cfe0c"},
            "nativeResources": native_resources, "base64": base64.b64encode(data).decode(), "sha256": hashlib.sha256(data).hexdigest(),
            "capture": receipts, "verify": {"exitCode": verification.returncode,
              "stdout": verification.stdout.decode(), "stderr": verification.stderr.decode()},
            "listing": listing.stdout.decode(), "consumers": consumers,
            "images": [{"index": index, "name": "Image" + str(index), "files": [
                {"path": name, "base64": base64.b64encode(value).decode(),
                 "sha1": hashlib.sha1(value).hexdigest()} for name, value in expected.items()
            ]} for index, expected in enumerate(images, 1)],
        }
    args.output.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
