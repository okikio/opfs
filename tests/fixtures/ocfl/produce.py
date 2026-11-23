"""Pinned independent OCFL producer and extractor; no candidate code is imported."""
import base64
import hashlib
import importlib.metadata
import inspect
import json
from pathlib import Path
import platform
import tempfile
import ocfl

REVISION = "a480226d54cf8d03d71ab8c56eb69ae8a78e231d"
PAYLOADS = [
    {"a.txt": b"first\n", "alias.txt": b"same\n", "empty": b"", "binary": bytes(range(256))},
    {"a.txt": b"second\n", "renamed.txt": b"same\n", "binary": bytes(range(256)), "mail.eml": b"From: a@example.org\r\nTo: b@example.org\r\nSubject: preserved\r\n\r\nhello\r\n"},
    {"a.txt": b"first\n", "restored.txt": b"same\n", "binary": bytes(range(256)), "twin.txt": b"same\n"},
]


def snapshot(directory):
    return [{"path": p.relative_to(directory).as_posix(), "base64": base64.b64encode(p.read_bytes()).decode(), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(directory.rglob("*")) if p.is_file()]


def main():
    objects = []
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        for algorithm in ("sha512", "sha256"):
            src = root / (algorithm + "-src")
            obj = root / (algorithm + "-object")
            metadata = {}
            for number, payload in enumerate(PAYLOADS, 1):
                version = src / ("v" + str(number))
                version.mkdir(parents=True)
                for name, data in payload.items():
                    (version / name).write_bytes(data)
                metadata[number] = ocfl.VersionMetadata(created=f"2026-01-0{number}T00:00:00Z", message=f"authored state {number}", name="OPFS fixture")
            producer = ocfl.Object(identifier="urn:example:opfs:" + algorithm, spec_version="1.1", digest_algorithm=algorithm)
            producer.build(str(src), versions_metadata=metadata, objdir=str(obj))
            valid, _ = producer.validate(str(obj))
            assert valid, "Independent producer did not validate its own unchanged bytes"
            extracts = []
            for number, expected in enumerate(PAYLOADS, 1):
                dest = root / (algorithm + "-extract" + str(number))
                producer.extract(str(obj), "v" + str(number), str(dest))
                actual = {p.relative_to(dest).as_posix(): p.read_bytes() for p in dest.rglob("*") if p.is_file()}
                assert actual == expected
                extracts.append({"version": "v" + str(number), "files": snapshot(dest)})
            objects.append({"algorithm": algorithm, "validated": valid, "files": snapshot(obj), "extracts": extracts})
    module = Path(inspect.getfile(ocfl.Object))
    output = {"producer": "zimeon/ocfl-py", "revision": REVISION, "version": importlib.metadata.version("ocfl-py"), "python": platform.python_version(), "objectModuleSha256": hashlib.sha256(module.read_bytes()).hexdigest(), "objects": objects}
    Path(__file__).with_name("independent.json").write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
