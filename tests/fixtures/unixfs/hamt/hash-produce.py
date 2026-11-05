#!/usr/bin/env python3
"""Execute pinned original public-domain MurmurHash3, without candidate imports."""
import argparse
import base64
import ctypes
import hashlib
import json
import pathlib
import platform
import subprocess
import tempfile

COMMIT = "07bb4de10a63e8cc2e1724865454eba635742383"
SOURCES = {"MurmurHash3.cpp": "30f121ed155ebf336af398aabb7d8d157afdfafc8d981e7b48d2a1ceb4b63e4e",
           "MurmurHash3.h": "9af2003e3885c841fa0ac08cb5d5f31541ee9d793f8a9c4a4f771f43fb0d6f41"}
WRAPPER = '''#include "MurmurHash3.h"
#include <stdint.h>
extern "C" void hamt_hash(const void *bytes, int length, uint8_t *output) {
  uint64_t words[2];
  MurmurHash3_x64_128(bytes, length, 0, words);
  for (int i = 0; i < 8; i++) output[i] = uint8_t(words[0] >> (56 - i * 8));
}
'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--compiler", default="/usr/bin/clang++")
    args = parser.parse_args()
    commands = []

    def run(command):
        result = subprocess.run(command, capture_output=True, check=True, timeout=60)
        commands.append({"arguments": command, "stdout": result.stdout.decode(), "stderr": result.stderr.decode()})
        return result.stdout.decode()

    version = run([args.compiler, "--version"])
    with tempfile.TemporaryDirectory(prefix="hamt-reference-") as temporary:
        root = pathlib.Path(temporary)
        for name, expected in SOURCES.items():
            data = (args.source / name).read_bytes()
            assert hashlib.sha256(data).hexdigest() == expected, name
            (root / name).write_bytes(data)
        (root / "wrapper.cpp").write_text(WRAPPER)
        library = root / ("reference.dylib" if platform.system() == "Darwin" else "reference.so")
        run([args.compiler, "-std=c++11", "-O2", "-fPIC", "-shared", str(root / "MurmurHash3.cpp"),
             str(root / "wrapper.cpp"), "-o", str(library)])
        native = ctypes.CDLL(str(library))
        native.hamt_hash.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_uint8)]
        native.hamt_hash.restype = None
        values = [bytes(range(length)) for length in range(130)]
        values += [name.encode() for name in ["file-000.txt", "caf\u00e9.txt", "space name.txt", "%2F.txt", "a" * 4096]]
        vectors = []
        for value in values:
            source = ctypes.create_string_buffer(value)
            output = (ctypes.c_uint8 * 8)()
            native.hamt_hash(source, len(value), output)
            vectors.append({"input": base64.b64encode(value).decode(), "digest": bytes(output).hex()})
        args.output.write_text(json.dumps({"evidenceProfile": "executed original public-domain x64-128 reference; seed zero; first word serialized big-endian by explicit test-only wrapper",
            "sourceCommit": COMMIT, "sources": SOURCES, "wrapper": WRAPPER, "compiler": version,
            "architecture": platform.machine(), "commands": commands, "vectors": vectors}, indent=2) + "\n")


if __name__ == "__main__":
    main()
