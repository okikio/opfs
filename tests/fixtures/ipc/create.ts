/** Authored originals and full Arrow C++ IPC readback; no candidate reader is imported. */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { versions } from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { verify } from "../arrow/admit.ts";
import { ARROW, LIBRARIES } from "../arrow/artifacts.ts";
import { MIB, read, run, sha } from "../arrow/files.ts";
import type { CommandType } from "../arrow/files.ts";

const { values: args } = parseArgs({ options: { artifacts: { type: "string" }, output: { type: "string" } } });
if (args.artifacts === undefined || args.output === undefined) {
  throw new TypeError("--artifacts and a new --output path are required.");
}
const artifacts = resolve(args.artifacts);
verify(artifacts, false);
const commands: CommandType[] = [];
const root = mkdtempSync(join(tmpdir(), "opfs-ipc-native-"));
const source = fileURLToPath(new URL("native.cpp", import.meta.url));
const keys = ["i", "q", "d", "b", "s", "x"] as const;
const schema = keys.map((name, index) => ({
  name,
  type: ["int32", "int64", "float64", "boolean", "utf8", "binary"][index]!,
  nullable: true,
}));
interface BatchType {
  readonly rows: number;
  readonly files: Readonly<Record<string, Buffer>>;
}

/** Canonical zero null slots let native readback compare complete buffers and masks. */
function original(rows: number, mode: "mixed" | "null" | "valid"): BatchType {
  const files: Record<string, Buffer> = {};
  const strings = ["", "hello", "café-猫", "\ufeffliteral", "🦋"];
  const integers = [-(1n << 63n), (1n << 63n) - 1n, 9007199254740993n, -9007199254740993n, 0n];
  const doubles = [0, -0, NaN, Infinity, -Infinity, Number.MIN_VALUE, Math.PI, -1.25];
  for (const key of keys) {
    const validity = Buffer.alloc(rows);
    const data = Buffer.alloc(rows * (key === "i" ? 4 : key === "q" || key === "d" ? 8 : 1));
    const offsets = Buffer.alloc((rows + 1) * 4);
    const chunks: Buffer[] = [];
    let length = 0;
    for (let row = 0; row < rows; row++) {
      const valid = mode === "valid" || (mode === "mixed" && row % 5 !== 0);
      validity[row] = valid ? 1 : 0;
      if (valid) {
        if (key === "i") data.writeInt32LE(row % 2 ? 2147483647 - row : -2147483648 + row, row * 4);
        else if (key === "q") data.writeBigInt64LE(integers[row % integers.length]!, row * 8);
        else if (key === "d") data.writeDoubleLE(doubles[row % doubles.length]!, row * 8);
        else if (key === "b") data[row] = row % 2;
        else {
          const bytes = key === "s"
            ? Buffer.from(strings[row % strings.length]!, "utf8")
            : row % 3 === 0
            ? Buffer.alloc(0)
            : Buffer.from([0, 255, 13, 10, 128, row]);
          chunks.push(bytes);
          length += bytes.length;
        }
      }
      offsets.writeInt32LE(length, (row + 1) * 4);
    }
    files[`${key}.validity`] = validity;
    if (key === "s" || key === "x") {
      files[`${key}.offsets`] = offsets;
      files[`${key}.data`] = Buffer.concat(chunks, length);
    } else files[`${key}.bin`] = data;
  }
  return { rows, files };
}

