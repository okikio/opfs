"""Reproduce fixed WARC fixture bytes with warcio1.7.5, never the candidate reader."""
import base64
import hashlib
import io
import json
import platform
from pathlib import Path

from warcio.archiveiterator import ArchiveIterator
from warcio.statusandheaders import StatusAndHeaders
from warcio.warcwriter import WARCWriter

result = {"producer": "warcio1.7.5", "python": platform.python_version(), "archives": []}
for version in ["1.0", "1.1"]:
    out = io.BytesIO()
    writer = WARCWriter(out, gzip=False, warc_version=version)
    cases = [
        ("resource", b"authored resource: caf\xc3\xa9\x00\xff\r\nWARC/1.1\r\n\r\n", None),
        ("response", b"authored HTTP entity\n", StatusAndHeaders("200 OK", [
            ("Content-Type", "text/plain"), ("Content-Length", "21"),
        ], protocol="HTTP/1.1")),
        ("resource", b"", None),
    ]
    for index, (kind, payload, headers) in enumerate(cases):
        fields = {
            "WARC-Record-ID": f"<urn:uuid:00000000-0000-4000-8000-{index:012d}>",
            "WARC-Date": "2026-11-05T00:00:00Z",
        }
        record = writer.create_warc_record("https://example.invalid/fixture", kind,
            payload=io.BytesIO(payload), length=len(payload), http_headers=headers, warc_headers_dict=fields)
        writer.write_record(record)
    data = out.getvalue()
    oracle = []
    for record in ArchiveIterator(io.BytesIO(data), check_digests=True):
        block = record.raw_stream.read()
        entity = cases[len(oracle)][1]
        # raw_stream is positioned after parsed HTTP headers; recover the full
        # block independently from producer-generated headers, not OPFS output.
        full = (record.http_headers.to_bytes() if record.http_headers else b"") + block
        assert record.digest_checker.passed is True
        assert len(full) == int(record.rec_headers.get_header("Content-Length"))
        assert block == entity
        oracle.append({"type": record.rec_type, "recordId": record.rec_headers.get_header("WARC-Record-ID"),
            "blockBase64": base64.b64encode(full).decode(), "entityBase64": base64.b64encode(entity).decode(),
            "blockDigest": record.rec_headers.get_header("WARC-Block-Digest"),
            "payloadDigest": record.rec_headers.get_header("WARC-Payload-Digest"),
            "sha256BlockDigest": "sha256:" + base64.b32encode(hashlib.sha256(full).digest()).decode().rstrip("="),
            "digestPassed": record.digest_checker.passed})
    result["archives"].append({"version": version, "sha256": hashlib.sha256(data).hexdigest(),
        "base64": base64.b64encode(data).decode(), "records": oracle})
Path(__file__).with_name("independent.json").write_text(json.dumps(result, indent=2) + "\n")
