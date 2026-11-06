"""DRAFT: inert age artifact/source acquisition; execute only after recipe approval."""
import argparse
import gzip
import hashlib
import io
import json
import pathlib
import platform
import stat
import sys
import tarfile
import time
import urllib.parse
import urllib.request
import zlib

ASSET = "https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-linux-arm64.tar.gz"
ASSET_BYTES = 17771923
ASSET_SHA = "6b8dc4333c53a5a57c9e5834e3a48f92605d7154014cd07269ff3327db5d37f4"
DEADLINE = time.monotonic() + 120


def check(condition, message):
    if not condition:
        raise ValueError(message)


class Redirect(urllib.request.HTTPRedirectHandler):
    """Only the pinned release may redirect, into GitHub's asset CDN."""
    def __init__(self, asset):
        super().__init__()
        self.asset = asset
        self.count = 0

    def redirect_request(self, request, response, code, message, headers, url):
        parsed = urllib.parse.urlsplit(url)
        self.count += 1
        check(self.asset and self.count <= 3, "Unexpected redirect")
        check(parsed.scheme == "https" and parsed.hostname == "release-assets.githubusercontent.com", "Unexpected redirect origin")
        check(parsed.username is None and parsed.password is None and parsed.port in [None, 443], "Redirect authority")
        check(code in [301, 302, 303, 307, 308], "Redirect status")
        return super().redirect_request(request, response, code, message, headers, url)


def fetch(url, limit, asset=False):
    remaining = DEADLINE - time.monotonic()
    check(remaining > 0, "Whole acquisition deadline")
    handler = Redirect(asset)
    opener = urllib.request.build_opener(handler)
    request = urllib.request.Request(url, headers={"User-Agent": "opfs-age-inert-fixture-review"})
    with opener.open(request, timeout=min(15, remaining)) as response:
        check(response.status == 200, "HTTP status")
        parsed = urllib.parse.urlsplit(response.url)
        if asset:
            check(response.url == url or parsed.hostname == "release-assets.githubusercontent.com", "Final asset origin")
        else:
            check(response.url == url, "Raw source redirect")
        length = response.headers.get("Content-Length")
        if length is not None:
            check(length.isdecimal() and int(length) <= limit, "Declared response cap")
        parts, count = [], 0
        while True:
            check(time.monotonic() < DEADLINE, "Whole acquisition deadline")
            value = response.read(min(65536, limit + 1 - count))
            if not value:
                break
            count += len(value)
            check(count <= limit, "Response byte cap")
            parts.append(value)
        return b"".join(parts)


def safe(name, directory=False):
    check(0 < len(name) <= 512 and "\\" not in name and not name.startswith("/"), "Unsafe path")
    # Only a directory may spell one terminal slash. Do not silently collapse
    # repeated slashes or dot components into a trusted member identity.
    identity = name[:-1] if directory and name.endswith("/") else name
    check(all(p not in ["", ".", ".."] for p in identity.split("/")), "Unsafe path component")
    return identity


def elf(data, mode):
    check(mode & 0o111 != 0, "Selected native binary lacks executable mode")
    check(len(data) >= 64 and data[:7] == b"\x7fELF\x02\x01\x01", "Selected ELF64 little-endian header")
    check(int.from_bytes(data[18:20], "little") == 183, "Selected ELF machine is not AArch64")
    check(int.from_bytes(data[16:18], "little") in [2, 3], "Selected ELF type is not executable/shared")
    return {"class": 64, "byteOrder": "little", "machine": "AArch64", "machineId": 183, "originalExecutableMode": mode}


def blob(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def digest(data):
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def snapshot(output, relative, data):
    safe(relative)
    target = output / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)


def cli(output):
    raw = fetch(ASSET, ASSET_BYTES, asset=True)
    check(len(raw) == ASSET_BYTES and hashlib.sha256(raw).hexdigest() == ASSET_SHA, "Pinned release integrity")
    snapshot(output, "age-v1.3.2-linux-arm64.tar.gz.snapshot", raw)
    # Bound complete TAR bytes, including PAX/GNU metadata, before tarfile sees them.
    with gzip.GzipFile(fileobj=io.BytesIO(raw)) as source:
        expanded = source.read(128 * 1024 * 1024 + 1)
    check(len(expanded) <= 128 * 1024 * 1024, "Expanded TAR cap")
    rows, selected, names, total = [], {}, set(), 0
    with tarfile.open(fileobj=io.BytesIO(expanded), mode="r:") as archive:
        for member in archive:
            check(len(rows) < 128, "TAR member count")
            check(member.isfile() or member.isdir(), "TAR link or special entry")
            identity = safe(member.name, member.isdir())
            check(identity.split("/")[0] == "age", "Unexpected archive root")
            check(identity not in names, "Duplicate canonical archive identity")
            names.add(identity)
            check(not member.mode & (stat.S_ISUID | stat.S_ISGID), "Set-ID member")
            check(0 <= member.size <= 32 * 1024 * 1024, "Declared member cap")
            check(not member.isdir() or member.size == 0, "Directory payload")
            total += member.size
            check(total <= 120 * 1024 * 1024, "Declared file total")
            check(len(member.pax_headers) <= 16, "PAX metadata count")
            check(all(len(k) <= 128 and len(v) <= 8192 for k, v in member.pax_headers.items()), "PAX metadata extent")
            row = {"path": member.name, "identity": identity, "bytes": member.size, "mode": member.mode, "kind": "file" if member.isfile() else "directory"}
            if member.isfile():
                data = archive.extractfile(member).read(member.size + 1)
                check(len(data) == member.size, "Member extent")
                row["sha256"] = hashlib.sha256(data).hexdigest()
                if member.name in ["age/age", "age/age-keygen", "age/LICENSE"]:
                    if member.name != "age/LICENSE":
                        row["elf"] = elf(data, member.mode)
                    selected[member.name] = data
            rows.append(row)
    check("age/age" in selected and "age/age-keygen" in selected, "Missing required binaries")
    for name, data in selected.items():
        snapshot(output, "cli/" + name.removeprefix("age/") + ".snapshot", data)
    return {"url": ASSET, **digest(raw), "expandedTarBytes": len(expanded), "members": rows,
            "selected": list(selected), "scope": "Inert only; no archived executable run. License is separately pinned in source stage."}


