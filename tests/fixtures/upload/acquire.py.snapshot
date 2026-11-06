"""Test-only immutable-source acquisition. No npm installation or upstream lifecycle hooks."""
import argparse
import hashlib
import io
import gzip
import json
from pathlib import Path
import tarfile
import urllib.request
from urllib.parse import urlsplit

parser = argparse.ArgumentParser()
parser.add_argument("--pin", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
pin = json.loads(Path(args.pin).read_text())
commit = "39a36a8970eea2652003271beb42b2d0319783b4"
assert pin["repository"] == "nordvec/partial-content" and pin["commit"] == commit
url = "https://codeload.github.com/nordvec/partial-content/tar.gz/" + commit
class Redirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urlsplit(newurl)
        assert parsed.scheme == "https" and parsed.netloc == "codeload.github.com"
        return super().redirect_request(req, fp, code, msg, headers, newurl)

opener = urllib.request.build_opener(Redirect())
with opener.open(url, timeout=60) as response:
    final = urlsplit(response.url)
    assert final.scheme == "https" and final.netloc == "codeload.github.com"
    archive = response.read(16 * 1024 * 1024 + 1)
assert len(archive) <= 16 * 1024 * 1024
output = Path(args.output)
output.mkdir(parents=True, exist_ok=False)
expected = {item["path"]: item["gitBlob"] for item in pin["files"]}
observed = {}
retained = 0
# Bound expansion before tarfile can inspect PAX/longname extension records.
with gzip.GzipFile(fileobj=io.BytesIO(archive)) as stream:
    expanded = stream.read(32 * 1024 * 1024 + 1)
assert len(expanded) <= 32 * 1024 * 1024
members = 0
extent = 0
with tarfile.open(fileobj=io.BytesIO(expanded), mode="r:") as source:
    for member in source:
        members += 1
        extent += member.size
        assert members <= 4096 and 0 <= member.size <= 32 * 1024 * 1024
        assert extent <= 32 * 1024 * 1024 and len(member.name) <= 4096
        pieces = member.name.split("/", 1)
        if len(pieces) != 2 or pieces[1] not in expected:
            continue
        path = pieces[1]
        assert member.isfile() and 0 <= member.size <= 4 * 1024 * 1024
        assert path not in observed and not Path(path).is_absolute() and ".." not in Path(path).parts
        retained += member.size
        assert retained <= 16 * 1024 * 1024
        body = source.extractfile(member).read(member.size + 1)
        assert len(body) == member.size
        git = hashlib.sha1(b"blob " + str(len(body)).encode() + b"\0" + body).hexdigest()
        assert git == expected[path], (path, git, expected[path])
        target = output / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        observed[path] = hashlib.sha256(body).hexdigest()
assert set(observed) == set(expected)
assert observed["LICENSE"] == pin["licenseSha256"]
(output / "source-receipt.json").write_text(json.dumps({"url": url, "commit": commit,
    "archiveSha256": hashlib.sha256(archive).hexdigest(), "archiveBytes": len(archive), "expandedBytes": len(expanded), "members": members,
    "retainedBytes": retained, "files": observed}, indent=2) + "\n")
