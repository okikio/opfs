"""Own the approved offline producer's finite process and log lifecycle."""
import json
import pathlib
import selectors
import subprocess
import time

name = "opfs-jwe-producer-20261105"
log_path = pathlib.Path(".tmp/implementation/jwe-producer.log")
receipt_path = pathlib.Path(".tmp/implementation/jwe-producer-launch.json")
start = time.monotonic()
failures = []
code = 0
with log_path.open("wb") as log:
    child = subprocess.Popen(["docker", "start", "-a", name], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    count = 0
    try:
        while selector.get_map():
            if time.monotonic() - start > 90:
                failures.append("90-second outer deadline")
                code = 124
                break
            for key, _ in selector.select(0.1):
                data = key.fileobj.read1(8192)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                count += len(data)
                if count > 1024 * 1024:
                    failures.append("1-MiB producer log limit")
                    code = 125
                    break
                log.write(data)
            if code:
                break
        if code:
            try:
                stopped = subprocess.run(["docker", "stop", "--time", "1", name], capture_output=True, timeout=10)
                if stopped.returncode:
                    failures.append({"stopExit": stopped.returncode})
            except BaseException as error:
                failures.append({"stopError": type(error).__name__})
        try:
            actual = child.wait(timeout=10)
            if not code:
                code = actual
        except subprocess.TimeoutExpired:
            failures.append("Docker attachment did not retire")
            code = code or 126
            child.kill()
            try:
                child.wait(timeout=10)
            except (subprocess.TimeoutExpired, OSError) as error:
                failures.append({"retirementError": type(error).__name__})
                code = code or 126
    finally:
        selector.close()
        child.stdout.close()
try:
    state = subprocess.run(["docker", "inspect", name], capture_output=True, timeout=10)
    if not state.returncode:
        pathlib.Path(".tmp/implementation/jwe-producer-state.json").write_bytes(state.stdout)
    else:
        failures.append({"inspectExit": state.returncode})
        code = code or 127
except (subprocess.TimeoutExpired, OSError) as error:
    failures.append({"inspectError": type(error).__name__})
    code = code or 127
receipt_path.write_text(json.dumps({"container": name, "exitCode": code, "failures": failures, "elapsedSeconds": time.monotonic()-start, "logBytes": log_path.stat().st_size, "deadlineSeconds":90,"maxLogBytes":1024*1024},indent=2)+"\n")
raise SystemExit(code)
