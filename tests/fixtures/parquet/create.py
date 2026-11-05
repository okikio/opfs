"""Produce real Parquet files with two native engines and compare every original value.

This authored harness imports only reviewed test-only native wheels and Python
stdlib. It never imports the TypeScript reader. The outer producer-run.py owns
the process-group deadline and cumulative diagnostics. Payloads and original
typed values are retained unchanged only after both independent engines agree.
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

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq


def blob(data):
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "base64": base64.b64encode(data).decode("ascii")}


def same(actual, expected):
    assert len(actual) == len(expected)
    for value, original in zip(actual, expected):
        if original is None:
            assert value is None
        elif isinstance(original, float):
            assert isinstance(value, float)
            if math.isnan(original):
                assert math.isnan(value)
            else:
                assert value == original
                if original == 0:
                    assert math.copysign(1, value) == math.copysign(1, original)
        else:
            assert value == original


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024, 8 * 1024 * 1024))
    pa.set_cpu_count(1)
    pa.set_io_thread_count(1)
    connection = duckdb.connect(":memory:", config={"threads": 1, "memory_limit": "256MB",
                                                  "autoinstall_known_extensions": False,
                                                  "autoload_known_extensions": False})
    formats = {"b": (pa.bool_(), "BOOLEAN", "B"), "i": (pa.int32(), "INTEGER", "i"),
               "q": (pa.int64(), "BIGINT", "q"), "f": (pa.float32(), "REAL", "f"),
               "d": (pa.float64(), "DOUBLE", "d")}
    seeds = {"b": [False, True, True, False], "i": [-2147483648, -1, 0, 2147483647],
             "q": [-9223372036854775808, -9007199254740993, 0, 9223372036854775807],
             "f": [-0.0, float("inf"), float("nan"), -3.5],
             "d": [-0.0, float("-inf"), float("nan"), 1.25]}
    receipts, total = [], 0
    with tempfile.TemporaryDirectory() as directory:
        root = pathlib.Path(directory)

        def retain(path, name, producer, original, supported=True):
            nonlocal total
            data = path.read_bytes()
            assert len(data) <= 2 * 1024 * 1024
            table = pq.read_table(path, page_checksum_verification=True)
            native_rows = connection.execute("SELECT * FROM read_parquet(?)", [str(path)]).fetchall()
            columns, original_bytes = [], 0
            for index, (key, expected) in enumerate(original.items()):
                same(table.column(key).to_pylist(), expected)
                same([row[index] for row in native_rows], expected)
                physical = b"".join(struct.pack("<" + formats[key][2], 0 if value is None else value) for value in expected)
                validity = bytes(value is not None for value in expected)
                columns.append({"name": key, "physicalLittleEndian": blob(physical), "validity": blob(validity)})
                original_bytes += len(physical) + len(validity)
            metadata = pq.ParquetFile(path).metadata
            group_receipts = []
            for group_index in range(metadata.num_row_groups):
                group = metadata.row_group(group_index)
                descriptors = []
                for column_index in range(group.num_columns):
                    column = group.column(column_index)
                    descriptors.append({"path": column.path_in_schema, "encodings": list(column.encodings),
                                        "codec": column.compression, "values": column.num_values,
                                        "dataPageOffset": column.data_page_offset,
                                        "dictionaryPageOffset": column.dictionary_page_offset,
                                        "storedBytes": column.total_compressed_size,
                                        "uncompressedBytes": column.total_uncompressed_size})
                    if supported:
                        assert column.compression == "UNCOMPRESSED"
                        assert set(column.encodings).issubset({"PLAIN", "RLE"})
                        assert not column.has_dictionary_page
                group_receipts.append({"rows": group.num_rows, "columns": descriptors})
            total += len(data) + original_bytes + (len(data) + original_bytes + 2) // 3 * 4
            assert total <= 16 * 1024 * 1024
            receipts.append({"case": name, "producer": producer, "supported": supported,
                             "file": blob(data), "columns": columns,
                             "rows": metadata.num_rows, "rowGroups": group_receipts,
                             "schema": str(pq.ParquetFile(path).schema),
                             "consumers": ["PyArrow full original values", "DuckDB full original values"]})

        for count, optional, label in [(0, False, "empty"), (33, False, "required"),
                                       (33, True, "nullable"), (4096, True, "many-pages")]:
            original = {}
            for key in formats:
                original[key] = [None if optional and (row % 11 < 4 or label == "many-pages" and row < 512)
                                 else seeds[key][row % 4] for row in range(count)]
            schema = pa.schema([pa.field(key, kind[0], nullable=optional) for key, kind in formats.items()])
            table = pa.Table.from_arrays([pa.array(original[key], type=kind[0]) for key, kind in formats.items()], schema=schema)
            for version in ["1.0", "2.0"]:
                for checksum in [False, True]:
                    path = root / f"arrow-{label}-{version}-{checksum}.parquet"
                    pq.write_table(table, path, compression="NONE", use_dictionary=False, column_encoding="PLAIN",
                                   write_statistics=False, store_schema=False, row_group_size=2048 if count > 33 else 9,
                                   data_page_version=version, data_page_size=128, write_batch_size=16,
                                   write_page_checksum=checksum, version="1.0")
                    retain(path, path.stem, "PyArrow", original)
            connection.execute("DROP TABLE IF EXISTS values_table")
            connection.execute("CREATE TABLE values_table (" + ",".join(key + " " + value[1] + ("" if optional else " NOT NULL") for key, value in formats.items()) + ")")
            if count:
                connection.executemany("INSERT INTO values_table VALUES (?,?,?,?,?)", list(zip(*original.values())))
            path = root / f"duckdb-{label}.parquet"
            # The pinned native binding explicitly accepts zero to disable its
            # dictionary. Actual encodings are asserted, not inferred from flags.
            connection.execute("COPY values_table TO '" + str(path) + "' (FORMAT PARQUET, COMPRESSION UNCOMPRESSED, DICTIONARY_SIZE_LIMIT 0, WRITE_BLOOM_FILTER false, PARQUET_VERSION V1, ROW_GROUP_SIZE 2048)")
            retain(path, path.stem, "DuckDB", original)

        original = {"i": [1, 2, 2, 3, 3, 3, None, 4]}
        table = pa.table({"i": pa.array(original["i"], type=pa.int32())})
        for name, opts in [("dictionary", {"use_dictionary": True, "compression": "NONE"}),
                           ("snappy", {"use_dictionary": False, "compression": "snappy"})]:
            path = root / (name + ".parquet")
            pq.write_table(table, path, **opts)
            retain(path, name, "PyArrow", original, False)
    connection.close()
    result = {"python": sys.version, "platform": platform.platform(), "pyarrow": pa.__version__,
              "duckdb": duckdb.__version__, "fixtureAccountingBytes": total, "fixtures": receipts,
              "scripts": {name: hashlib.sha256(pathlib.Path(__file__).with_name(name).read_bytes()).hexdigest()
                          for name in ["produce.py", "acquire.py", "install.py", "producer-run.py"]}}
    encoded = json.dumps(result, separators=(",", ":"), allow_nan=False).encode()
    assert len(encoded) <= 32 * 1024 * 1024
    pathlib.Path(args.output).write_bytes(encoded)
    print(json.dumps({"fixtures": len(receipts), "bytes": len(encoded), "sha256": hashlib.sha256(encoded).hexdigest()}))


if __name__ == "__main__":
    main()
