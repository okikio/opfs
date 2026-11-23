#!/usr/bin/env python3
"""Independent offline Kubo producer and original-byte consumer; no candidate imports.

Copy this script and the pinned ARM64 release archive into a bounded disposable
ARM64 container. Only the requested JSON receipt leaves the container on success.
"""
import argparse
import base64
import hashlib
import json
import os
import pathlib
import platform
import random
import subprocess
import tarfile
import tempfile

ASSET_SHA256 = "e09237abadd9578d7a73dd2e2b718848b78437cb56e48cc9742b23ce9ebac829"
COMMIT = "acc53c093810a8fe9a4bc2f023f0b1e0c1d629b5"


def encoded(value):
    return base64.b64encode(value).decode("ascii")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    assert platform.machine() in ("aarch64", "arm64"), "Pinned producer asset requires ARM64"
    archive = args.archive.read_bytes()
    assert len(archive) == 39040966
    assert hashlib.sha256(archive).hexdigest() == ASSET_SHA256
    with tempfile.TemporaryDirectory(prefix="unixfs-native-") as temporary:
        root = pathlib.Path(temporary)
        executable = root / "ipfs"
        with tarfile.open(args.archive, "r:gz") as package:
            member = package.getmember("kubo/ipfs")
            assert member.isfile() and member.size < 200 * 1024 * 1024
            stream = package.extractfile(member)
            assert stream is not None
            executable.write_bytes(stream.read())
        executable.chmod(0o700)
        environment = dict(os.environ, IPFS_PATH=str(root / "repo"), IPFS_LOGGING="error")
        commands = []

        def run(*arguments):
            command = [str(executable), "--offline", *arguments]
            result = subprocess.run(command, env=environment, capture_output=True, check=True, timeout=90)
            commands.append({"arguments": list(arguments), "stderr": result.stderr.decode("utf-8", "replace")})
            return result.stdout

        run("init", "--profile=test")
        version = run("version", "--all").decode()
        originals = {
            "hello.txt": b"Independent UnixFS original bytes.\n",
            "repeat.bin": b"abcdefgh" * 2048,
            "duplicate.bin": b"abcdefgh" * 2048,
            "empty": b"",
            "unicode/caf\u00e9.txt": "Literal UTF-8 caf\u00e9.\n".encode(),
            "space name.txt": b"spaces are literal metadata\n",
            "Links": b"a directory child named Links\n",
        }
        # A deterministic generator supplies independently authored high-entropy original bytes.
        generator = random.Random(20261105)
        originals["nested/data.bin"] = bytes(generator.randrange(256) for _ in range(20000))
        directory = root / "originals"
        directory.mkdir()
        for name, body in originals.items():
            path = directory / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
        (directory / "shortcut").symlink_to("nested/data.bin")
        profiles = [
            ("cidv1-raw-leaves", ["--cid-version=1", "--raw-leaves=true"]),
            ("cidv0-pb-leaves", ["--cid-version=0", "--raw-leaves=false"]),
            ("metadata", ["--cid-version=1", "--raw-leaves=false", "--mode=416", "--mtime=-12345", "--mtime-nsecs=123456789"]),
        ]
        results = []
        for name, flags in profiles:
            cid = run("add", "--recursive", "--quieter", "--pin=false", "--chunker=size-64", *flags, str(directory)).decode().strip()
            car = run("dag", "export", cid)
            links = run("refs", "--recursive", "--unique", cid).decode().splitlines()
            blocks = []
            for block_cid in dict.fromkeys([cid, *links]):
                body = run("block", "get", block_cid)
                blocks.append({"cid": block_cid, "base64": encoded(body), "size": len(body), "sha256": hashlib.sha256(body).hexdigest()})
            files = []
            for path, expected in originals.items():
                target = cid + "/" + path
                body = run("cat", target)
                assert body == expected, (name, path, "complete original mismatch")
                ranges = []
                if expected:
                    for offset, length in [(0, min(17, len(expected))), (max(0, len(expected) - 17), min(17, len(expected)))]:
                        part = run("cat", "--offset=" + str(offset), "--length=" + str(length), target)
                        assert part == expected[offset:offset + length]
                        ranges.append({"offset": offset, "length": length, "base64": encoded(part)})
                files.append({"path": path, "base64": encoded(expected), "sha256": hashlib.sha256(expected).hexdigest(), "ranges": ranges})
            results.append({"profile": name, "cid": cid, "car": encoded(car), "carSha256": hashlib.sha256(car).hexdigest(), "blocks": blocks, "files": files})
        # Raw-root and single DAG-PB leaf roots are genuine standalone importer results too.
        roots = []
        for raw in [True, False]:
            cid = run("add", "--quieter", "--pin=false", "--cid-version=1", "--raw-leaves=" + str(raw).lower(), str(directory / "hello.txt")).decode().strip()
            body = run("block", "get", cid)
            assert run("cat", cid) == originals["hello.txt"]
            roots.append({"raw": raw, "cid": cid, "base64": encoded(body), "original": encoded(originals["hello.txt"])})
        receipt = {"evidenceProfile": "genuine Kubo importer; native cat full/range comparisons against authored originals before candidate implementation", "sourceCommit": COMMIT,
                   "assetSha256": ASSET_SHA256, "binarySha256": hashlib.sha256(executable.read_bytes()).hexdigest(), "version": version,
                   "architecture": platform.machine(), "profiles": results, "singleRoots": roots, "commands": commands}
        args.output.write_text(json.dumps(receipt, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
