"""Invoke independent ARC producers, then verify their bytes with native consumers.

Pass an explicit JDK java path and a directory containing the exact jars below.
No candidate reader or authored ARC encoder participates.
"""
import argparse
import base64
import contextlib
import hashlib
from io import BytesIO, StringIO
import json
from pathlib import Path
import platform
import subprocess
import tempfile
import zipfile
from warcio.archiveiterator import ArchiveIterator
import importlib.metadata

ARTIFACTS = {
    "webarchive-commons-3.0.5.jar": "e67e1e997c9ac396c90f8acb8a2116bc8127fc6c946ff725c98a0d7b7b643a89",
    "webarchive-commons-3.0.5-sources.jar": "d81fecd132712248c03a2f072fd5f79a37d3739adbb3e7b9c91e8f5afe396b60",
    "commons-io-2.22.0.jar": "2b9a7b1f726fb86216dbd2c8321eabe0221dbd5b1be81c18e1cb53811b104758",
    "commons-lang3-3.20.0.jar": "69e5c9fa35da7a51a5fd2099dfe56a2d8d32cf233e2f6d770e796146440263f4",
    "commons-codec-1.22.1.jar": "78a5d732fbd715e2d10bd7150d2f8030bae57267f8aacc5c88f642cb6c2e5d3f",
    "guava-33.7.1-jre.jar": "796d8e28ac64e83a47c4c5935a8fecc4682650a04bbdead738ef0f5a3a0e6c46",
    "jwat-arc-1.2.1.jar": "413a37eae5562a809c6478edc4d36201913008331165d2b09afa137cd37ab86c",
    "jwat-arc-1.2.1-sources.jar": "fcb4af819482ae8e491ff4a453a52e766b096f16d93259a4d6854d4f19ce8625",
    "jwat-common-1.2.1.jar": "e1f12634718c24d35f57a05e28c45590cb7e18b8a0a5398a793257d39f34e43c",
    "jwat-gzip-1.2.1.jar": "4d465df87676b12d4c43b2691e52435db0a7d5d98fb43663166db13dec721908",
    "jwat-archive-common-1.2.1.jar": "4a7faa11a48ba89c230e94d46adb747b9aa4a5c288d5b6a47def9bfabbb4278f",
    "bcprov-jdk15to18-1.65.jar": "2dea4d470c07e29315a5b60a11a4fb377793f36e16fde15640db1f028f01b818",
}
URLS = ["http://example.test/capture", "dns:example.test", "http://example.test/capture", "urn:example:empty"]
TYPES = ["text/plain", "application/octet-stream", "text/plain", "application/octet-stream"]
BLOCKS = [b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nhello\n", bytes(range(256)) + b"\nhttp://fake.invalid/ 192.0.2.2 20260102030405 text/plain 0\n", b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n", b""]


def saved(data):
    return {"base64": base64.b64encode(data).decode(), "sha256": hashlib.sha256(data).hexdigest()}


def consume(data):
    blocks = []
    warnings = StringIO()
    failure = None
    try:
        with contextlib.redirect_stderr(warnings):
            for record in ArchiveIterator(BytesIO(data), no_record_parse=True):
                block = record.raw_stream.read()
                if blocks:
                    assert block == BLOCKS[len(blocks) - 1]
                blocks.append(block)
        assert len(blocks) == 5
    except Exception as error:
        failure = {"type": type(error).__name__, "message": str(error)}
    return {"accepted": failure is None, "records": len(blocks), "warnings": warnings.getvalue(), "failure": failure}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--java", type=Path, required=True)
    parser.add_argument("--tools", type=Path, required=True)
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    for name, digest in ARTIFACTS.items():
        assert hashlib.sha256((args.tools / name).read_bytes()).hexdigest() == digest, name
    classpath = ":".join(str(args.tools / name) for name in ARTIFACTS if not name.endswith("-sources.jar"))
    commands = []
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        for index, block in enumerate(BLOCKS):
            (root / ("block" + str(index))).write_bytes(block)
        for java in ["Produce.java", "ProduceJwat.java"]:
            result = subprocess.run([str(args.java), "-Xmx64m", "-XX:MaxMetaspaceSize=128m", "-cp", classpath, str(here / java), str(root)], check=True, capture_output=True, text=True)
            commands.append({"harness": java, "stdout": result.stdout, "stderr": result.stderr})
        objects = []
        for filename, producer, prefix, mode in [("jwat.arc", "JWAT1.2.1", "jwat-output", "outside-length"), ("genuine.arc", "IIPC3.0.5", "iipc-output", "inside-length")]:
            data = (root / filename).read_bytes()
            for index, expected in enumerate(BLOCKS):
                assert (root / (prefix + str(index + 1))).read_bytes() == expected
            # Byte accounting uses producer output only. Descriptor ownership is not inferred from a consumer that trims it.
            header, rest = data.split(b"\n", 1)
            size = int(header.rsplit(b" ", 1)[1])
            descriptor = rest[:size]
            canonical = b"1 0 " + (b"OPFSFixture" if mode == "outside-length" else b"InternetArchive") + b"\nURL IP-address Archive-date Content-type Archive-length\n"
            assert descriptor == canonical + (b"\n" if mode == "inside-length" else b"")
            assert rest[size:].startswith(b"\nhttp://" if mode == "outside-length" else b"http://")
            consumer = consume(data)
            assert consumer["accepted"] == (mode == "outside-length")
            if mode == "inside-length":
                assert consumer["failure"]["type"] == "ArchiveLoadFailed"
                assert (root / "iipc-strict-outputstatus").read_text().splitlines()[0].split()[1] == "false"
            objects.append({"producer": producer, "separator": mode, **saved(data), "descriptor": saved(descriptor), "nativeJwat": {"strict": mode == "outside-length", "status": (root / (prefix + "status")).read_text()}, "warcio": consumer})
        java = subprocess.run([str(args.java), "-version"], check=True, capture_output=True, text=True)
        output = {"python": platform.python_version(), "warcio": importlib.metadata.version("warcio"), "java": java.stderr, "artifacts": ARTIFACTS, "commands": commands, "objects": objects, "records": [{"url": url, "contentType": content_type, "date": "20260102030405", "ip": "192.0.2.1", **saved(block)} for url, content_type, block in zip(URLS, TYPES, BLOCKS)], "iipcStrictJwat": (root / "iipc-strict-outputstatus").read_text()}
    output["sourceReceipts"] = {}
    for jar, name in [("webarchive-commons-3.0.5-sources.jar", "org/archive/io/arc/ARCWriter.java"), ("jwat-arc-1.2.1-sources.jar", "org/jwat/arc/ArcVersionHeader.java"), ("jwat-arc-1.2.1-sources.jar", "org/jwat/arc/ArcWriter.java"), ("jwat-arc-1.2.1-sources.jar", "org/jwat/arc/ArcVersionBlock.java")]:
        with zipfile.ZipFile(args.tools / jar) as archive:
            output["sourceReceipts"][jar + ":" + name] = hashlib.sha256(archive.read(name)).hexdigest()
    (here / "independent.json").write_text(json.dumps(output, indent=2) + "\n")


if __name__ == "__main__":
    main()
