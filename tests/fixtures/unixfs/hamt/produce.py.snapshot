#!/usr/bin/env python3
"""Produce genuine fanout-256 HAMTs with Kubo; compare paths to authored bytes.

This test-only recipe runs offline in a bounded ARM64 container. It imports no
candidate code. Original files, full native reads, directory listings, serialized
blocks and optional native hash probes remain in the output receipt.
"""
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

ASSET_SHA256 = "e09237abadd9578d7a73dd2e2b718848b78437cb56e48cc9742b23ce9ebac829"
COMMIT = "acc53c093810a8fe9a4bc2f023f0b1e0c1d629b5"


def encoded(value):
    return base64.b64encode(value).decode("ascii")


def fields(value):
    """Read only native UnixFS metadata to retain physical framing receipts."""
    offset = 0

    def integer():
        nonlocal offset
        result = 0
        for shift in range(0, 70, 7):
            assert offset < len(value)
            byte = value[offset]
            offset += 1
            result |= (byte & 127) << shift
            if not byte & 128:
                return result
        raise AssertionError("native varint exceeds uint64")

    result = {}
    while offset < len(value):
        tag = integer()
        field, wire = tag >> 3, tag & 7
        if wire == 0:
            item = integer()
        elif wire == 2:
            length = integer()
            assert offset + length <= len(value)
            item = value[offset:offset + length]
            offset += length
        else:
            raise AssertionError(("unexpected native wire type", field, wire))
        assert field not in result, ("duplicate native field", field)
        result[field] = item
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    assert platform.machine() in ("aarch64", "arm64"), "Pinned release requires ARM64"
    archive = args.archive.read_bytes()
    assert len(archive) == 39040966 and hashlib.sha256(archive).hexdigest() == ASSET_SHA256
    with tempfile.TemporaryDirectory(prefix="hamt-native-") as temporary:
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

        def run(*arguments, data=None, optional=False):
            command = [str(executable), "--offline", *arguments]
            result = subprocess.run(command, env=environment, input=data, capture_output=True, timeout=90)
            commands.append({"arguments": list(arguments), "exitCode": result.returncode,
                             "stderr": result.stderr.decode("utf-8", "replace")})
            if optional:
                return {"exitCode": result.returncode, "stdout": result.stdout.decode("utf-8", "replace"),
                        "stderr": result.stderr.decode("utf-8", "replace")}
            result.check_returncode()
            return result.stdout

        run("init", "--profile=test")
        version = run("version", "--all").decode()
        originals = {f"file-{index:03}.txt": (f"Native HAMT original {index}.\n".encode()) for index in range(96)}
        originals.update({"caf\u00e9.txt": b"literal UTF-8 name\n", "%2F.txt": b"literal percent name\n",
                          "space name.txt": b"literal spaces\n", "empty": b""})
        originals.update({f"nested/child-{index}.bin": bytes([index]) * (10 + index) for index in range(8)})
        directory = root / "originals"
        directory.mkdir()
        for name, body in originals.items():
            path = directory / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
        # This explicit importer option forces HAMT conversion at a small bounded
        # directory size. No mutation of repository defaults is needed.
        cid = run("add", "--recursive", "--quieter", "--pin=false", "--cid-version=1", "--raw-leaves=true",
                  "--max-directory-links=4", str(directory)).decode().strip()
        car = run("dag", "export", cid)
        refs = run("refs", "--recursive", "--unique", cid).decode().splitlines()
        blocks, shards = [], []
        for block_cid in dict.fromkeys([cid, *refs]):
            body = run("block", "get", block_cid)
            blocks.append({"cid": block_cid, "base64": encoded(body), "size": len(body),
                           "sha256": hashlib.sha256(body).hexdigest()})
            # CIDv1 raw leaves are base32 strings beginning with bafk. Only
            # DAG-PB metadata is inspected; raw file contents remain opaque.
            if block_cid.startswith("bafk"):
                continue
            node = json.loads(run("dag", "get", block_cid))
            # `dag get` emits DAG-JSON bytes, not a bare JSON base64 string.
            # Preserve a useful diagnostic if the actual native shape differs.
            data = node["Data"]
            assert isinstance(data, dict) and set(data) == {"/"}, ("native Data wrapper", data)
            wrapper = data["/"]
            assert isinstance(wrapper, dict) and set(wrapper) == {"bytes"}, ("native Data bytes wrapper", data)
            text = wrapper["bytes"]
            assert isinstance(text, str), ("native Data bytes text", data)
            metadata = fields(base64.b64decode(text + "=" * (-len(text) % 4), validate=True))
            if metadata[1] != 5:
                continue
            assert metadata[5] == 0x22 and metadata[6] == 256
            bitmap = metadata.get(2, b"")
            assert isinstance(bitmap, bytes) and len(bitmap) <= 32
            links = node.get("Links", [])
            # Native bitfield serializes high bucket bytes first and removes
            # leading zeros. Each link is ordered by its numeric bucket.
            buckets = [int(link["Name"][:2], 16) for link in links]
            assert buckets == sorted(set(buckets))
            assert sum(byte.bit_count() for byte in bitmap) == len(links)
            assert all(bitmap[len(bitmap) - 1 - bucket // 8] & (1 << (bucket % 8)) for bucket in buckets)
            shards.append({"cid": block_cid, "bitmap": encoded(bitmap), "bitmapBytes": len(bitmap), "links": links})
        assert any(shard["cid"] == cid for shard in shards), "Native root did not become a HAMT"
        assert len(shards) > 2, "Need genuine collisions/subshards in addition to nested directory"
        assert any(shard["bitmapBytes"] < 32 for shard in shards), "Need native shortened bitmap evidence"
        files = []
        for path, expected in originals.items():
            actual = run("cat", cid + "/" + path)
            assert actual == expected, ("native full mismatch", path, encoded(actual), encoded(expected))
            ranges = []
            if expected:
                offset, length = max(0, len(expected) - 5), min(5, len(expected))
                actual_range = run("cat", "--offset=" + str(offset), "--length=" + str(length), cid + "/" + path)
                assert actual_range == expected[offset:offset + length], ("native range mismatch", path)
                ranges.append({"offset": offset, "length": length, "base64": encoded(actual_range)})
            files.append({"path": path, "base64": encoded(expected), "sha256": hashlib.sha256(expected).hexdigest(), "ranges": ranges})
        listings = []
        for relative in ["", "nested"]:
            target = cid + ("/" + relative if relative else "")
            # Pinned ls.go CLI PostRun prints a table directly to stdout,
            # regardless of the requested encoder. Retain that actual behavior.
            probe = run("ls", "--enc=json", target, optional=True)
            assert len(probe["stdout"].encode()) <= 65536, ("native listing probe extent", relative)
            listing = run("ls", "--size=false", "--resolve-type=true", target).decode("utf-8")
            assert len(listing.encode()) <= 65536, ("native listing extent", relative)
            print(json.dumps({"listingPath": relative, "encoderProbe": probe, "nativeTable": listing}), flush=True)
            expected = sorted({name[len(relative) + 1 if relative else 0:].split("/")[0]
                               for name in originals if not relative or name.startswith(relative + "/")})
            # This finite fixture contains no leading whitespace, controls or
            # trailing slashes in names. Preserve internal spaces and UTF-8.
            rows = [line.split(None, 1) for line in listing.splitlines()]
            assert all(len(row) == 2 for row in rows), ("native listing rows", listing)
            names = sorted(row[1].removesuffix("/") for row in rows)
            assert names == expected, ("native directory listing mismatch", relative, names, expected)
            listings.append({"path": relative, "encoderProbe": probe, "nativeTable": listing, "expectedNames": expected})
        # This optional native multihash command supplies a separate hash-byte
        # oracle if Kubo exposes its registered Murmur3 hasher here. A refusal is
        # retained and never counted as a successful hash oracle.
        probes = []
        for name in ["", "file-000.txt", "caf\u00e9.txt", "a" * 17]:
            probe = run("block", "put", "--format=raw", "--mhtype=murmur3-x64-64", "--mhlen=8",
                        data=name.encode(), optional=True)
            probes.append({"name": name, **probe})
        receipt = {"evidenceProfile": "genuine Kubo HAMT producer and native full/range/path/list consumers against authored originals",
                   "sourceCommit": COMMIT, "assetSha256": ASSET_SHA256,
                   "binarySha256": hashlib.sha256(executable.read_bytes()).hexdigest(), "version": version,
                   "architecture": platform.machine(), "rootCid": cid, "car": encoded(car),
                   "carSha256": hashlib.sha256(car).hexdigest(), "blocks": blocks, "shards": shards,
                   "files": files, "listings": listings, "hashProbes": probes, "commands": commands}
        args.output.write_text(json.dumps(receipt, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
