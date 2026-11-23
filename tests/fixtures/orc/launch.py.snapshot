"""Create, inspect and attach only an explicitly approved offline ORC stage.

This launcher is inert until invoked. Installation and native production need
separate root GO; no pull, SDK import, image commit or subsequent stage is done.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import selectors
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", choices=["install", "native"], required=True)
    parser.add_argument("--image-id", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--receipts", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    assert re.fullmatch(r"sha256:[0-9a-f]{64}", args.image_id), "Use the actual immutable local image ID"
    assert re.fullmatch(r"opfs-orc-(?:install|native)-[a-z0-9-]{1,60}", args.name)
    assert args.name.startswith("opfs-orc-" + args.stage + "-")
    args.output.mkdir(parents=True, exist_ok=False)
    deadline = 150 if args.stage == "install" else 210
    started = time.monotonic()
    result = {"stage": args.stage, "name": args.name, "image": args.image_id,
              "launcherSha256": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
              "deadlineSeconds": deadline, "failures": [], "commands": []}
    result["copyOutPaths"] = ["/tmp/orc-install/install.json", "/tmp/orc-install/install.log"] if args.stage == "install" else [
        "/tmp/native-state.json", "/tmp/native.log", "/tmp/independent.json"]
    created = False
    attachment = None
    code = 1

    def command(argv, label, maximum=4 * 1024 * 1024):
        # Docker inspection/copy/create diagnostics are also finite and retained.
        allowance = 30 if label in ["stop", "final-inspect"] else min(30, deadline - (time.monotonic() - started))
        if allowance <= 0:
            raise TimeoutError(label + " outer deadline before dispatch")
        child = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        selector = selectors.DefaultSelector()
        counts = {"stdout": 0, "stderr": 0}
        buffers = {"stdout": bytearray(), "stderr": bytearray()}
        for kind, pipe in [("stdout", child.stdout), ("stderr", child.stderr)]:
            selector.register(pipe, selectors.EVENT_READ, kind)
        began = time.monotonic()
        try:
            while selector.get_map():
                if time.monotonic() - began > allowance:
                    raise TimeoutError(label + " deadline")
                for key, _ in selector.select(0.1):
                    data = os.read(key.fileobj.fileno(), 65536)
                    if not data:
                        selector.unregister(key.fileobj)
                        continue
                    kind = key.data
                    counts[kind] += len(data)
                    if sum(counts.values()) > maximum:
                        raise ValueError(label + " diagnostic cap")
                    buffers[kind].extend(data)
            status = child.wait(timeout=5)
        finally:
            selector.close()
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            child.stdout.close()
            child.stderr.close()
            for kind, data in buffers.items():
                (args.output / (label + "." + kind)).write_bytes(data)
        result["commands"].append({"label": label, "argv": argv, "exit": status,
                                   "bytes": counts, "seconds": time.monotonic() - began})
        if status:
            raise RuntimeError(label + " exit " + str(status))
        return bytes(buffers["stdout"])

    try:
        image = json.loads(command(["docker", "image", "inspect", args.image_id], "image-inspect"))[0]
        assert image["Id"] == args.image_id and image["Os"] == "linux" and image["Architecture"] == "arm64"
        if args.stage == "install":
            assert any(value.endswith("@sha256:a58daefb915e1e03ad48f3ca4df8832065412c5c35cacb9d39f4229184de12b6")
                       for value in image.get("RepoDigests", [])), "Installation requires the pinned public Python base"
        entry = "/install.py" if args.stage == "install" else "/producer-run.py"
        command(["docker", "create", "--pull", "never", "--name", args.name, "--network", "none", "--memory", "1g",
                 "--memory-swap", "1g", "--cpus", "1", "--pids-limit", "128", "--cap-drop", "ALL",
                 "--security-opt", "no-new-privileges=true", "--restart", "no", "--entrypoint",
                 "/usr/local/bin/python3", args.image_id, "-I", entry], "create")
        created = True
        base = pathlib.Path(__file__).resolve().parent
        files = {"install.py": "/install.py"} if args.stage == "install" else {
            "install.py": "/install.py", "create.py": "/produce.py", "producer-run.py": "/producer-run.py"}
        result["scripts"] = {}
        for source, target in files.items():
            path = base / source
            result["scripts"][source] = hashlib.sha256(path.read_bytes()).hexdigest()
            command(["docker", "cp", str(path), args.name + ":" + target], "copy-" + source)
        if args.stage == "install":
            assert args.receipts is not None
            receipt = json.loads((args.receipts / "acquisition.json").read_text())
            assert len(receipt["artifacts"]) == 1
            item = receipt["artifacts"][0]
            assert item["sha256"] == "991f85b48a8a5e839b2128590ce07611fae48a904cae6cab1f089c5955b57eb5"
            assert item["bytes"] == 40677027
            filename = item["url"].rsplit("/", 1)[1]
            assert re.fullmatch(r"[a-zA-Z0-9_.-]+\.whl", filename)
            wheel = args.receipts / "wheels" / filename
            assert wheel.stat().st_size == item["bytes"]
            digest = hashlib.sha256()
            with wheel.open("rb") as source:
                while data := source.read(65536):
                    digest.update(data)
            assert digest.hexdigest() == item["sha256"]
            # A private staging directory must contain only the admitted inputs.
            assert sorted(path.name for path in args.receipts.iterdir()) == ["acquisition.json", "wheels"]
            assert sorted(path.name for path in (args.receipts / "wheels").iterdir()) == [filename]
            result["acquisitionSha256"] = hashlib.sha256((args.receipts / "acquisition.json").read_bytes()).hexdigest()
            command(["docker", "cp", str(args.receipts), args.name + ":/receipts"], "copy-receipts")
        state = json.loads(command(["docker", "inspect", args.name], "created-inspect"))[0]
        host, config = state["HostConfig"], state["Config"]
        assert state["Image"] == args.image_id and config["Image"] == args.image_id
        assert state["State"]["Status"] == "created" and not state["State"]["Running"]
        assert state["State"]["StartedAt"].startswith("0001-")
        assert host["Memory"] == host["MemorySwap"] == 1073741824
        assert host["NanoCpus"] == 1000000000 and host["PidsLimit"] == 128
        assert host["NetworkMode"] == "none" and not host["Privileged"]
        assert not state["Mounts"] and not host.get("Binds") and not config.get("Volumes")
        assert not host.get("PortBindings") and not config.get("ExposedPorts")
        assert not host.get("CapAdd") and host["CapDrop"] == ["ALL"]
        assert "no-new-privileges=true" in host["SecurityOpt"]
        assert not host.get("Devices") and not host.get("DeviceRequests")
        assert host["RestartPolicy"]["Name"] == "no"
        assert config["Entrypoint"] == ["/usr/local/bin/python3"] and config["Cmd"] == ["-I", entry]
        result["preflight"] = "passed-before-start"
        attachment = subprocess.Popen(["docker", "start", "-a", args.name], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        selector = selectors.DefaultSelector()
        counts = {"stdout": 0, "stderr": 0}
        with (args.output / "native.stdout").open("wb") as stdout, (args.output / "native.stderr").open("wb") as stderr:
            for kind, pipe, sink in [("stdout", attachment.stdout, stdout), ("stderr", attachment.stderr, stderr)]:
                selector.register(pipe, selectors.EVENT_READ, (kind, sink))
            try:
                while selector.get_map():
                    if time.monotonic() - started > deadline:
                        raise TimeoutError("Stage outer deadline")
                    for key, _ in selector.select(0.1):
                        data = os.read(key.fileobj.fileno(), 65536)
                        if not data:
                            selector.unregister(key.fileobj)
                            continue
                        kind, sink = key.data
                        counts[kind] += len(data)
                        if sum(counts.values()) > 5 * 1024 * 1024:
                            raise ValueError("Stage attachment diagnostic cap")
                        sink.write(data)
                code = attachment.wait(timeout=10)
            finally:
                selector.close()
                attachment.stdout.close()
                attachment.stderr.close()
        result["attachmentBytes"] = counts
        assert code == 0, "Attached stage failed"
    except BaseException as error:
        result["failures"].append(repr(error))
        if created:
            try:
                command(["docker", "stop", "--time", "1", args.name], "stop")
            except BaseException as cleanup:
                result["failures"].append("Stop: " + repr(cleanup))
        if attachment and attachment.poll() is None:
            attachment.kill()
            try:
                attachment.wait(timeout=10)
            except BaseException as cleanup:
                result["failures"].append("Attachment retirement: " + repr(cleanup))
        code = code or 1
    finally:
        if created:
            try:
                state = json.loads(command(["docker", "inspect", args.name], "final-inspect"))[0]
                result["finalStatus"] = state["State"]
                if state["State"]["Running"] or state["State"]["OOMKilled"] or state["State"]["ExitCode"] != 0:
                    code = code or 1
            except BaseException as error:
                result["failures"].append("Final inspection: " + repr(error))
                code = code or 1
        result["exit"] = code
        result["seconds"] = time.monotonic() - started
        (args.output / "launch.json").write_text(json.dumps(result, indent=2) + "\n")
    return code


if __name__ == "__main__":
    sys.exit(main())
