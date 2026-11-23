"""DRAFT: start one reviewed, already-created age fixture container and retain its outcome."""
import argparse
import json
import pathlib
import re
import selectors
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument("container")
parser.add_argument("--stage", choices=["cli", "vectors", "producer"], required=True)
parser.add_argument("--deadline", type=int, choices=[180], default=180)
parser.add_argument("--output", required=True)
args = parser.parse_args()
if not re.fullmatch(r"opfs-age-[a-z0-9-]{1,64}", args.container):
    raise ValueError("Only an owned named age container can be started")
output = pathlib.Path(args.output)
output.mkdir(parents=True, exist_ok=False)
faults, primary = [], []
start = time.monotonic()
log_path = output / "output.log"
code = 0
child = None


def require(condition, message):
    if not condition:
        raise ValueError(message)


def inspect(kind, name, receipt):
    result = subprocess.run(["docker", kind, "inspect", name], capture_output=True, timeout=10)
    require(result.returncode == 0 and len(result.stdout) <= 512 * 1024, "Bounded pre-start inspection failed")
    (output / receipt).write_bytes(result.stdout)
    parsed = json.loads(result.stdout)
    require(len(parsed) == 1, "Inspection cardinality")
    return parsed[0]


def preflight():
    producer = args.stage == "producer"
    image_id = "sha256:97000ec2e6fe65be46c887c441bb83ac6cb03d46091429bb73914a75bce6991e" if producer else "sha256:8353ef33b6dea0ccf6eaf7d09905c675d0bd8f3bd38ac43d7171cf62f0e35e79"
    reference = "node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68" if producer else "python:3.13-slim-bookworm@sha256:a5a7017efc5969e00ae2b91c8eb0631049a569652aa4ffc4501769049ae45c72"
    container = inspect("container", args.container, "pre-start-container.json")
    image = inspect("image", image_id, "pre-start-image.json")
    require(image["Id"] == image_id and image["Architecture"] == "arm64" and image["Os"] == "linux", "Approved image platform/config")
    require(container["Image"] == image_id and container["Config"]["Image"] == reference, "Approved per-stage image")
    require(container["State"]["Status"] == "created" and not container["State"]["Running"], "Only a fresh stopped container may start")
    host = container["HostConfig"]
    require(host["Memory"] == 1073741824 and host["MemorySwap"] == 1073741824, "Exact RAM and no extra swap")
    require(host["NanoCpus"] == 1000000000 and host["PidsLimit"] == 128, "Exact CPU/PID quota")
    require(not container.get("Mounts") and not host.get("Binds") and not host.get("Mounts"), "No mounts")
    require(not host.get("PortBindings") and not container["Config"].get("ExposedPorts") and not host.get("PublishAllPorts"), "No ports")
    require(not host.get("CapAdd") and not host.get("Privileged") and not host.get("Devices") and not host.get("DeviceRequests"), "No added privilege/devices")
    require(not host.get("ExtraHosts") and not host.get("Links"), "No extra host authority")
    require(host["NetworkMode"] == ("none" if producer else "bridge"), "Approved per-stage network")
    require(container["Config"].get("Env") == image["Config"].get("Env"), "No added environment credentials")
    require(container["Config"]["Entrypoint"] == (["node"] if producer else ["python3"]), "Approved entrypoint")
    expected = ["/tool/produce.mjs"] if producer else ["/tool/acquire.py", args.stage, "--output", "/evidence"]
    require(container["Config"]["Cmd"] == expected, "Approved stage command")


try:
    preflight()
    with log_path.open("xb") as log:
        child = subprocess.Popen(["docker", "start", "-a", args.container], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ)
        count = 0
        try:
            while selector.get_map():
                if time.monotonic() - start > args.deadline:
                    code = 124
                    primary.append("180-second outer deadline")
                    break
                for key, _ in selector.select(0.1):
                    data = key.fileobj.read1(8192)
                    if not data:
                        selector.unregister(key.fileobj)
                        continue
                    count += len(data)
                    if count > 1024 * 1024:
                        code = 125
                        primary.append("1-MiB combined output limit")
                        break
                    log.write(data)
                if code:
                    break
            if code:
                try:
                    stop = subprocess.run(["docker", "stop", "--time", "1", args.container], capture_output=True, timeout=10)
                    if stop.returncode:
                        faults.append({"stopExit": stop.returncode})
                except (OSError, subprocess.TimeoutExpired) as error:
                    faults.append({"stopError": type(error).__name__})
            try:
                actual = child.wait(timeout=10)
                if not code:
                    code = actual
            except subprocess.TimeoutExpired:
                primary.append("Docker attachment did not retire")
                code = code or 126
                child.kill()
                try:
                    child.wait(timeout=10)
                except (OSError, subprocess.TimeoutExpired) as error:
                    faults.append({"retirementError": type(error).__name__})
        finally:
            selector.close()
            child.stdout.close()
except BaseException as error:
    primary.append({"launchError": type(error).__name__, "message": str(error)[:1024]})
    code = code or 127
finally:
    # Unexpected pipe/launch errors also retire the owned work before inspection.
    if child is not None and child.poll() is None:
        try:
            stop = subprocess.run(["docker", "stop", "--time", "1", args.container], capture_output=True, timeout=10)
            if stop.returncode:
                faults.append({"finalStopExit": stop.returncode})
        except (OSError, subprocess.TimeoutExpired) as error:
            faults.append({"finalStopError": type(error).__name__})
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            try:
                child.wait(timeout=10)
            except (OSError, subprocess.TimeoutExpired) as error:
                faults.append({"finalJoinError": type(error).__name__})
    try:
        state = subprocess.run(["docker", "inspect", args.container], capture_output=True, timeout=10)
        if state.returncode == 0 and len(state.stdout) <= 512 * 1024:
            (output / "state.json").write_bytes(state.stdout)
            actual = json.loads(state.stdout)[0]["State"]
            if actual["Running"] or actual["OOMKilled"] or actual["ExitCode"] != 0:
                code = code or 129
        else:
            faults.append({"inspectExit": state.returncode, "stdoutBytes": len(state.stdout)})
            code = code or 128
    except (OSError, subprocess.TimeoutExpired) as error:
        faults.append({"inspectError": type(error).__name__})
        code = code or 128
    (output / "launch.json").write_text(json.dumps({
        "container": args.container, "stage": args.stage, "exitCode": code, "primary": primary, "cleanupFaults": faults,
        "elapsedSeconds": time.monotonic() - start,
        "logBytes": log_path.stat().st_size if log_path.exists() else 0,
        "outerDeadlineSeconds": args.deadline, "maxLogBytes": 1024 * 1024,
    }, indent=2) + "\n")
raise SystemExit(code)
