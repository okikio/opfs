/** Authored original bytes and independent native QEMU readback; no candidate reader imports. */
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { check, digest } from "../acquire.ts";
const { values } = parseArgs({ options: { output: { type: "string" } } });
check(
  values.output && process.platform === "linux",
  "Usage inside reviewed Linux tool image: create.ts --output FRESH_PATH",
);
check(!existsSync(values.output) && !existsSync(values.output + ".next"), "Fresh fixture output required.");
const CAP = 8 * 1024 * 1024;
let diagnosticBytes = 0, fixtureBytes = 0;
const commands: unknown[] = [];
function bounded(path: string): Buffer<ArrayBuffer> {
  check(statSync(path).size <= CAP, "Fixture file exceeds 8 MiB.");
  const value = readFileSync(path);
  check(value.length <= CAP, "Fixture file changed beyond its cap.");
  return value;
}
function run(argv: readonly string[], cwd: string): Buffer<ArrayBuffer> {
  // Debian dash measures -f in 512-byte blocks. Both limits are inherited
  // across exec; command text is constant and all arguments remain argv data.
  const result = spawnSync("/bin/dash", ["-c", 'ulimit -f 16384 || exit; exec "$@"', "opfs-native", ...argv], {
    cwd,
    timeout: 60_000,
    maxBuffer: CAP,
  });
  const out = result.stdout ?? Buffer.alloc(0), err = result.stderr ?? Buffer.alloc(0);
  diagnosticBytes += out.length + err.length;
  const receipt = {
    argv,
    code: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdout: out.toString(),
    stderr: err.toString(),
  };
  commands.push(receipt);
  process.stdout.write(JSON.stringify(receipt) + "\n");
  check(
    !result.error && out.length <= CAP && err.length <= CAP && diagnosticBytes <= 4 * 1024 * 1024 &&
      result.status === 0,
    "Native command failed or exceeded its diagnostic bound.",
  );
  return out;
}
function blob(value: Uint8Array): unknown {
  check(value.byteLength <= CAP, "Fixture extent exceeds 8 MiB.");
  const base64 = Buffer.from(value).toString("base64");
  fixtureBytes += value.byteLength + base64.length;
  check(fixtureBytes <= 16 * 1024 * 1024, "Original plus base64 aggregate exceeds 16 MiB.");
  return { base64, bytes: value.byteLength, sha256: digest(value) };
}
function observed(path: string, offsets: readonly number[]): unknown {
  const data = bounded(path), bits = data.readUInt32BE(20);
  check(bits >= 9 && bits <= 21, "Unexpected native cluster geometry.");
  const cluster = 2 ** bits, l1 = Number(data.readBigUInt64BE(40)), mask = 0x00fffffffffffe00n;
  check(Number.isSafeInteger(l1), "Inexact native L1 offset.");
  const entries = offsets.map((offset) => {
    const guest = Math.floor(offset / cluster),
      l2 = Number(data.readBigUInt64BE(l1 + Math.floor(guest / (cluster / 8)) * 8) & mask);
    const descriptor = l2 ? data.readBigUInt64BE(l2 + (guest % (cluster / 8)) * 8) : 0n;
    const compressed = Boolean(descriptor & (1n << 62n));
    return {
      guestOffset: offset,
      descriptor: descriptor.toString(16).padStart(16, "0"),
      explicitZero: compressed ? null : Boolean(descriptor & 1n),
      compressed,
      sourceOffset: compressed ? null : Number(descriptor & mask),
    };
  });
  const version = data.readUInt32BE(4);
  return {
    version,
    clusterSize: cluster,
    headerLength: version === 2 ? 72 : data.readUInt32BE(100),
    selectedEntries: entries,
  };
}
const root = mkdtempSync(join(tmpdir(), "opfs-qcow2-"));
try {
  const version = run(["/usr/bin/qemu-img", "--version"], root).toString();
  const ioVersion = run(["/usr/bin/qemu-io", "--version"], root).toString();
  const packages = run(["/usr/bin/dpkg-query", "-W", "-f=${Package}=${Version} ${Architecture}\n", "qemu-utils"], root)
    .toString();
  run(["/usr/bin/qemu-io", "-c", "help write"], root);
  run(["/usr/bin/qemu-io", "-c", "help read"], root);
  const fixtures: unknown[] = [], controls: unknown[] = [];
  const folder = function (name: string): string {
    const path = join(root, name);
    mkdirSync(path);
    return path;
  };
  const readback = function (image: string, expected: Uint8Array, output: string, cwd: string): void {
    run(["/usr/bin/qemu-img", "convert", "-f", "qcow2", "-O", "raw", image, output], cwd);
    check(bounded(output).equals(Buffer.from(expected)), "Native full raw readback differs from original bytes.");
  };
  for (const compat of ["0.10", "1.1"]) {
    for (const cluster of [512, 4096, 65536]) {
      const name = `compat${compat}-cluster${cluster}`,
        cwd = folder(name),
        length = cluster === 512 ? 66048 : cluster * 4;
      const original = Buffer.alloc(length), raw = join(cwd, "original.raw"), image = join(cwd, "native.qcow2");
      for (let i = 0; i < Math.min(cluster, length); i++) original[i] = (i * 17 + Math.floor(i / 257)) & 255;
      original.fill(0xa5, cluster * 2, Math.min(cluster * 3, length));
      for (let i = 0; i < 513; i++) original[length - 513 + i] = (i * 19 + 7) & 255;
      writeFileSync(raw, original);
      run([
        "/usr/bin/qemu-img",
        "convert",
        "-f",
        "raw",
        "-O",
        "qcow2",
        "-o",
        `compat=${compat},cluster_size=${cluster},lazy_refcounts=off`,
        raw,
        image,
      ], cwd);
      readback(image, original, join(cwd, "readback.raw"), cwd);
      const info: unknown = JSON.parse(
        run(["/usr/bin/qemu-img", "info", "--output=json", "-f", "qcow2", image], cwd).toString(),
      );
      const mapping: unknown = JSON.parse(
        run(["/usr/bin/qemu-img", "map", "--output=json", "-f", "qcow2", image], cwd).toString(),
      );
      const checked: unknown = JSON.parse(
        run(["/usr/bin/qemu-img", "check", "--output=json", "-f", "qcow2", image], cwd).toString(),
      );
      run(["/usr/bin/qemu-io", "-r", "-f", "qcow2", "-c", `read -P 0 ${cluster} ${cluster}`, image], cwd);
      fixtures.push({
        case: name,
        image: blob(bounded(image)),
        original: blob(original),
        observed: observed(image, [0, cluster, cluster * 2, length - 512]),
        info,
        mapping,
        check: checked,
      });
    }
  }
  for (const compat of ["0.10", "1.1"]) {
    const name = "holes-" + compat,
      cwd = folder(name),
      image = join(cwd, "native.qcow2"),
      original = Buffer.alloc(16384);
    run([
      "/usr/bin/qemu-img",
      "create",
      "-f",
      "qcow2",
      "-o",
      `compat=${compat},cluster_size=4096,lazy_refcounts=off`,
      image,
      "16384",
    ], cwd);
    readback(image, original, join(cwd, "readback.raw"), cwd);
    fixtures.push({
      case: name,
      image: blob(bounded(image)),
      original: blob(original),
      observed: observed(image, [0, 4096, 12288]),
    });
  }
  {
    const cwd = folder("zero-v3"), image = join(cwd, "native.qcow2"), original = Buffer.alloc(16384);
    run([
      "/usr/bin/qemu-img",
      "create",
      "-f",
      "qcow2",
      "-o",
      "compat=1.1,cluster_size=4096,lazy_refcounts=off",
      image,
      "16384",
    ], cwd);
    run(["/usr/bin/qemu-io", "-f", "qcow2", "-c", "write -P 165 4096 4096", "-c", "write -z 4096 4096", image], cwd);
    readback(image, original, join(cwd, "readback.raw"), cwd);
    run(["/usr/bin/qemu-io", "-r", "-f", "qcow2", "-c", "read -P 0 4096 4096", image], cwd);
    fixtures.push({
      case: "zero-v3",
      image: blob(bounded(image)),
      original: blob(original),
      observed: observed(image, [0, 4096, 8192]),
    });
  }
  const cwd = folder("controls"), original = Buffer.alloc(65536, 0xa5), raw = join(cwd, "original.raw");
  writeFileSync(raw, original);
  const compressed = join(cwd, "compressed.qcow2"),
    backing = join(cwd, "backing.qcow2"),
    saved = join(cwd, "snapshot.qcow2");
  run([
    "/usr/bin/qemu-img",
    "convert",
    "-c",
    "-f",
    "raw",
    "-O",
    "qcow2",
    "-o",
    "cluster_size=4096,compat=1.1",
    raw,
    compressed,
  ], cwd);
  run(["/usr/bin/qemu-img", "create", "-f", "qcow2", "-F", "raw", "-b", raw, backing], cwd);
  run(["/usr/bin/qemu-img", "convert", "-f", "raw", "-O", "qcow2", raw, saved], cwd);
  run(["/usr/bin/qemu-img", "snapshot", "-c", "owned-native-snapshot", saved], cwd);
  for (const [name, image] of [["compressed", compressed], ["backing", backing], ["snapshot", saved]] as const) {
    readback(image, original, join(cwd, name + ".raw"), cwd);
    controls.push({
      case: name,
      image: blob(bounded(image)),
      original: blob(original),
      observed: observed(image, [0, 4096]),
    });
  }
  const self = fileURLToPath(import.meta.url), scripts: Record<string, string> = {};
  for (
    const name of [
      self,
      join(dirname(self), "producer-run.ts"),
      join(dirname(self), "../acquire.ts"),
      join(dirname(self), "../group.ts"),
    ]
  ) scripts[name] = digest(bounded(name));
  const result = {
    qemuVersion: version,
    qemuIoVersion: ioVersion,
    packages,
    node: { version: process.version, executable: process.execPath },
    fixtures,
    controls,
    commands,
    limits: {
      fixtureOriginalAndEncodedBytes: fixtureBytes,
      maxFixtureOriginalAndEncodedBytes: 16 * 1024 * 1024,
      nativeDiagnosticBytes: diagnosticBytes,
      maxNativeDiagnosticBytes: 4 * 1024 * 1024,
    },
    scripts,
    scope: "New TypeScript/native QEMU output; historical Python receipt remains separate.",
  };
  const serialized = Buffer.from(JSON.stringify(result) + "\n");
  check(serialized.length <= 32 * 1024 * 1024, "Final fixture JSON exceeds 32 MiB.");
  mkdirSync(dirname(values.output), { recursive: true });
  writeFileSync(values.output + ".next", serialized, { flag: "wx", mode: 0o600 });
  check(!existsSync(values.output), "Output appeared before publication.");
  renameSync(values.output + ".next", values.output);
} finally {
  rmSync(root, { recursive: true });
}
