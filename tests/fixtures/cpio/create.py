"""Produce fixtures with an independent installed CPIO implementation, never OPFS.

Run: python3 tests/fixtures/cpio/create.py --cpio /usr/bin/cpio --formats newc
GNU cpio supports both requested profiles: --formats newc crc.
The JSON includes producer version, command, encoded bytes, SHA256 and a full
payload oracle derived from input files rather than an archive reader.
"""
import argparse
import base64
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("--cpio", default="cpio")
parser.add_argument("--formats", nargs="+", default=["newc", "crc"])
parser.add_argument("--output", default=str(pathlib.Path(__file__).with_name("independent.json")))
args = parser.parse_args()
version = subprocess.run([args.cpio, "--version"], check=True, capture_output=True, text=True).stdout.strip()
result = {}
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    (root / "folder").mkdir()
    payload = bytes(range(256)) + b"independent CPIO payload\x00\xff"
    large = bytes(range(256)) * 512
    (root / "folder/data.bin").write_bytes(payload)
    (root / "large.bin").write_bytes(large)
    (root / "alias-first").write_bytes(payload)
    os.link(root / "alias-first", root / "alias-last")
    (root / "empty").write_bytes(b"")
    os.symlink("folder/data.bin", root / "symbolic")
    names = ["folder", "folder/data.bin", "large.bin", "alias-first", "alias-last", "empty", "symbolic"]
    expected = []
    for name in names:
        path = root / name
        if name == "symbolic":
            kind, body = "symbolic-link", b"folder/data.bin"
        elif path.is_dir():
            kind, body = "directory", b""
        else:
            kind, body = "file", path.read_bytes()
        if kind != "symbolic-link":
            os.chmod(path, 0o755 if kind == "directory" else 0o644)
            os.utime(path, (0, 0))
        expected.append({"name": name, "kind": kind, "body": base64.b64encode(body).decode()})
    for profile in args.formats:
        command = [args.cpio, "-o", "-H", profile]
        produced = subprocess.run(command, input=("\n".join(names) + "\n").encode(), cwd=root,
                                  check=True, capture_output=True, timeout=10).stdout
        result[profile] = {"producer": version, "command": command, "sha256": hashlib.sha256(produced).hexdigest(),
                           "archive": base64.b64encode(produced).decode(), "entries": expected}
pathlib.Path(args.output).write_text(json.dumps(result, indent=2) + "\n")
