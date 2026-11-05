"""Acquire and inspect exactly two pinned test-only wheels; never import their code.

Run in the reviewed public CPython 3.13 arm64 container. Installation belongs to
a separate network-disabled stage after this process succeeds. Original wheel
bytes and license files remain in /receipts. No resolver or source build runs.
"""
import hashlib
import json
import pathlib
import platform
import signal
import stat
import sys
import time
import urllib.parse
import urllib.request
import zipfile

ARTIFACTS = [
    ("https://files.pythonhosted.org/packages/90/c3/0c7da7b6dac863af75b64e2f827e4742161128c350bfe7955b426484e226/pyarrow-20.0.0-cp313-cp313-manylinux_2_28_aarch64.whl",
     40677027, "991f85b48a8a5e839b2128590ce07611fae48a904cae6cab1f089c5955b57eb5"),
    ("https://files.pythonhosted.org/packages/d1/46/af81b10d4a66a0f27c248df296d1b41ff2a305a235ed8488f93240f6f8b5/duckdb-1.3.2-cp313-cp313-manylinux_2_27_aarch64.manylinux_2_28_aarch64.whl",
     19180082, "b3e519de5640e5671f1731b3ae6b496e0ed7e4de4a1c25c7a2f34c991ab64d71"),
]


class Redirects(urllib.request.HTTPRedirectHandler):
    """No redirect may escape the explicitly reviewed artifact origin."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urlparse(newurl)
        if target.scheme != "https" or target.netloc != "files.pythonhosted.org":
            raise ValueError("Cross-origin wheel redirect refused")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def main():
    def deadline(*_):
        raise TimeoutError("Acquisition deadline")
    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(180)
    assert platform.machine() == "aarch64" and sys.version_info[:2] == (3, 13)
    root = pathlib.Path("/receipts")
    (root / "wheels").mkdir(parents=True, exist_ok=True)
    (root / "notices").mkdir(exist_ok=True)
    opener = urllib.request.build_opener(Redirects())
    receipts, total, notice_bytes, expanded_bytes = [], 0, 0, 0
    started = time.monotonic()
    for url, size, expected in ARTIFACTS:
        assert size <= 64 * 1024 * 1024 and total + size <= 96 * 1024 * 1024
        path = root / "wheels" / url.rsplit("/", 1)[1]
        actual = hashlib.sha256()
        count = 0
        with opener.open(url, timeout=30) as response, path.open("wb") as output:
            assert urllib.parse.urlparse(response.url).netloc == "files.pythonhosted.org"
            while chunk := response.read(65536):
                count += len(chunk)
                assert count <= size
                actual.update(chunk)
                output.write(chunk)
        assert count == size and actual.hexdigest() == expected
        total += count
        members, licenses, metadata, native = [], [], [], []
        with zipfile.ZipFile(path) as archive:
            items = archive.infolist()
            assert len(items) <= 10000
            expanded_bytes += sum(item.file_size for item in items)
            assert expanded_bytes <= 512 * 1024 * 1024
            seen = set()
            for item in items:
                name = pathlib.PurePosixPath(item.filename)
                assert not name.is_absolute() and ".." not in name.parts and "\\" not in item.filename
                canonical = str(name)
                assert canonical not in ("", ".")
                assert item.filename == canonical + ("/" if item.is_dir() else "")
                assert item.orig_filename == item.filename and "\x00" not in item.filename
                assert canonical not in seen
                seen.add(canonical)
                assert not item.filename.lower().endswith(".pth")
                mode = item.external_attr >> 16
                kind = stat.S_IFMT(mode)
                assert kind in (0, stat.S_IFREG, stat.S_IFDIR)
                assert not mode & (stat.S_ISUID | stat.S_ISGID)
                assert kind != stat.S_IFDIR or item.is_dir()
                assert kind != stat.S_IFREG or not item.is_dir()
                assert not item.flag_bits & 1 and item.compress_type in (0, 8)
                assert item.file_size <= 128 * 1024 * 1024
                digest = hashlib.sha256()
                prefix = b""
                decoded = 0
                with archive.open(item) as source:
                    while data := source.read(65536):
                        decoded += len(data)
                        assert decoded <= item.file_size
                        digest.update(data)
                        if len(prefix) < 64:
                            prefix += data[:64 - len(prefix)]
                assert decoded == item.file_size
                members.append({"name": item.filename, "bytes": decoded, "sha256": digest.hexdigest()})
                lower = item.filename.lower()
                if any(part.startswith(("license", "copying", "notice")) for part in lower.split("/")) and not item.is_dir():
                    assert item.file_size <= 1024 * 1024
                    notice_bytes += item.file_size
                    assert notice_bytes <= 8 * 1024 * 1024
                    target = root / "notices" / (path.stem + "-" + str(len(licenses)))
                    target.write_bytes(archive.read(item))
                    licenses.append({"member": item.filename, "file": target.name, "sha256": digest.hexdigest()})
                if lower.endswith((".dist-info/metadata", ".dist-info/wheel", ".dist-info/record")):
                    assert item.file_size <= 2 * 1024 * 1024
                    target = root / (path.stem + "-" + name.name)
                    target.write_bytes(archive.read(item))
                    metadata.append({"member": item.filename, "file": target.name, "sha256": digest.hexdigest()})
                if prefix[:4] == b"\x7fELF":
                    assert prefix[4:6] == b"\x02\x01" and int.from_bytes(prefix[18:20], "little") == 183
                    native.append({"member": item.filename, "elfClass": 64, "machine": "AArch64"})
        assert licenses and len(metadata) == 3 and native
        receipts.append({"url": url, "bytes": count, "sha256": expected, "members": members,
                         "licenses": licenses, "metadata": metadata, "native": native})
    record = {"python": sys.version, "executable": sys.executable, "platform": platform.platform(),
              "machine": platform.machine(), "seconds": time.monotonic() - started,
              "scriptSha256": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(), "artifacts": receipts}
    result = json.dumps(record, indent=2).encode()
    assert len(result) <= 4 * 1024 * 1024
    (root / "acquisition.json").write_bytes(result)
    print(json.dumps({"artifacts": len(receipts), "wheelBytes": total, "noticeBytes": notice_bytes,
                      "receiptSha256": hashlib.sha256(result).hexdigest()}))


if __name__ == "__main__":
    main()
