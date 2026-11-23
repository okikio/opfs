#!/usr/bin/env python3
"""Genuine uncompressed WIM fixtures; test-only Debian wimtools and7-Zip.

Run in the disposable bounded producer container. The parent copies output
only after this checked process exits0. No candidate reader establishes oracles.
"""
import argparse
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
    images = [
        {"hello.txt": b"authored WIM first image\n", "nested/data.bin": bytes(range(256)) * 3,
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
                command += ["--compress=none"]
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
        result = {
            "producer": run([wim, "--version"]).stdout.decode(),
            "consumer": run([seven, "i"]).stdout.decode(),
            "source": {"wimlibRevision": "cd5e231c348c255ae5088873b5a66ee0eb96fa07",
                       "microsoftRtfSha256": "397772cca016508194d13ac860633b56b4f2f94cbf7476e2112f557ad61cfe0c"},
            "base64": base64.b64encode(data).decode(), "sha256": hashlib.sha256(data).hexdigest(),
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
