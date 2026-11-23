"""Test-only inert acquisition. Metadata review precedes the artifact stage."""
import argparse
import base64
import hashlib
import gzip
import io
import json
import pathlib
import stat
import tarfile
import urllib.request

VERSION = "6.2.15"
METADATA = "https://registry.npmjs.org/jose/6.2.15"
ARTIFACT = "https://registry.npmjs.org/jose/-/jose-6.2.15.tgz"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise ValueError("Redirect refused")


def fetch(url, maximum):
    with urllib.request.build_opener(NoRedirect).open(url, timeout=20) as response:
        assert response.status == 200 and response.url == url
        data = response.read(maximum + 1)
        assert len(data) <= maximum
        return data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", choices=["metadata", "artifact"])
    parser.add_argument("--output", required=True)
    parser.add_argument("--integrity")
    args = parser.parse_args()
    output = pathlib.Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    if args.stage == "metadata":
        raw = fetch(METADATA, 256 * 1024)
        data = json.loads(raw)
        assert data["name"] == "jose" and data["version"] == VERSION
        assert data["license"] == "MIT"
        assert not data.get("dependencies") and not data.get("optionalDependencies")
        assert data["dist"]["tarball"] == ARTIFACT
        value = data["dist"]["integrity"]
        assert value.startswith("sha512-") and len(base64.b64decode(value[7:], validate=True)) == 64
        (output / "registry.json.snapshot").write_bytes(raw)
        (output / "registry-receipt.json").write_text(json.dumps({
            "url": METADATA, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
            "integrity": value, "artifact": ARTIFACT,
            "scope": "Metadata only; artifact not downloaded or executed.",
        }, indent=2) + "\n")
        return
    assert args.integrity and args.integrity.startswith("sha512-")
    expected = base64.b64decode(args.integrity[7:], validate=True)
    assert len(expected) == 64
    raw = fetch(ARTIFACT, 2 * 1024 * 1024)
    assert hashlib.sha512(raw).digest() == expected
    rows, total, paths = [], 0, set()
    admitted = []
    # Bound all expanded TAR bytes before tarfile can interpret PAX/GNU metadata.
    with gzip.GzipFile(fileobj=io.BytesIO(raw), mode="rb") as compressed:
        expanded = compressed.read(8 * 1024 * 1024 + 1)
        assert len(expanded) <= 8 * 1024 * 1024
    with tarfile.open(fileobj=io.BytesIO(expanded), mode="r:") as archive:
        for member in archive:
            assert len(rows) < 512
            name = member.name
            assert "\\" not in name and not name.startswith("/")
            parts = name.rstrip("/").split("/")
            assert parts[0] == "package" and all(p not in ["", ".", ".."] for p in parts)
            assert name not in paths
            paths.add(name)
            assert member.isdir() or member.isfile()
            assert not member.mode & (stat.S_ISUID | stat.S_ISGID)
            assert member.size >= 0 and member.size <= 256 * 1024
            total += member.size
            assert total <= 8 * 1024 * 1024
            row = {"name": name, "bytes": member.size, "kind": "directory" if member.isdir() else "file"}
            if member.isfile():
                data = archive.extractfile(member).read(member.size + 1)
                assert len(data) == member.size
                row["sha256"] = hashlib.sha256(data).hexdigest()
                selected = name in ["package/package.json", "package/LICENSE.md", "package/README.md"] or (name.startswith("package/dist/webapi/") and name.endswith(".js"))
                if selected:
                    admitted.append((name, data))
            rows.append(row)
    assert rows and admitted
    selected = dict(admitted)
    assert "package/LICENSE.md" in selected and b"MIT License" in selected["package/LICENSE.md"]
    package = json.loads(selected["package/package.json"])
    assert package["name"] == "jose" and package["version"] == VERSION and package["license"] == "MIT"
    assert package["type"] == "module" and not package.get("dependencies") and not package.get("optionalDependencies")
    assert "package/dist/webapi/index.js" in selected
    # Preserve executable upstream bytes as inert snapshots; only a separately
    # approved offline producer reconstructs these exact admitted paths.
    for name, data in admitted:
        target = output / "sdk" / (name.removeprefix("package/") + ".snapshot")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    (output / "artifact.tgz.snapshot").write_bytes(raw)
    (output / "acquisition.json").write_text(json.dumps({
        "url": ARTIFACT, "integrity": args.integrity, "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(), "members": rows,
        "selected": [name for name, _ in admitted], "declaredFileBytes": total, "expandedTarBytes": len(expanded),
        "scope": "SHA-verified inert package bytes; no import, install, build or lifecycle execution.",
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()
