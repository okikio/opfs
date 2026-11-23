"""Produce signed Debian CLI fixtures without importing candidate codec code.

Run inside the disposable tool container with brotli and zstd installed. The
same native CLIs decode their output and compare the complete authored bytes;
the TypeScript tests separately exercise the package wrapper's native codecs.
"""

import argparse
import base64
import hashlib
import json
from pathlib import Path
import subprocess


def command(arguments, data=None):
    """Bound native tool execution and retain failures instead of partial output."""
    return subprocess.run(
        arguments,
        input=data,
        capture_output=True,
        check=True,
        timeout=30,
    ).stdout


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", default=str(Path(__file__).with_name("native.json")))
arguments = parser.parse_args()
payload = bytes(range(256)) * 64 + b"native-codec\n" * 100
result = {
    "producer": "signed Debian brotli and zstd CLIs",
    "packages": command([
        "dpkg-query", "-W", "-f=${Package} ${Version}\n", "brotli", "zstd",
    ]).decode(),
    "payload": base64.b64encode(payload).decode(),
    "formats": {},
}
for name, encode in [("brotli", ["brotli", "-c"]), ("zstd", ["zstd", "-q", "-c"])]:
    encoded = command(encode, payload)
    empty = command(encode, b"")
    assert command([name, "-d", "-c"], encoded) == payload, name
    result["formats"][name] = {
        "bytes": base64.b64encode(encoded).decode(),
        "empty": base64.b64encode(empty).decode(),
        "sha256": hashlib.sha256(encoded).hexdigest(),
    }
Path(arguments.output).write_text(json.dumps(result, indent=2) + "\n")
