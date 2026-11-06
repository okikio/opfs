#!/usr/bin/env python3
"""Retain genuine native XAR bytes and independent full-member byte oracles.

Python and the two native tools are test-only. Native times, EAs and ownership
metadata remain unchanged, so regeneration changes artifact hashes.
"""
import base64
import hashlib
import json
import pathlib
import struct
import subprocess
import tempfile
import zlib
import xml.etree.ElementTree as ET

HERE = pathlib.Path(__file__).resolve().parent
EXPECTED = {
    "hello.txt": b"authored XAR oracle\n",
    "nested/data.bin": bytes(range(256)) * 3,
    "empty": b"",
}


def run(args, **options):
    return subprocess.run(args, check=True, capture_output=True, **options)


def check_archive(data):
    magic, header, version, packed, decoded, code = struct.unpack(">IHHQQI", data[:28])
    assert (magic, header, version) == (0x78617221, 28, 1)
    xml = zlib.decompress(data[header:header + packed])
    assert len(xml) == decoded
    toc = ET.fromstring(xml).find("toc")
    heap = data[header + packed:]
    checksum = toc.find("checksum")
    algorithm = {1: "sha1", 3: "sha256", 4: "sha512"}[code]
    assert checksum.attrib["style"] == algorithm
    digest = hashlib.new(algorithm, data[header:header + packed]).digest()
    offset = int(checksum.findtext("offset"))
    size = int(checksum.findtext("size"))
    assert heap[offset:offset + size] == digest
    seen = {}

    def files(node, prefix=""):
        for file in node.findall("file"):
            path = prefix + file.findtext("name")
            body = file.find("data")
            if body is not None:
                offset = int(body.findtext("offset"))
                length = int(body.findtext("length"))
                encoded = heap[offset:offset + length]
                encoding = body.find("encoding").attrib["style"]
                payload = zlib.decompress(encoded) if encoding == "application/x-gzip" else encoded
                assert len(payload) == int(body.findtext("size"))
                for tag, content in (("archived-checksum", encoded), ("extracted-checksum", payload)):
                    checksum = body.find(tag)
                    assert hashlib.new(checksum.attrib["style"], content).hexdigest() == checksum.text
                seen[path] = payload
            elif file.findtext("type") == "file":
                seen[path] = b""
            files(file, path + "/")

    files(toc)
    assert seen == EXPECTED, seen.keys()
    return {"headerBytes": header, "checksumCode": code, "tocBytes": decoded}


def main():
    objects = []
    plans = [
        ("xar", compression, algorithm)
        for compression in ("none", "gzip")
        for algorithm in ("sha1", "sha256", "sha512")
    ] + [("bsdtar", "gzip", "sha1")]
    with tempfile.TemporaryDirectory(prefix="opfs-xar-fixture-") as directory:
        root = pathlib.Path(directory)
        for name, value in EXPECTED.items():
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(value)
        for producer, compression, algorithm in plans:
            archive = root / (producer + "-" + compression + "-" + algorithm + ".xar")
            if producer == "xar":
                run([
                    "/usr/bin/xar", "-cf", str(archive), "--compression=" + compression,
                    "--toc-cksum=" + algorithm, "--file-cksum=" + algorithm, *EXPECTED,
                ], cwd=root)
            else:
                run(["/usr/bin/bsdtar", "-cf", str(archive), "--format=xar", *EXPECTED], cwd=root)
            data = archive.read_bytes()
            oracle = check_archive(data)
            receipts = []
            for name, expected in EXPECTED.items():
                # SHA2 refusals are retained. Producer failures are never accepted.
                result = subprocess.run(
                    ["/usr/bin/bsdtar", "-xOf", str(archive), name], capture_output=True,
                )
                if algorithm == "sha1":
                    assert result.returncode == 0 and result.stdout == expected, result.stderr
                receipts.append({
                    "path": name, "exitCode": result.returncode,
                    "stderr": result.stderr.decode(),
                    "exact": result.returncode == 0 and result.stdout == expected,
                })
            out = root / (producer + "-" + compression + "-" + algorithm + "-native")
            out.mkdir()
            run(["/usr/bin/xar", "-xf", str(archive), "-C", str(out)])
            for name, expected in EXPECTED.items():
                assert (out / name).read_bytes() == expected
            objects.append({
                "producer": producer, "compression": compression, "algorithm": algorithm,
                "base64": base64.b64encode(data).decode(),
                "sha256": hashlib.sha256(data).hexdigest(), "oracle": oracle,
                "bsdtar": receipts, "nativeExtractExact": True,
            })
    result = {
        "producer": run(["/usr/bin/xar", "--version"]).stdout.decode().strip(),
        "consumer": run(["/usr/bin/bsdtar", "--version"]).stdout.decode().strip(),
        "source": {
            "revision": "3efbc308e3699a4ab8258fd769f5853bae91a2dc",
            "path": "xar/lib/archive.c",
            "sha256": "aafad8b949b2dc555f141d8c281ec675cea9485bef2bb3ddbaa5415fe0f2c6f2",
        },
        "records": [
            {"path": name, "base64": base64.b64encode(value).decode()}
            for name, value in EXPECTED.items()
        ],
        "objects": objects,
    }
    (HERE / "independent.json").write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
