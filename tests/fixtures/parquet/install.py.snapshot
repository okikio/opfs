"""Install only admitted local wheels offline, without importing their packages."""
import hashlib
import importlib.metadata
import json
import os
import pathlib
import selectors
import signal
import subprocess
import sys
import time

root = pathlib.Path("/receipts")
receipt = json.loads((root / "acquisition.json").read_text())
assert len(receipt["artifacts"]) == 2
paths = []
for item in receipt["artifacts"]:
    path = root / "wheels" / item["url"].rsplit("/", 1)[1]
    assert path.stat().st_size == item["bytes"]
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while data := source.read(65536):
            digest.update(data)
    assert digest.hexdigest() == item["sha256"]
    paths.append(str(path))
started = time.monotonic()
child = subprocess.Popen([sys.executable, "-m", "pip", "install", "--no-index", "--no-deps", "--no-compile",
                          "--disable-pip-version-check", *paths], stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, start_new_session=True)
assert child.stdout is not None
selector = selectors.DefaultSelector()
selector.register(child.stdout, selectors.EVENT_READ)
output = bytearray()
failure = None
try:
    while selector.get_map():
        if time.monotonic() - started > 120:
            raise TimeoutError("Offline installation deadline")
        for key, _ in selector.select(0.25):
            data = os.read(key.fileobj.fileno(), 65536)
            if not data:
                selector.unregister(key.fileobj)
            else:
                if len(output) + len(data) > 4 * 1024 * 1024:
                    raise ValueError("Offline installation diagnostic limit")
                output.extend(data)
    code = child.wait(timeout=max(1, 120 - (time.monotonic() - started)))
except BaseException as error:
    failure = repr(error)
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    code = child.wait(timeout=5)
finally:
    selector.close()
    child.stdout.close()
(root / "install.log").write_bytes(output)
record = {"exit": code, "failure": failure, "seconds": time.monotonic() - started,
          "diagnosticBytes": len(output), "python": sys.version,
          "scriptSha256": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()}
if code == 0 and not failure:
    record["installedMetadata"] = {name: importlib.metadata.version(name) for name in ["pyarrow", "duckdb"]}
(root / "install.json").write_text(json.dumps(record, indent=2))
sys.stdout.buffer.write(output)
sys.exit(1 if failure else code)
