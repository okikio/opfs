"""Independent fixture producer; run with Python stdlib, never imported by OPFS.

The archive bytes come from tarfile, not from the candidate TAR writer. Trailing
record padding is retained so the fixture also exercises early stream cleanup.
"""
import base64
import hashlib
import io
import json
import pathlib
import platform
import tarfile


def fixture(kind):
    output = io.BytesIO()
    expected = []
    pax = kind == "pax"
    with tarfile.open(fileobj=output, mode="w", format=tarfile.PAX_FORMAT if pax else tarfile.GNU_FORMAT,
                      pax_headers={"path": "global.txt", "uname": "fixture"} if pax else {}) as archive:
        name = ("caf\u00e9/" if pax else "gnu/") + "p" * 120
        body = bytes(range(256)) + b"independent payload\x00\xff"
        entry = tarfile.TarInfo(name)
        entry.size = len(body)
        entry.mtime = 0
        if pax:
            entry.pax_headers = {"size": str(len(body))}
        archive.addfile(entry, io.BytesIO(body))
        expected.append({"name": name, "kind": "file", "size": len(body), "link": "", "body": base64.b64encode(body).decode()})
        entry = tarfile.TarInfo("short.txt")
        entry.size = 6
        entry.mtime = 0
        archive.addfile(entry, io.BytesIO(b"second"))
        expected.append({"name": "global.txt" if pax else "short.txt", "kind": "file", "size": 6, "link": "", "body": base64.b64encode(b"second").decode()})
        entry = tarfile.TarInfo("link")
        entry.type = tarfile.SYMTYPE
        entry.linkname = "target/" + "q" * 140
        if pax:
            entry.pax_headers = {"path": "link"}
        archive.addfile(entry)
        expected.append({"name": "link", "kind": "symbolic-link", "size": 0, "link": entry.linkname, "body": ""})
    data = output.getvalue()
    return {"producer": "Python " + platform.python_version() + " stdlib tarfile " + kind.upper() + "_FORMAT",
            "sha256": hashlib.sha256(data).hexdigest(), "archive": base64.b64encode(data).decode(), "entries": expected}


pathlib.Path(__file__).with_name("independent.json").write_text(json.dumps({kind: fixture(kind) for kind in ["pax", "gnu"]}, indent=2) + "\n")
