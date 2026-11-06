"""Independent native HDF5 writer/consumer proof. Test-only; no candidate imports.

Run with signed distribution h5py, NumPy and hdf5-tools in an offline bounded
container. Original arrays and byte oracles are authored before any file read.
"""
import argparse
import base64
import hashlib
import json
import math
import pathlib
import platform
import subprocess
import tempfile

import h5py
import numpy as np


def encoded(value):
    return base64.b64encode(value).decode("ascii")


def sha(value):
    return hashlib.sha256(value).hexdigest()


commands = []


def run(*argv):
    result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60, check=False)
    if len(result.stdout) > 4 * 1024 * 1024 or len(result.stderr) > 1024 * 1024:
        raise AssertionError("Native consumer exceeded its bounded receipt size")
    row = {"argv": list(argv), "exitCode": result.returncode,
           "stdout": result.stdout.decode("utf-8", errors="strict"),
           "stderr": result.stderr.decode("utf-8", errors="strict")}
    commands.append(row)
    if result.returncode:
        raise AssertionError("Native command failed: " + json.dumps(row))
    return result.stdout


def scalar(value):
    if isinstance(value, (np.integer, int)):
        return {"integer": str(int(value))}
    number = float(value)
    if math.isnan(number):
        return {"float": "nan"}
    if math.isinf(number):
        return {"float": "+infinity" if number > 0 else "-infinity"}
    if number == 0 and math.copysign(1, number) < 0:
        return {"float": "-zero"}
    return {"float": number}


def consume(path, name, original, folder, index):
    expected = original.tobytes(order="C")
    with h5py.File(path, "r") as reader:
        dataset = reader[name]
        native = dataset[()]
        actual = np.asarray(native, dtype=dataset.dtype).tobytes(order="C")
        assert actual == expected, (name, "h5py full bytes", len(actual), len(expected))
        address = dataset.id.get_offset()
        storage = dataset.id.get_storage_size()
        object_address = h5py.h5o.get_info(dataset.id).addr
        dtype = dataset.dtype.str
        shape = list(dataset.shape)
        selected_offset = max(0, original.size - 7)
        selected_count = min(5, original.size - selected_offset)
        # This original selection does not depend on candidate output or file offsets.
        selected = original.reshape(-1)[selected_offset:selected_offset + selected_count]
        native_selected = np.asarray(native).reshape(-1)[selected_offset:selected_offset + selected_count]
        assert native_selected.tobytes() == selected.tobytes(), (name, "native selected range")
    if address is not None:
        file_bytes = path.read_bytes()
        assert file_bytes[address:address + len(expected)] == expected, (name, "native allocated physical bytes")
        assert storage == len(expected), (name, "native allocated storage length")
    else:
        assert original.size == 0, (name, "unexpected unallocated positive dataset")
    binary_path = folder / (str(index) + ".bin")
    run("h5dump", "-d", "/" + name, "-b", "FILE", "-o", str(binary_path), str(path))
    created = binary_path.exists()
    binary = binary_path.read_bytes() if created else b""
    assert binary == expected, (name, "independent CLI full bytes", len(binary), len(expected), sha(binary), sha(expected))
    return {"name": name, "dtype": dtype, "shape": shape, "elements": int(original.size),
            "objectAddress": object_address, "dataAddress": address, "storageBytes": storage,
            "originalBase64": encoded(expected), "originalSha256": sha(expected),
            "values": [scalar(v) for v in original.reshape(-1)],
            "selected": {"offset": selected_offset, "count": selected_count,
                         "bytesBase64": encoded(selected.tobytes())},
            "h5pyFullBytes": True, "h5dumpFullBytes": True, "h5dumpBinaryCreated": created}


