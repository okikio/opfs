/**
 * Authored raw values feed native HDF5 C API and h5dump byte checks.
 * Both consumers use libHDF5; neither imports the candidate implementation.
 * Fresh output receives fresh source/tool receipts, never historical attribution.
 */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const CAP = 16 * 1024 * 1024;
interface CommandType {
  readonly argv: readonly string[];
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
interface DatasetType {
  readonly name: string;
  readonly dtype: string;
  readonly shape: readonly number[];
  readonly values: readonly (number | bigint)[];
  readonly body: Buffer;
}
const { values: args } = parseArgs({
  options: {
    source: { type: "string", default: fileURLToPath(new URL("native.c", import.meta.url)) },
    output: { type: "string" },
    cc: { type: "string", default: "cc" },
    h5dump: { type: "string", default: "h5dump" },
    include: { type: "string", default: "/usr/include/hdf5/serial" },
    library: { type: "string", default: "hdf5_serial" },
    prlimit: { type: "string", default: "/usr/bin/prlimit" },
  },
});
if (args.output === undefined) throw new TypeError("--output requires a new evidence destination.");
const source = resolve(args.source);
const commands: CommandType[] = [];

/** Kernel file limits and captured diagnostics bound separate native resources. */
function run(argv: readonly string[], cwd: string): string {
  const child = spawnSync(args.prlimit, [`--fsize=${CAP}:${CAP}`, "--", ...argv], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (child.error !== undefined || child.status === null || child.signal !== null) {
    throw new Error(JSON.stringify({ argv, signal: child.signal, error: child.error?.message }));
  }
  const receipt = { argv, code: child.status, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
  commands.push(receipt);
  if (child.status !== 0) throw new Error(JSON.stringify(receipt));
  return receipt.stdout;
}

/** Owned native files are admitted before materializing their complete contents. */
function read(path: string): Buffer {
  const info = lstatSync(path);
  ok(info.isFile() && info.size <= CAP, "Fixture files must be regular files within 16 MiB.");
  return readFileSync(path);
}
function sha(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** File-order input bytes are explicit, including integer widths and float signs. */
function encode(dtype: string, values: readonly (number | bigint)[]): Buffer {
  const match = /^([<>])([iuf])([1248])$/u.exec(dtype);
  ok(match !== null);
  const little = match[1] === "<", kind = match[2], width = Number(match[3]);
  const body = Buffer.alloc(values.length * width);
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  for (const [index, value] of values.entries()) {
    const at = index * width;
    if (kind === "f") {
      ok(typeof value === "number" && (width === 4 || width === 8));
      if (width === 4) view.setFloat32(at, value, little);
      else view.setFloat64(at, value, little);
    } else {
      const integer = BigInt(value);
      if (width === 8) {
        if (kind === "i") view.setBigInt64(at, integer, little);
        else view.setBigUint64(at, integer, little);
      } else {
        const number = Number(integer);
        if (width === 1) {
          if (kind === "i") view.setInt8(at, number);
          else view.setUint8(at, number);
        } else if (width === 2) {
          if (kind === "i") view.setInt16(at, number, little);
          else view.setUint16(at, number, little);
        } else {if (kind === "i") view.setInt32(at, number, little);
          else view.setUint32(at, number, little);}
      }
    }
  }
  return body;
}

/** JSON preserves exact integers and distinguishes nonfinite floats and negative zero. */
function scalar(value: number | bigint): { integer: string } | { float: number | string } {
  if (typeof value === "bigint") return { integer: String(value) };
  return {
    float: Number.isNaN(value)
      ? "nan"
      : value === Infinity
      ? "+infinity"
      : value === -Infinity
      ? "-infinity"
      : Object.is(value, -0)
      ? "-zero"
      : value,
  };
}

function originals(): DatasetType[] {
  const rows: DatasetType[] = [];
  const add = (name: string, dtype: string, shape: readonly number[], values: readonly (number | bigint)[]) => {
    equal(shape.reduce((product, size) => product * size, 1), values.length);
    rows.push({ name, dtype, shape, values, body: encode(dtype, values) });
  };
  for (const signed of [true, false]) {
    for (const width of [1, 2, 4, 8]) {
      const bits = BigInt(width * 8);
      const values = signed
        ? [-(1n << (bits - 1n)), -2n, 0n, 3n, (1n << (bits - 1n)) - 1n]
        : [0n, 1n, 7n, (1n << bits) - 2n, (1n << bits) - 1n];
      for (const endian of width === 1 ? ["<"] : ["<", ">"]) {
        add(
          `${signed ? "i" : "u"}${width * 8}_${endian === "<" ? "le" : "be"}`,
          `${endian}${signed ? "i" : "u"}${width}`,
          [3, 5],
          [...values, ...values, ...values],
        );
      }
    }
  }
  for (const width of [4, 8]) {
    for (const endian of ["<", ">"]) {
      add(`f${width * 8}_${endian === "<" ? "le" : "be"}`, `${endian}f${width}`, [2, 3], [
        -0,
        1.5,
        -2.25,
        Infinity,
        -Infinity,
        NaN,
      ]);
    }
  }
  add("scalar", "<i4", [], [-123n]);
  add("empty", ">u2", [0, 3], []);
  add("grid", "<i4", [25, 40], Array.from({ length: 1000 }, (_, index) => BigInt((index * 31) % 10007 - 5000)));
  for (let index = 0; index < 16; index++) {
    add(`pad${String(index).padStart(2, "0")}`, "<i2", [1], [BigInt(index + 100)]);
  }
  equal(rows.length, 37);
  return rows;
}

/** Native addresses are observations; safe integers are checked before file slicing. */
function address(value: string | undefined): number {
  ok(value !== undefined && /^\d+$/u.test(value));
  const number = Number(value);
  ok(Number.isSafeInteger(number) && number >= 0);
  return number;
}

const root = mkdtempSync(join(tmpdir(), "opfs-hdf5-native-"));
try {
  const inputs = join(root, "inputs"), output = join(root, "native-output");
  mkdirSync(inputs);
  mkdirSync(output);
  const datasets = originals();
  for (const dataset of datasets) writeFileSync(join(inputs, `${dataset.name}.bin`), dataset.body);
  writeFileSync(
    join(inputs, "manifest.tsv"),
    datasets.map((dataset) =>
      `${dataset.name} ${dataset.dtype} ${dataset.shape.length} ${dataset.shape[0] ?? 0} ${dataset.shape[1] ?? 0}\n`
    ).join(""),
  );
  const executable = join(root, "hdf5-native");
  run(
    [args.cc, "-std=c11", "-Wall", "-Wextra", source, `-I${args.include}`, `-l${args.library}`, "-o", executable],
    root,
  );
  const versions = {
    compiler: run([args.cc, "--version"], root),
    h5dump: run([args.h5dump, "--version"], root),
    packages: run(["/usr/bin/dpkg-query", "-W", "libhdf5-dev", "hdf5-tools", "gcc", "util-linux"], root),
  };
  const path = join(root, "classic.h5");
  run([executable, "write", "classic", path, inputs], root);
  const nativeReceipt = run([executable, "read", path, inputs, output], root);
  const lines = nativeReceipt.trimEnd().split(/\r?\n/u).map((line) => line.split("\t"));
  const nativeRows = lines.filter((row) => row[0] === "DATA");
  equal(nativeRows.length, datasets.length);
  deepStrictEqual(nativeRows.map((row) => row[1]), datasets.map((dataset) => dataset.name));
  const links = lines.filter((row) => row[0] === "LINK").map((row) => {
    equal(row.length, 4);
    return { name: row[1]!, kind: row[2]!, target: row[3] === "-" ? null : row[3]! };
  });
  deepStrictEqual(
    links.map((link) => link.name).sort(),
    [...datasets.map((dataset) => dataset.name), "alias", "soft", "nested"].sort(),
  );
  for (const link of links) {
    equal(link.kind, link.name === "soft" ? "SoftLink" : "HardLink");
    equal(link.target, link.name === "soft" ? "/i32_le" : null);
  }
  deepStrictEqual(lines.filter((row) => row[0] === "STRUCTURE"), [[
    "STRUCTURE",
    "hard-alias-and-nested-child-verified",
  ]]);
  equal(lines.length, nativeRows.length + links.length + 1);
  const file = read(path);
  const rows = datasets.map((dataset, index) => {
    const row = nativeRows[index]!;
    equal(row.length, 5);
    const objectAddress = address(row[2]),
      dataAddress = row[3] === "-" ? null : address(row[3]),
      storageBytes = address(row[4]);
    deepStrictEqual(
      read(join(output, `${dataset.name}.bin`)),
      dataset.body,
      `${dataset.name}: native complete bytes differ.`,
    );
    const width = Number(dataset.dtype.at(-1));
    const selectedOffset = Math.max(0, dataset.values.length - 7),
      selectedCount = Math.min(5, dataset.values.length - selectedOffset);
    const selected = dataset.body.subarray(selectedOffset * width, (selectedOffset + selectedCount) * width);
    deepStrictEqual(
      read(join(output, `${dataset.name}.selected`)),
      selected,
      `${dataset.name}: native coordinate selection differs.`,
    );
    if (dataAddress === null) {
      equal(dataset.values.length, 0);
      equal(storageBytes, 0);
    } else {
      equal(storageBytes, dataset.body.length);
      ok(dataAddress <= file.length && storageBytes <= file.length - dataAddress);
      deepStrictEqual(
        file.subarray(dataAddress, dataAddress + storageBytes),
        dataset.body,
        `${dataset.name}: physical extent differs.`,
      );
    }
    const binary = join(root, `h5dump-${index}.bin`);
    run([args.h5dump, "-d", `/${dataset.name}`, "-b", "FILE", "-o", binary, path], root);
    const created = existsSync(binary), dumped = created ? read(binary) : Buffer.alloc(0);
    deepStrictEqual(dumped, dataset.body, `${dataset.name}: h5dump complete bytes differ.`);
    return {
      name: dataset.name,
      dtype: dataset.dtype,
      shape: dataset.shape,
      elements: dataset.values.length,
      objectAddress,
      dataAddress,
      storageBytes,
      originalBase64: dataset.body.toString("base64"),
      originalSha256: sha(dataset.body),
      values: dataset.values.map(scalar),
      selected: { offset: selectedOffset, count: selectedCount, bytesBase64: selected.toString("base64") },
      nativeCFullBytes: true,
      nativeCSelectedBytes: true,
      h5dumpFullBytes: true,
      h5dumpBinaryCreated: created,
    };
  });
  deepStrictEqual(
    readdirSync(output).sort(),
    datasets.flatMap((dataset) => [`${dataset.name}.bin`, `${dataset.name}.selected`]).sort(),
  );
  const classic = {
    label: "classic",
    bytesBase64: file.toString("base64"),
    sha256: sha(file),
    h5dumpHeader: run([args.h5dump, "-pBH", path], root),
    rootLinks: links,
    datasets: rows,
    nativeReceipt,
  };
  const unsupported = ["latest", "chunked", "filtered", "compound", "unallocated", "large-tree", "userblock"].map(
    (label) => {
      const nativePath = join(root, `${label}.h5`);
      run([executable, "write", label, nativePath, inputs], root);
      const data = read(nativePath);
      return {
        label,
        bytesBase64: data.toString("base64"),
        sha256: sha(data),
        nativeHeader: run([args.h5dump, "-pBH", nativePath], root),
      };
    },
  );
  const result = {
    provenance: {
      versions,
      sources: { "produce.ts": sha(read(fileURLToPath(import.meta.url))), "native.c": sha(read(source)) },
      ownership: "authored originals; native HDF5 C writer/read API and h5dump binary consumer; no candidate imports",
      independence:
        "Both native paths use libHDF5. They are not two independent HDF5 implementations. No h5py run is claimed.",
      limits: { fileBytes: CAP, diagnosticBytes: 4 * 1024 * 1024, deadlineMs: 60_000, wrapper: args.prlimit },
    },
    files: [classic],
    unsupported,
    commands,
  };
  writeFileSync(resolve(args.output), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
} finally {
  rmSync(root, { recursive: true, force: true });
}
