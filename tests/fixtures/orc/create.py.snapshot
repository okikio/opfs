"""Author fixed ORC files with reviewed PyArrow, then read every original value.

Writer and reader share Apache C++ ORC. This is native wire/original-value proof
against the separate TypeScript reader, not two independent native engines.
The outer wrapper bounds process lifetime and cumulative diagnostic output.
"""
import argparse
import base64
import hashlib
import json
import math
import pathlib
import platform
import resource
import struct
import sys
import tempfile

import pyarrow as pa
import pyarrow.orc as orc


def blob(data):
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "base64": base64.b64encode(data).decode("ascii")}


def wire(data):
    at = 0

    def integer():
        nonlocal at
        result = 0
        for shift in range(0, 70, 7):
            assert at < len(data)
            byte = data[at]
            at += 1
            result |= (byte & 127) << shift
            if byte < 128:
                assert result < 1 << 64
                return result
        raise ValueError("Native wire varint exceeds uint64")

    result = {}
    while at < len(data):
        tag = integer()
        field, kind = tag >> 3, tag & 7
        assert field > 0
        if kind == 0:
            value = integer()
        elif kind == 2:
            length = integer()
            assert length <= len(data) - at
            value = data[at:at + length]
            at += length
        elif kind in (1, 5):
            length = 8 if kind == 1 else 4
            assert length <= len(data) - at
            value = data[at:at + length]
            at += length
        else:
            raise ValueError("Native wire group/invalid tag")
        result.setdefault(field, []).append(value)
    return result


def same(actual, original):
    assert len(actual) == len(original)
    for value, expected in zip(actual, original):
        if expected is None:
            assert value is None
        elif isinstance(expected, float):
            assert isinstance(value, float)
            if math.isnan(expected):
                assert math.isnan(value)
            else:
                assert value == expected
                if expected == 0:
                    assert math.copysign(1, value) == math.copysign(1, expected)
        else:
            assert value == expected


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024 * 1024, 32 * 1024 * 1024))
    pa.set_cpu_count(1)
    pa.set_io_thread_count(1)
    formats = {"b": (pa.bool_(), "B"), "y": (pa.int8(), "b"), "s": (pa.int16(), "h"),
               "i": (pa.int32(), "i"), "q": (pa.int64(), "q"), "f": (pa.float32(), "f"), "d": (pa.float64(), "d")}
    seeds = {"b": [False, True, True, False], "y": [-128, -1, 0, 127], "s": [-32768, -1, 0, 32767],
             "i": [-2147483648, -1, 0, 2147483647],
             "q": [-9223372036854775808, -9007199254740993, 0, 9223372036854775807],
             "f": [-0.0, float("inf"), float("nan"), -3.5],
             "d": [-0.0, float("-inf"), float("nan"), 1.25]}
    cases, total = [], 0
    with tempfile.TemporaryDirectory() as directory:
        for version in ["0.11", "0.12"]:
            for rows in [0, 37, 8192]:
                for nulls in ["none", "mixed", "all"]:
                    original = {key: [None if nulls == "all" or (nulls == "mixed" and index % 5 == 0) else seed[index % len(seed)]
                                      for index in range(rows)] for key, seed in seeds.items()}
                    table = pa.table({key: pa.array(values, type=formats[key][0]) for key, values in original.items()})
                    path = pathlib.Path(directory) / (version + "-" + str(rows) + "-" + str(nulls) + ".orc")
                    orc.write_table(table, path, file_version=version, compression="uncompressed",
                                    stripe_size=4096, batch_size=256, row_index_stride=1000,
                                    padding_tolerance=0.0, dictionary_key_size_threshold=0.0)
                    data = path.read_bytes()
                    assert len(data) <= 2 * 1024 * 1024
                    native = orc.ORCFile(path)
                    assert native.nrows == rows
                    if rows == 8192 and nulls == "none":
                        assert native.nstripes > 1, "Native stripe-size settings did not produce the intended multi-stripe case"
                    actual = native.read()
                    columns = []
                    for key, values in original.items():
                        same(actual.column(key).to_pylist(), values)
                        physical = b"".join(struct.pack("<" + formats[key][1], 0 if value is None else value) for value in values)
                        columns.append({"name": key, "physicalLittleEndian": blob(physical),
                                        "validity": blob(bytes(value is not None for value in values))})
                        total += len(physical) + len(values)
                    assert data[:3] == b"ORC"
                    post = wire(data[-1 - data[-1]:-1])
                    assert post.get(2, [0])[-1] == 0
                    minor = int(version.split(".")[1])
                    assert post[4] in ([bytes([0, minor])], [0, minor])
                    footer_start = len(data) - 1 - data[-1] - post[1][-1]
                    footer = wire(data[footer_start:len(data) - 1 - data[-1]])
                    metadata_start = footer_start - post.get(5, [0])[-1]
                    header = footer[1][-1]
                    declared = footer[2][-1]
                    basis = "body" if declared + header == metadata_start else "header-and-body" if declared == metadata_start else None
                    assert basis is not None
                    stripes = []
                    for raw in footer.get(3, []):
                        stripe = wire(raw)
                        offset, index, body, length, count = [stripe.get(field, [0])[-1] for field in range(1, 6)]
                        info = wire(data[offset + index + body:offset + index + body + length])
                        kinds = [wire(column).get(1, [0])[-1] for column in info[2]]
                        assert len(kinds) == 8
                        assert kinds[0] == 0
                        for column in range(1, 8):
                            assert kinds[column] == (2 if version == "0.12" and column in [3, 4, 5] else 0)
                        stripes.append({"offset": offset, "indexBytes": index, "dataBytes": body,
                                        "footerBytes": length, "rows": count, "encodings": kinds})
                    assert len(stripes) == native.nstripes
                    total += len(data)
                    assert total <= 16 * 1024 * 1024
                    cases.append({"name": path.name, "fileVersion": version, "rows": rows, "nulls": nulls,
                                  "file": blob(data), "columns": columns, "stripes": stripes,
                                  "contentLengthBasis": basis})
    scripts = {name: hashlib.sha256(pathlib.Path(__file__).with_name(name).read_bytes()).hexdigest()
               for name in ["produce.py", "install.py", "producer-run.py"]}
    encoded = json.dumps({"python": sys.version, "platform": platform.platform(), "pyarrow": pa.__version__,
                          "qualification": "Apache C++ ORC writer and reader share a native implementation",
                          "scripts": scripts, "fixtures": cases}, allow_nan=False, separators=(",", ":")).encode()
    assert len(encoded) <= 32 * 1024 * 1024
    pathlib.Path(args.output).write_bytes(encoded)
    print(json.dumps({"cases": len(cases), "retainedBinaryBytes": total, "jsonBytes": len(encoded),
                      "sha256": hashlib.sha256(encoded).hexdigest()}))


if __name__ == "__main__":
    main()
