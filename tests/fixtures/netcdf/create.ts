/** Native netCDF-C profiles checked against authored complete values and record subsets; no SciPy route. */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { endianness, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const CAP = 16 * 1024 * 1024;
const { values: args } = parseArgs({
  options: {
    source: { type: "string" },
    output: { type: "string" },
    cc: { type: "string", default: "cc" },
    prlimit: { type: "string", default: "/usr/bin/prlimit" },
  },
});
if (args.source === undefined || args.output === undefined) {
  throw new TypeError("--source and a new --output destination are required.");
}
equal(endianness(), "LE", "Native dump comparisons currently require a little-endian runner.");
const source = resolve(args.source);
interface BlobType {
  readonly base64: string;
  readonly sha256: string;
}
interface VariableType {
  readonly name: string;
  readonly shape: readonly number[];
  readonly bytes: Buffer;
  readonly subset: Buffer | null;
}
interface CommandType {
  readonly argv: readonly string[];
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
const commands: CommandType[] = [];
/** A kernel per-file ceiling complements finite command time and captured diagnostics. */
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
function read(path: string): Buffer {
  const info = lstatSync(path);
  ok(info.isFile() && info.size <= CAP, "Fixture inputs and outputs must be regular files within 16 MiB.");
  return readFileSync(path);
}
function packed(data: Buffer): BlobType {
  return { base64: data.toString("base64"), sha256: createHash("sha256").update(data).digest("hex") };
}

/** Explicit LE encoding preserves signed zero and raw numeric values without a candidate decoder. */
function numbers(values: readonly number[], kind: "byte" | "short" | "int" | "float" | "double"): Buffer {
  const width = kind === "byte" ? 1 : kind === "short" ? 2 : kind === "double" ? 8 : 4;
  const out = Buffer.alloc(values.length * width);
  for (const [index, value] of values.entries()) {
    const at = index * width;
    if (kind === "byte") out.writeInt8(value, at);
    else if (kind === "short") out.writeInt16LE(value, at);
    else if (kind === "int") out.writeInt32LE(value, at);
    else if (kind === "float") out.writeFloatLE(value, at);
    else out.writeDoubleLE(value, at);
  }
  return out;
}

/** These values mirror the authored native.c workload, not bytes read from generated files. */
function variables(profile: string): VariableType[] {
  if (profile !== "mixed") {
    const kind = profile === "single-short" ? "short" : "byte";
    const original = profile === "empty" ? [] : [0, 1, 2, 3, 4, 5, 6, 7, 8];
    return [{
      name: "record",
      shape: [profile === "empty" ? 0 : 3, 3],
      bytes: numbers(original, kind),
      subset: profile === "empty" ? null : numbers(original.slice(3), kind),
    }];
  }
  const rows = [-999, 1, 2, 3, -777, 5, 6, 7, -888];
  const real = [-0, 1.25, -1.25, 0, 3.5, 9.9692099683868690e36];
  return [
    { name: "bytes", shape: [2, 3], bytes: numbers([-128, -127, -1, 0, 1, 127], "byte"), subset: null },
    { name: "characters", shape: [2, 3], bytes: Buffer.from([0, 1, 65, 127, 128, 255]), subset: null },
    { name: "shorts", shape: [2, 3], bytes: numbers([-32768, -32767, -1, 0, 1, 32767], "short"), subset: null },
    {
      name: "integers",
      shape: [2, 3],
      bytes: numbers([-2147483648, -2147483647, -1, 0, 1, 2147483647], "int"),
      subset: null,
    },
    { name: "floats", shape: [2, 3], bytes: numbers(real, "float"), subset: null },
    { name: "doubles", shape: [2, 3], bytes: numbers(real, "double"), subset: null },
    { name: "records", shape: [3, 3], bytes: numbers(rows, "short"), subset: numbers(rows.slice(3), "short") },
    { name: "scalar", shape: [], bytes: numbers([2.5], "double"), subset: null },
  ];
}
const root = mkdtempSync(join(tmpdir(), "opfs-netcdf-native-"));
try {
  const executable = join(root, "netcdf-native");
  run([args.cc, source, "-lnetcdf", "-o", executable], root);
  const compiler = run([args.cc, "--version"], root);
  const packages = run(["/usr/bin/dpkg-query", "-W", "libnetcdf-dev", "gcc", "util-linux"], root);
  const fixtures: unknown[] = [];
  for (const version of [1, 2]) {
    for (const profile of ["mixed", "single-byte", "single-char", "single-short", "empty"]) {
      const path = join(root, `native${version}-${profile}.nc`), output = join(root, `dump${version}-${profile}`);
      const producerReceipt = run([executable, "write", path, String(version), profile], root);
      mkdirSync(output);
      const receipt = run([executable, "read", path, String(version), output], root);
      const expected = variables(profile), names: string[] = [];
      const observed = expected.map((variable, id) => {
        names.push(`${id}.bin`);
        deepStrictEqual(
          read(join(output, `${id}.bin`)),
          variable.bytes,
          `${version}/${profile}/${variable.name}: full native bytes differ.`,
        );
        if (variable.subset !== null) {
          names.push(`${id}.subset`);
          deepStrictEqual(
            read(join(output, `${id}.subset`)),
            variable.subset,
            `${version}/${profile}/${variable.name}: native subset differs.`,
          );
        }
        return {
          id,
          name: variable.name,
          shape: variable.shape,
          nativeLittleEndian: packed(variable.bytes),
          subset: variable.subset === null ? null : packed(variable.subset),
        };
      });
      deepStrictEqual(readdirSync(output).sort(), names.sort());
      fixtures.push({
        producer: "netCDF-C",
        profile,
        version,
        file: packed(read(path)),
        variables: observed,
        nativeReceipt: receipt,
        producerReceipt,
      });
    }
  }
  const result = {
    byteorder: "little",
    evidence: "netCDF-C producer and consumer with authored full-byte and subset expectations; no SciPy route",
    compiler,
    packages,
    commands,
    limits: { fileBytes: CAP, diagnosticBytes: 4 * 1024 * 1024, deadlineMs: 60_000, wrapper: args.prlimit },
    sources: {
      "create.ts": packed(read(fileURLToPath(import.meta.url))).sha256,
      "native.c": packed(read(source)).sha256,
    },
    fixtures,
  };
  writeFileSync(resolve(args.output), `${JSON.stringify(result)}\n`, { flag: "wx" });
} finally {
  rmSync(root, { recursive: true, force: true });
}