def vectors(output, manifest_path, sources_path):
    manifest = json.loads(pathlib.Path(manifest_path).read_text())
    sources = json.loads(pathlib.Path(sources_path).read_text())
    check(manifest["commit"] == "4448f2097b2daa812c91a26141f9f36c2096b9ca", "CCTV revision")
    check(len(manifest["vectors"]) == 50 and len(sources["files"]) == 9, "Reviewed inventory cardinality")
    rows, total, expanded_total = [], 0, 0
    files = list(sources["files"])
    for item in manifest["vectors"]:
        files.append({**item, "repo": "C2SP/CCTV", "ref": manifest["commit"], "vector": True})
        files.append({**item["generator"], "repo": "C2SP/CCTV", "ref": manifest["commit"]})
    seen = set()
    for item in files:
        safe(item["path"])
        key = item["repo"] + "/" + item["path"]
        check(key not in seen, "Duplicate admitted source")
        seen.add(key)
        check(0 <= item["bytes"] <= 65536 and len(item["gitBlob"]) == 40, "Source inventory extent")
        url = "https://raw.githubusercontent.com/" + item["repo"] + "/" + item["ref"] + "/" + item["path"]
        data = fetch(url, item["bytes"])
        check(len(data) == item["bytes"] and blob(data) == item["gitBlob"], "Source blob identity")
        total += len(data)
        check(total <= 512 * 1024, "Aggregate source acquisition cap")
        row = {"repo": item["repo"], "ref": item["ref"], "path": item["path"], "gitBlob": blob(data), **digest(data)}
        snapshot(output, "sources/" + item["repo"] + "/" + item["path"] + ".snapshot", data)
        if item.get("vector"):
            head, separator, wire = data.partition(b"\n\n")
            check(separator and len(head) <= 4096, "Vector metadata framing")
            fields = {}
            for line in head.decode("ascii").splitlines():
                key, mark, value = line.partition(": ")
                check(mark and key in ["expect", "payload", "identity", "file key", "comment", "compressed"], "Vector metadata key")
                fields.setdefault(key, []).append(value)
            check(fields.get("expect") == [item["expect"]], "Original vector expectation differs from research")
            check(len(fields.get("file key", [])) == 1 and len(bytes.fromhex(fields["file key"][0])) == 16, "File key metadata")
            if "compressed" in fields:
                check(fields["compressed"] == ["zlib"], "Vector compression profile")
                decoder = zlib.decompressobj()
                decoded = decoder.decompress(wire, 1024 * 1024 + 1)
                check(len(decoded) <= 1024 * 1024 and decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail, "Expanded vector cap or trailing data")
                wire = decoded
            expanded_total += len(wire)
            check(expanded_total <= 16 * 1024 * 1024, "Aggregate expanded vector cap")
            row["metadata"] = fields
            row["wire"] = digest(wire)
            # This is a derived, explicitly labeled fixture, never a replacement for the original.
            snapshot(output, "vectors/" + item["path"].split("/")[-1] + ".age.snapshot", wire)
        rows.append(row)
    return {"scope": "Inert immutable sources and original vectors; zlib-only derivations labeled. Nothing imported or executed.",
            "cctvCommit": manifest["commit"], "rawBytes": total, "expandedVectorBytes": expanded_total, "files": rows}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", choices=["cli", "vectors"])
    parser.add_argument("--output", required=True)
    parser.add_argument("--manifest", default="/tool/age-vectors.json")
    parser.add_argument("--sources", default="/tool/age-sources.json")
    args = parser.parse_args()
    output = pathlib.Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    receipt = {"stage": args.stage, "python": sys.version, "architecture": platform.machine(), "scope": "Inert acquisition only"}
    try:
        receipt["result"] = cli(output) if args.stage == "cli" else vectors(output, args.manifest, args.sources)
    except BaseException as error:
        receipt["failure"] = {"type": type(error).__name__, "message": str(error)[:2048]}
        raise
    finally:
        (output / (args.stage + "-receipt.json")).write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    main()
