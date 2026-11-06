"""Produce genuine GNU sparse TAR profiles and independent complete logical bytes.

Tool paths are explicit. Python tarfile and libarchive must both reconstruct every
original byte; 7zz results are preserved separately if its sparse support differs.
"""
import argparse
import base64
import hashlib
import json
import pathlib
import subprocess
import tarfile
import tempfile


def run(command, cwd=None):
    result = subprocess.run(command, cwd=cwd, capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError(f"{command!r}: {result.returncode}\n{result.stdout!r}\n{result.stderr!r}")
    return result.stdout


def encoded(data):
    return {"base64": base64.b64encode(data).decode(), "sha256": hashlib.sha256(data).hexdigest()}


parser = argparse.ArgumentParser()
parser.add_argument("--tar", required=True)
parser.add_argument("--bsdtar", required=True)
parser.add_argument("--seven", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
tools = {"tar": run([args.tar, "--version"]).decode(), "bsdtar": run([args.bsdtar, "--version"]).decode(),
         "seven": run([args.seven, "i"]).decode()}
fixtures = []
with tempfile.TemporaryDirectory(prefix="opfs-tar-sparse-") as temp:
    root = pathlib.Path(temp)
    authored = {"all-hole.bin": (1048576, []), "leading.bin": (262144, [(131072, b"late extent" * 80)]),
                "trailing.bin": (262144, [(0, b"first extent" * 80)]),
                "many.bin": (1048576, [(i * 16384, bytes([i % 251 + 1]) * 513) for i in range(60)]),
                "empty.bin": (0, []), "plain.txt": (21, [(0, b"ordinary TAR payload\n")])}
    # Avoid a producer length discrepancy: the file's physical API defines the
    # logical original bytes, which are retained before any archive is created.
    originals = {}
    for name, (size, extents) in authored.items():
        path = root / name
        with path.open("wb") as file:
            file.truncate(size)
            for offset, body in extents:
                file.seek(offset)
                file.write(body)
        originals[name] = path.read_bytes()
    for version in ("1.0", "0.1", "0.0"):
        archive = root / f"sparse-{version}.tar"
        command = [args.tar, "--format=pax", f"--sparse-version={version}", "--sparse", "-cf", str(archive), *authored]
        run(command, root)
        output = {"profile": version, "archive": encoded(archive.read_bytes()), "command": command[1:], "payloads": {}}
        destination = root / f"extract-{version}"
        destination.mkdir()
        run([args.bsdtar, "-xf", str(archive), "-C", str(destination)], root)
        with tarfile.open(archive, "r:") as decoded:
            for name, original in originals.items():
                member = decoded.extractfile(name)
                assert member is not None and member.read() == original, (version, name, "Python")
                assert (destination / name).read_bytes() == original, (version, name, "libarchive")
                probe = subprocess.run([args.seven, "x", "-tTar", "-so", "-spd", str(archive), name],
                                       cwd=root, capture_output=True, timeout=60)
                output["payloads"][name] = {**encoded(original), "seven": {
                    "status": probe.returncode, "matches": probe.returncode == 0 and probe.stdout == original,
                    "outputSha256": hashlib.sha256(probe.stdout).hexdigest(), "stderr": probe.stderr.decode()}}
        fixtures.append(output)
pathlib.Path(args.output).write_text(json.dumps({"tools": tools, "fixtures": fixtures}, indent=2) + "\n")
