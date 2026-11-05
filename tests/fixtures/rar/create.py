"""Author inert RAR5 fixtures with an explicitly supplied ephemeral vendor CLI.

Never downloads or redistributes executables. Every supported original payload is
independently consumed by 7zz and libarchive; unsupported profiles remain controls.
"""
import argparse
import base64
import hashlib
import json
import pathlib
import subprocess
import tempfile
import unicodedata


def run(args, cwd=None):
    result = subprocess.run(args, cwd=cwd, capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError(f"{args!r}: {result.returncode}\n{result.stdout!r}\n{result.stderr!r}")
    return result.stdout


def record(data):
    return {"base64": base64.b64encode(data).decode(), "sha256": hashlib.sha256(data).hexdigest()}


parser = argparse.ArgumentParser()
parser.add_argument("--rar", required=True)
parser.add_argument("--seven", required=True)
parser.add_argument("--tar", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
# Help/version status is diagnostic, not payload interoperability evidence.
probe = subprocess.run([args.rar, "-?"], capture_output=True, timeout=10)
receipt = {"rar": {"status": probe.returncode, "stdout": probe.stdout.decode(), "stderr": probe.stderr.decode(),
                   "binarySha256": hashlib.sha256(pathlib.Path(args.rar).read_bytes()).hexdigest()},
           "seven": run([args.seven, "i"]).decode(), "tar": run([args.tar, "--version"]).decode()}
fixtures = []
with tempfile.TemporaryDirectory(prefix="opfs-rar-") as temp:
    root = pathlib.Path(temp)
    files = {"empty": b"", "hello.txt": b"RAR5 original stored member\n", "dir/café.txt": b"UTF-8 inert name\n",
             "large.bin": bytes((i * 17 + i // 251) % 256 for i in range(150123)),
             "unrelated.bin": bytes((i * 23 + i // 127) % 256 for i in range(1024 * 1024))}
    for name, body in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
    comment = root / "comment.txt"
    comment.write_text("Authored preview fixture comment, never a metadata authority.\n")
    for profile, switches in [("stored", ["-m0", "-qo-"]), ("quick-open", ["-m0", "-qo+", "-zcomment.txt"]),
                              ("compressed", ["-m3", "-qo-"]), ("solid", ["-m3", "-s", "-qo-"]),
                              ("encrypted", ["-m0", "-pfixture-password", "-qo-"]),
                              ("header-encrypted", ["-m0", "-hpfixture-password", "-qo-"]),
                              ("volume", ["-m0", "-v64k", "-qo-"])]:
        archive = root / f"{profile}.rar"
        command = [args.rar, "a", "-ma5", "-idq", "-y", *switches, str(archive), *files]
        run(command, root)
        actual = archive if profile != "volume" else root / "volume.part01.rar"
        data = actual.read_bytes()
        fixture = {"profile": profile, "archive": record(data), "command": command[1:], "payloads": {}}
        if profile in ("stored", "quick-open"):
            # Force the 7zz parser family; do not silently fall back to another format.
            listing = run([args.seven, "l", "-tRar5", "-slt", str(actual)], root)
            fixture["listing"] = listing.decode()
            target = root / f"extract-{profile}"
            target.mkdir()
            tar_listing = run([args.tar, "-tf", str(actual)], root)
            fixture["tarListing"] = record(tar_listing)
            run([args.tar, "-xf", str(actual), "-C", str(target)], root)
            extracted = {unicodedata.normalize("NFC", str(path.relative_to(target))): path
                         for path in target.rglob("*") if path.is_file()}
            assert len(extracted) == len(files), extracted
            fixture["tarNames"] = {name: str(path.relative_to(target)) for name, path in extracted.items()}
            for name, body in files.items():
                seven = run([args.seven, "x", "-tRar5", "-so", "-spd", str(actual), name], root)
                tar = extracted[name].read_bytes()
                assert seven == body and tar == body, (profile, name)
                fixture["payloads"][name] = record(body)
        fixtures.append(fixture)
    # Genuine filesystem redirection is an inert listing/refusal control.
    (root / "alias").symlink_to("hello.txt")
    archive = root / "link.rar"
    run([args.rar, "a", "-ma5", "-m0", "-ol", "-qo-", "-idq", str(archive), "alias"], root)
    fixtures.append({"profile": "link", "archive": record(archive.read_bytes()), "payloads": {}})
pathlib.Path(args.output).write_text(json.dumps({"tools": receipt, "fixtures": fixtures}, indent=2) + "\n")
