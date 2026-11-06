"""Retain bounded combined diagnostics and retire the complete native process group."""
import json
import os
import pathlib
import selectors
import signal
import subprocess
import sys
import time

started = time.monotonic()
child = subprocess.Popen([sys.executable, "-I", "/produce.py", "--output", "/tmp/independent.json"],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
assert child.stdout is not None
selector = selectors.DefaultSelector()
selector.register(child.stdout, selectors.EVENT_READ)
output = bytearray()
failure = None
try:
    while selector.get_map():
        if time.monotonic() - started > 180:
            raise TimeoutError("Native producer deadline")
        for key, _ in selector.select(0.25):
            data = os.read(key.fileobj.fileno(), 65536)
            if not data:
                selector.unregister(key.fileobj)
            else:
                if len(output) + len(data) > 4 * 1024 * 1024:
                    raise ValueError("Native producer diagnostic limit")
                output.extend(data)
    code = child.wait(timeout=max(1, 180 - (time.monotonic() - started)))
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
pathlib.Path("/tmp/native.log").write_bytes(output)
pathlib.Path("/tmp/native-state.json").write_text(json.dumps({"exit": code, "failure": failure,
                                                            "seconds": time.monotonic() - started,
                                                            "diagnosticBytes": len(output)}, indent=2))
sys.stdout.buffer.write(output)
sys.exit(1 if failure else code)
