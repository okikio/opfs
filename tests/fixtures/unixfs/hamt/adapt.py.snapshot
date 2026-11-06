#!/usr/bin/env python3
"""Authored depth/padding profiles consumed by native Kubo, not importer output."""
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
    return uint(number << 3) + uint(value) if isinstance(value, int) else uint((number << 3) | 2) + uint(len(value)) + value


def cid(codec, body):
    wire = b"\x01" + uint(codec) + b"\x12\x20" + hashlib.sha256(body).digest()
    return wire, "b" + base64.b32encode(wire).decode().rstrip("=").lower()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=pathlib.Path, required=True)
    parser.add_argument("--hash-reference", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    archive = args.archive.read_bytes()
    assert platform.machine() in ("aarch64", "arm64")
    assert hashlib.sha256(archive).hexdigest() == "e09237abadd9578d7a73dd2e2b718848b78437cb56e48cc9742b23ce9ebac829"
    reference = json.loads(args.hash_reference.read_text())
    assert reference["sourceCommit"] == "07bb4de10a63e8cc2e1724865454eba635742383"
    name = b"file-000.txt"
    matches = [item for item in reference["vectors"] if base64.b64decode(item["input"]) == name]
    assert len(matches) == 1
    route = bytes.fromhex(matches[0]["digest"])
    assert len(route) == 8
    with tempfile.TemporaryDirectory(prefix="hamt-authored-") as temporary:
        root = pathlib.Path(temporary)
        executable = root / "ipfs"
        with tarfile.open(args.archive, "r:gz") as package:
            member = package.getmember("kubo/ipfs")
            assert member.isfile()
            executable.write_bytes(package.extractfile(member).read())
        executable.chmod(0o700)
        env = dict(os.environ, IPFS_PATH=str(root / "repo"), IPFS_LOGGING="error")
        commands = []

        def run(*arguments, refuse=False):
            result = subprocess.run([str(executable), "--offline", *arguments], env=env, capture_output=True, timeout=60)
            commands.append({"arguments": list(arguments), "exitCode": result.returncode,
                             "stderr": result.stderr.decode("utf-8", "replace")})
            if not refuse:
                result.check_returncode()
            return result

        run("init", "--profile=test")
        original = b"Authored HAMT depth boundary original bytes.\n"
        variants = []
        for label, levels, padded in [("depth-eight-trimmed", 8, False), ("depth-eight-padded", 8, True),
                                      ("depth-nine-refused", 9, False)]:
            leaf_wire, leaf_cid = cid(0x55, original)
            blocks = [(leaf_wire, leaf_cid, original)]
            child_wire = leaf_wire
            for depth in reversed(range(levels)):
                bucket = route[depth] if depth < 8 else 0
                bitmap = bytearray(32)
                bitmap[31 - bucket // 8] |= 1 << (bucket % 8)
                if not padded:
                    bitmap = bytes(bitmap).lstrip(b"\x00")
                link_name = f"{bucket:02X}".encode() + (name if depth == levels - 1 else b"")
                link = field(2, field(1, child_wire) + field(2, link_name) + field(3, 999999))
                inner = field(1, 5) + field(2, bytes(bitmap)) + field(5, 0x22) + field(6, 256)
                body = link + field(1, inner)
                wire, text = cid(0x70, body)
                blocks.append((wire, text, body))
                child_wire = wire
            root_wire, root_cid, _ = blocks[-1]
            header = b"\xa2\x65roots\x81\xd8\x2a\x58" + bytes([len(root_wire) + 1]) + b"\x00" + root_wire + b"\x67version\x01"
            car = uint(len(header)) + header + b"".join(uint(len(wire) + len(body)) + wire + body for wire, _, body in reversed(blocks))
            path = root / (label + ".car")
            path.write_bytes(car)
            run("dag", "import", "--pin-roots=false", str(path))
            result = run("cat", root_cid + "/" + name.decode(), refuse=levels == 9)
            if levels == 9:
                assert result.returncode != 0 and b"sharded directory too deep" in result.stderr, (label, result.stdout, result.stderr)
            else:
                assert result.stdout == original, (label, result.stdout, original)
                part = run("cat", "--offset=5", "--length=13", root_cid + "/" + name.decode()).stdout
                assert part == original[5:18], (label, part, original[5:18])
            variants.append({"name": label, "levels": levels, "padded": padded, "rootCid": root_cid,
                             "lookupName": name.decode(), "route": route.hex(), "original": base64.b64encode(original).decode(),
                             "car": base64.b64encode(car).decode(), "nativeExitCode": result.returncode,
                             "nativeStdout": base64.b64encode(result.stdout).decode(), "nativeStderr": result.stderr.decode(),
                             "blocks": [{"cid": text, "base64": base64.b64encode(body).decode()} for _, text, body in blocks]})
        args.output.write_text(json.dumps({"evidenceProfile": "authored degenerate shard topology and bitmap padding; native Kubo full/range reads and hash-exhaustion refusal; not genuine importer output",
                                          "version": run("version", "--all").stdout.decode(),
                                          "hashReferenceSha256": hashlib.sha256(args.hash_reference.read_bytes()).hexdigest(),
                                          "variants": variants, "commands": commands}, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