/** Preserve IEEE values including signed zero; a native writer may canonicalize NaN payload bits. */
function compare(folder: string, batch: BatchType): void {
  for (const [name, expected] of Object.entries(batch.files)) {
    const actual = read(join(folder, name), MIB);
    equal(actual.length, expected.length, `${name}: readback length differs`);
    if (name === "d.bin") {
      for (let at = 0; at < expected.length; at += 8) {
        ok(Object.is(actual.readDoubleLE(at), expected.readDoubleLE(at)), `${name}: IEEE value differs at ${at / 8}`);
      }
    } else deepStrictEqual(actual, expected, `${name}: readback bytes differ`);
  }
}
let retainedBytes = 0;
function blob(bytes: Buffer): { bytes: number; sha256: string; base64: string } {
  retainedBytes += bytes.length;
  ok(retainedBytes <= 16 * MIB, "Retained IPC corpus exceeds its aggregate byte budget.");
  return { bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString("base64") };
}
// Presence is separate from the reason: even `throw undefined` is a primary failure.
const primary: unknown[] = [];
try {
  const binary = join(root, "native");
  run([
    "c++",
    "-std=c++17",
    "-O1",
    "-Wall",
    "-Wextra",
    "-I",
    join(artifacts, "include"),
    source,
    join(artifacts, "libarrow.so.2000"),
    `-Wl,-rpath,${artifacts}`,
    "-o",
    binary,
  ], commands);
  const compiler = run(["c++", "--version"], commands);
  const scenarios = [
    { name: "schema-only", rows: [], mode: "mixed" },
    { name: "empty-batch", rows: [0], mode: "mixed" },
    { name: "mixed-multibatch", rows: [0, 17, 33], mode: "mixed" },
    { name: "all-null", rows: [3, 0, 9], mode: "null" },
    { name: "no-null", rows: [1, 33], mode: "valid" },
  ] as const;
  const fixtures: Record<string, unknown>[] = [];
  for (const scenario of scenarios) {
    const batches = scenario.rows.map((rows) => original(rows, scenario.mode));
    for (const format of ["file", "stream"] as const) {
      const folder = join(root, `${scenario.name}-${format}`);
      mkdirSync(folder);
      for (const [index, batch] of batches.entries()) {
        const destination = join(folder, `batch-${index}`);
        mkdirSync(destination);
        for (const [name, bytes] of Object.entries(batch.files)) {
          writeFileSync(join(destination, name), bytes, { flag: "wx" });
        }
      }
      const nativeReadback = run([binary, format, folder, ...scenario.rows.map(String)], commands);
      equal(nativeReadback, `Arrow C++ IPC V5 full readback: ${format} ${batches.length} batches\n`);
      for (const [index, batch] of batches.entries()) compare(join(folder, "decoded", `batch-${index}`), batch);
      const image = read(join(folder, format === "file" ? "native.arrow" : "native.arrows"), MIB);
      if (format === "file") {
        equal(image.subarray(0, 6).toString(), "ARROW1");
        equal(image.subarray(-6).toString(), "ARROW1");
      } else {
        equal(image.readUInt32LE(0), 0xffffffff);
        equal(image.subarray(-8).toString("hex"), "ffffffff00000000");
      }
      fixtures.push({
        name: `${scenario.name}-${format}`,
        format,
        metadataVersion: "V5",
        compression: "uncompressed",
        schema,
        image: blob(image),
        batches: batches.map((batch) => ({
          rows: batch.rows,
          originals: Object.fromEntries(Object.entries(batch.files).map(([name, bytes]) => [name, blob(bytes)])),
        })),
        checks: [
          "native schema and batch count",
          "full typed values and validity",
          "exact UTF8/binary offsets and bytes",
        ],
        nativeReadback: nativeReadback.trimEnd(),
      });
    }
  }
  const sources = Object.fromEntries([
    "native.cpp",
    "create.ts",
    "producer-run.ts",
    "../arrow/admit.ts",
    "../arrow/artifacts.ts",
    "../arrow/files.ts",
    "../arrow/runner.ts",
  ].map((name) => [name, sha(read(fileURLToPath(new URL(name, import.meta.url))))]));
  const receipt = JSON.stringify(
    {
      profile: "arrow-cpp-20-ipc-v5-authored-originals-v1",
      claim:
        "Arrow C++ native writer and same-library reader checked against authored originals; no candidate reader or Python runtime",
      limits:
        "Six nullable primitive fields only; no dictionary, nested types, compression, legacy IPC, unsigned integers or production support claim",
      floatComparison: "IEEE values with signed zero preserved; NaN payload bits are not compared",
      originalEncoding:
        "little-endian fixed values; one validity byte per row; int32 offsets plus raw UTF8/binary bytes",
      tools: { node: versions.node, compiler },
      artifacts: { arrow: ARROW, libraries: LIBRARIES },
      sources,
      commands,
      fixtures,
    },
    null,
    2,
  ) + "\n";
  ok(Buffer.byteLength(receipt) <= 32 * MIB, "IPC JSON receipt exceeds output budget.");
  writeFileSync(resolve(args.output), receipt, { flag: "wx" });
} catch (reason) {
  primary.push(reason);
}
try {
  rmSync(root, { recursive: true, force: true });
} catch (cleanup) {
  if (primary.length > 0) {
    throw new AggregateError([...primary, cleanup], "IPC production and owned temporary cleanup failed.", {
      cause: primary[0],
    });
  }
  throw cleanup;
}
if (primary.length > 0) throw primary[0];
