#!/usr/bin/env python3
"""Authored wire variants, checked by native Kubo; separate from genuine importer output."""
import argparse
import base64
import hashlib
import json
import os
import pathlib
import platform
import subprocess
import tarfile
import tempfile


def uint(value):
    out = bytearray()
    while value >= 128:
        out.append((value & 127) | 128)
        value >>= 7
    out.append(value)
    return bytes(out)


def field(number, value):
    if isinstance(value, int):
        return uint(number << 3) + uint(value)
    return uint((number << 3) | 2) + uint(len(value)) + value


def cid(codec, body):
    wire = b"\x01" + uint(codec) + b"\x12\x20" + hashlib.sha256(body).digest()
    return wire, "b" + base64.b32encode(wire).decode().rstrip("=").lower()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    archive = args.archive.read_bytes()
    assert platform.machine() in ("aarch64", "arm64")
    assert hashlib.sha256(archive).hexdigest() == "e09237abadd9578d7a73dd2e2b718848b78437cb56e48cc9742b23ce9ebac829"
    with tempfile.TemporaryDirectory(prefix="unixfs-authored-") as temporary:
        directory = pathlib.Path(temporary)
        executable = directory / "ipfs"
        with tarfile.open(args.archive, "r:gz") as package:
            member = package.getmember("kubo/ipfs")
            assert member.isfile()
            executable.write_bytes(package.extractfile(member).read())
        executable.chmod(0o700)
        env = dict(os.environ, IPFS_PATH=str(directory / "repo"), IPFS_LOGGING="error")
        commands = []

        def run(*arguments):
            result = subprocess.run([str(executable), "--offline", *arguments], env=env, capture_output=True, check=True, timeout=60)
            commands.append({"arguments": list(arguments), "stderr": result.stderr.decode("utf-8", "replace")})
            return result.stdout

        run("init", "--profile=test")
        leaf = b"leaf-data", b""
        leaves = [(cid(0x55, value)[0], value) for value in leaf]
        # Distinct no-inline interoperability cases: retained original inline cases exposed a native omission.
        head = b""
        expected = head + leaf[0] + leaf[0]
        # Three links: repeated nonempty child and a zero-length child. Tsize is intentionally only a wrong hint.
        links = b"".join(field(2, field(1, leaves[index][0]) + field(3, 999999)) for index in [0, 0, 1])
        data = field(1, 2) + field(2, head) + field(3, len(expected))
        expanded = data + b"".join(field(4, size) for size in [len(leaf[0]), len(leaf[0]), 0])
        packed = data + field(4, uint(len(leaf[0])) + uint(len(leaf[0])) + uint(0))
        mixed = data + field(4, len(leaf[0])) + field(4, uint(len(leaf[0])) + uint(0))
        results = []
        for name, inner, first in [("links-first-expanded-no-inline", expanded, False), ("data-first-packed-no-inline", packed, True), ("data-first-mixed-no-inline", mixed, True)]:
            outer = field(1, inner)
            body = outer + links if first else links + outer
            wire, text = cid(0x70, body)
            header = b"\xa2\x65roots\x81\xd8\x2a\x58" + bytes([len(wire) + 1]) + b"\x00" + wire + b"\x67version\x01"
            blocks = [(wire, body), *leaves]
            car = uint(len(header)) + header + b"".join(uint(len(c) + len(b)) + c + b for c, b in blocks)
            path = directory / (name + ".car")
            path.write_bytes(car)
            run("dag", "import", "--pin-roots=false", str(path))
            actual = run("cat", text)
            if actual != expected:
                raise AssertionError(json.dumps({"variant": name, "cid": text, "actualBytes": len(actual), "expectedBytes": len(expected), "actualBase64": base64.b64encode(actual).decode(), "expectedBase64": base64.b64encode(expected).decode()}))
            part = run("cat", "--offset=5", "--length=13", text)
            if part != expected[5:18]:
                raise AssertionError(json.dumps({"variant": name, "range": [5, 13], "actualBase64": base64.b64encode(part).decode(), "expectedBase64": base64.b64encode(expected[5:18]).decode()}))
            results.append({"name": name, "cid": text, "base64": base64.b64encode(body).decode(),
                            "car": base64.b64encode(car).decode(), "original": base64.b64encode(expected).decode(),
                            "blocks": [{"cid": cid(0x55, b)[1] if i else text, "base64": base64.b64encode(b).decode()} for i, (c, b) in enumerate(blocks)],
                            "nativeCompleteExact": True, "nativeRangeExact": True})
        args.output.write_text(json.dumps({"evidenceProfile": "authored wire variants imported and consumed by native Kubo; not genuine importer-produced topology", "version": run("version", "--all").decode(), "variants": results, "commands": commands}, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