def capture(path, label, originals, folder):
    data = path.read_bytes()
    listing = run("h5dump", "-pBH", str(path)).decode("utf-8")
    rows = [consume(path, name, array, folder, label + "-" + str(i))
            for i, (name, array) in enumerate(originals.items())]
    with h5py.File(path, "r") as reader:
        links = []
        for name in reader.keys():
            link = reader.get(name, getlink=True)
            links.append({"name": name, "kind": type(link).__name__,
                          "target": link.path if isinstance(link, h5py.SoftLink) else None})
    return {"label": label, "bytesBase64": encoded(data), "sha256": sha(data),
            "h5dumpHeader": listing, "rootLinks": links, "datasets": rows}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    versions = {"python": platform.python_version(), "h5py": h5py.__version__, "numpy": np.__version__,
                "hdf5": h5py.version.hdf5_version, "h5dump": run("h5dump", "--version").decode("utf-8").strip(),
                "packages": run("dpkg-query", "-W", "python3-h5py", "python3-numpy", "hdf5-tools").decode("utf-8")}
    originals = {}
    for signed in [True, False]:
        for width in [1, 2, 4, 8]:
            bits = width * 8
            values = [-(2 ** (bits - 1)), -2, 0, 3, 2 ** (bits - 1) - 1] if signed else [0, 1, 7, 2 ** bits - 2, 2 ** bits - 1]
            for endian in (["<"] if width == 1 else ["<", ">"]):
                name = ("i" if signed else "u") + str(bits) + ("_le" if endian == "<" else "_be")
                originals[name] = np.array(values * 3, dtype=endian + ("i" if signed else "u") + str(width)).reshape(3, 5)
    for width in [4, 8]:
        for endian in ["<", ">"]:
            name = "f" + str(width * 8) + ("_le" if endian == "<" else "_be")
            originals[name] = np.array([-0.0, 1.5, -2.25, float("inf"), float("-inf"), float("nan")],
                                       dtype=endian + "f" + str(width)).reshape(2, 3)
    originals["scalar"] = np.array(-123, dtype="<i4")
    originals["empty"] = np.empty((0, 3), dtype=">u2")
    originals["grid"] = np.array([(i * 31) % 10007 - 5000 for i in range(1000)], dtype="<i4").reshape(25, 40)
    # More than the classic default SNOD capacity, exercising multiple symbol nodes.
    for i in range(16):
        originals["pad" + str(i).zfill(2)] = np.array([i + 100], dtype="<i2")
    with tempfile.TemporaryDirectory(prefix="opfs-hdf5-native-") as temp:
        folder = pathlib.Path(temp)
        classic = folder / "classic.h5"
        with h5py.File(classic, "w", libver="earliest", track_order=False) as writer:
            for name, array in originals.items():
                writer.create_dataset(name, data=array, track_times=False)
            writer["alias"] = writer["i32_le"]
            writer["soft"] = h5py.SoftLink("/i32_le")
            writer.create_group("nested", track_order=False).create_dataset("child", data=np.array([9], dtype="<i4"))
        result = [capture(classic, "classic", originals, folder)]
        unsupported = []
        for label in ["latest", "chunked", "filtered", "compound", "unallocated", "large-tree", "userblock"]:
            path = folder / (label + ".h5")
            with h5py.File(path, "w", libver="latest" if label == "latest" else "earliest",
                           **({"userblock_size": 512} if label == "userblock" else {})) as writer:
                if label == "large-tree":
                    for i in range(400):
                        writer.create_dataset("v" + str(i).zfill(4), data=np.array([i], dtype="<i4"), track_times=False)
                elif label == "unallocated":
                    writer.create_dataset("data", shape=(1000,), dtype="<i4", track_times=False)
                elif label == "compound":
                    writer.create_dataset("data", data=np.array([(1, 2)], dtype=[("a", "<i2"), ("b", "<i2")]), track_times=False)
                else:
                    writer.create_dataset("data", data=np.arange(1000, dtype="<i4"), track_times=False,
                                          **({"chunks": (64,)} if label in ["chunked", "filtered"] else {}),
                                          **({"compression": "gzip"} if label == "filtered" else {}))
            data = path.read_bytes()
            unsupported.append({"label": label, "bytesBase64": encoded(data), "sha256": sha(data),
                                "nativeHeader": run("h5dump", "-pBH", str(path)).decode("utf-8")})
        payload = {"provenance": {"versions": versions, "network": "none during production",
                                   "ownership": "authored originals; native h5py writer/read API and h5dump binary consumer; no candidate imports",
                                   "independence": "Both tools use native HDF5; they are not two independent HDF5 implementations"},
                   "files": result, "unsupported": unsupported, "commands": commands}
        pathlib.Path(args.output).write_text(json.dumps(payload, indent=2, allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
