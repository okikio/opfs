/** Arrow C++ and the official DuckDB CLI both check every authored original value. */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { versions } from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MIB, read, run, sha } from "../arrow/files.ts";
import { prepare } from "../arrow/native.ts";
import { blob, column, compare, originals, retained, save, text } from "../arrow/values.ts";
import type { ColumnType, ValueType } from "../arrow/values.ts";

const { values: args } = parseArgs({ options: { artifacts: { type: "string" }, output: { type: "string" } } });
if (args.artifacts === undefined || args.output === undefined) {
  throw new TypeError("--artifacts and a new --output path are required.");
}
const native = prepare(args.artifacts, true), fixtures: Record<string, unknown>[] = [];
const types = { b: "BOOLEAN", i: "INTEGER", q: "BIGINT", f: "REAL", d: "DOUBLE" } as const;
const keys = Object.keys(types) as (keyof typeof types)[];
let accounting = 0;
function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
function literal(value: ValueType, key: keyof typeof types): string {
  if (value === null) return "NULL";
  const printed = Object.is(value, -0)
    ? "-0.0"
    : typeof value === "number" && Number.isNaN(value)
    ? "NaN"
    : String(value);
  return `${quote(printed)}::${types[key]}`;
}
/** Explicit empty init file prevents caller RC files from changing the native oracle. */
function duck(sql: string): string {
  return run(
    [join(native.artifacts, "duckdb"), "-batch", "-bail", "-init", "/dev/null", ":memory:"],
    native.commands,
    native.root,
    ".mode tabs\n.headers off\nSET threads=1; SET memory_limit='256MB'; SET autoinstall_known_extensions=false; SET autoload_known_extensions=false;\n" +
      sql + "\n",
  );
}
function duckCompare(path: string, columns: readonly ColumnType[]): void {
  const fields = columns.map(({ key }) =>
    key === "f" || key === "d"
      ? `CASE WHEN ${key} IS NULL THEN 'null' WHEN isnan(${key}) THEN 'nan' WHEN isinf(${key}) THEN CASE WHEN signbit(${key}) THEN '-inf' ELSE 'inf' END WHEN ${key}=0 THEN CASE WHEN signbit(${key}) THEN '-0' ELSE '0' END ELSE CAST(${key} AS VARCHAR) END`
      : `CASE WHEN ${key} IS NULL THEN 'null' ELSE CAST(${key} AS VARCHAR) END`
  );
  const output = duck(
    `SELECT CAST(file_row_number AS VARCHAR),${fields.join(",")} FROM read_parquet(${
      quote(path)
    },file_row_number=true) ORDER BY file_row_number;`,
  );
  const actual = output.length === 0
    ? []
    : output.trimEnd().split("\n").map((line) => line.replace(/\r$/u, "").split("\t"));
  const rows = columns[0]!.values.length;
  const expected = Array.from(
    { length: rows },
    (_, index) => [String(index), ...columns.map((item) => text(item.values[index]!))],
  );
  deepStrictEqual(actual, expected, "DuckDB CLI full values, masks, signed zeros or row order differ.");
}
interface GroupType {
  rows: number;
  columns: Record<string, unknown>[];
}
function retain(
  folder: string,
  name: string,
  producer: string,
  columns: readonly ColumnType[],
  supported: boolean,
): void {
  const path = join(folder, "native.parquet"), decoded = join(folder, "decoded");
  const image = read(path, 2 * MIB);
  run([native.binary, "read", "parquet", path, decoded], native.commands);
  compare(decoded, columns);
  duckCompare(path, columns);
  const groups: GroupType[] = [];
  let rows = -1;
  for (const line of read(join(decoded, "metadata.tsv"), MIB).toString().trimEnd().split("\n")) {
    const item = line.split("\t");
    if (item[0] === "rows") rows = Number(item[1]);
    else if (item[0] === "group") {
      equal(Number(item[1]), groups.length);
      groups.push({ rows: Number(item[2]), columns: [] });
    } else if (item[0] === "column") {
      const group = groups[Number(item[1])];
      ok(group !== undefined);
      const encodings = item[10]!.split(",").filter(Boolean), codec = Number(item[3]);
      if (supported) {
        equal(codec, 0);
        equal(item[9], "0");
        ok(encodings.every((encoding) => ["PLAIN", "RLE"].includes(encoding)));
      }
      group.columns.push({
        path: item[2],
        codec: codec === 0 ? "UNCOMPRESSED" : codec === 1 ? "SNAPPY" : `native-${codec}`,
        values: Number(item[4]),
        dataPageOffset: Number(item[5]),
        dictionaryPageOffset: item[9] === "0" ? null : Number(item[6]),
        storedBytes: Number(item[7]),
        uncompressedBytes: Number(item[8]),
        encodings,
      });
    } else throw new Error("Unexpected native metadata record.");
  }
  equal(rows, columns[0]!.values.length);
  equal(groups.reduce((sum, group) => sum + group.rows, 0), rows);
  for (const group of groups) equal(group.columns.length, columns.length);
  accounting += image.length + columns.reduce((sum, item) => sum + item.physical.length + item.validity.length, 0);
  ok(accounting <= 16 * MIB);
  fixtures.push({
    case: name,
    producer,
    supported,
    file: blob(image),
    columns: retained(columns),
    rows,
    rowGroups: groups,
    schema: read(join(decoded, "schema.txt")).toString(),
    consumers: [
      "Arrow C++ complete original values with page CRC verification",
      "DuckDB native CLI complete original values",
    ],
  });
}
try {
  for (
    const [count, optional, label] of [[0, false, "empty"], [33, false, "required"], [33, true, "nullable"], [
      4096,
      true,
      "many-pages",
    ]] as const
  ) {
    const columns = originals(keys, count, (row) => optional && (row % 11 < 4 || label === "many-pages" && row < 512));
    for (const version of [1, 2]) {
      for (const checksum of [false, true]) {
        const name = `arrow-${label}-${version}.0-${checksum}`, folder = join(native.root, name);
        mkdirSync(folder);
        save(folder, columns);
        run([
          native.binary,
          "write",
          "parquet",
          folder,
          String(count),
          String(optional),
          String(version),
          String(checksum),
          "plain",
        ], native.commands);
        retain(folder, name, "Arrow C++ 20.0.0", columns, true);
      }
    }
    const name = `duckdb-${label}`, folder = join(native.root, name);
    mkdirSync(folder);
    const statements = [
      `CREATE TABLE values_table (${
        keys.map((key) => `${key} ${types[key]}${optional ? "" : " NOT NULL"}`).join(",")
      });`,
    ];
    if (count) {
      statements.push(
        "INSERT INTO values_table VALUES " + Array.from({ length: count }, (_, index) =>
          "(" + columns.map((item) =>
            literal(item.values[index]!, item.key as keyof typeof types)
          ).join(",") + ")")
          .join(",") +
          ";",
      );
    }
    statements.push(
      `COPY values_table TO ${
        quote(join(folder, "native.parquet"))
      } (FORMAT PARQUET, COMPRESSION UNCOMPRESSED, DICTIONARY_SIZE_LIMIT 0, WRITE_BLOOM_FILTER false, PARQUET_VERSION V1, ROW_GROUP_SIZE 2048);`,
    );
    duck(statements.join("\n"));
    retain(folder, name, "DuckDB official 1.3.2 CLI", columns, true);
  }
  const controls = [column("i", [1, 2, 2, 3, 3, 3, null, 4])];
  for (const profile of ["dictionary", "snappy"]) {
    const folder = join(native.root, profile);
    mkdirSync(folder);
    save(folder, controls);
    run([native.binary, "write", "parquet", folder, "8", "true", "1", "false", profile], native.commands);
    retain(folder, profile, "Arrow C++ 20.0.0", controls, false);
  }
  equal(fixtures.length, 22);
  const encoded = JSON.stringify({
    fixtures,
    fixtureAccountingBytes: accounting,
    qualification:
      "Arrow C++ and official DuckDB CLI full-value agreement; changed binding/artifact profile, not historical Python execution",
    commands: native.commands,
    sourceSha256: native.sourceSha256,
    sources: native.sources,
    admission: JSON.parse(read(join(native.artifacts, "admission.json")).toString()) as unknown,
    producerSha256: sha(read(fileURLToPath(import.meta.url))),
    tools: {
      compiler: run(["c++", "--version"], native.commands),
      duckdb: run([join(native.artifacts, "duckdb"), "--version"], native.commands),
      node: versions,
    },
  });
  ok(Buffer.byteLength(encoded) <= 32 * MIB);
  writeFileSync(resolve(args.output), encoded + "\n", { flag: "wx" });
} finally {
  native.close();
}
