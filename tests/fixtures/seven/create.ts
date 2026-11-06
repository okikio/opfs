/**
 * Produces genuine 7-Zip profiles and checks supported payloads with libarchive.
 *
 * Original input bytes own the oracle. Encrypted profiles retain native refusal
 * diagnostics and must never be labelled successful payload verification.
 */
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

/** Refuses links and oversized files before materializing native output. */
function read(path: string): Buffer {
  const info = lstatSync(path);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) {
    throw new Error(`Fixture file exceeds the regular 16 MiB profile: ${path}`);
  }
  return readFileSync(path);
}

/** Capture bounded diagnostics while keeping nonzero native refusals observable. */
function inspect(command: readonly string[], cwd?: string): SpawnSyncReturns<Buffer> {
  const child = spawnSync(command[0]!, command.slice(1), {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20_000,
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (child.error !== undefined || child.status === null || child.signal !== null) {
    throw new Error(JSON.stringify({ command, error: child.error?.message, signal: child.signal }));
  }
  return child;
}

/** Successful producer and supported consumer operations must exit zero. */
function run(command: readonly string[], cwd?: string): Buffer {
  const child = inspect(command, cwd);
  if (child.status !== 0) {
    throw new Error(
      JSON.stringify({
        command,
        exitCode: child.status,
        stderr: child.stderr.toString(),
        stdout: child.stdout.toString(),
      }),
    );
  }
  return child.stdout;
}

const { values: args } = parseArgs({
  options: {
    seven: { type: "string", default: "7zz" },
    bsdtar: { type: "string", default: "bsdtar" },
    output: { type: "string" },
  },
});
if (args.output === undefined) throw new TypeError("--output requires a new destination file.");
const producer = run([args.seven]).toString().split(/\r?\n/).slice(0, 5);
const consumer = run([args.bsdtar, "--version"]).toString().trim();
const profiles: Record<string, string[]> = {
  copy: ["-m0=Copy", "-ms=off", "-mhc=off"],
  lzma1: ["-m0=LZMA:d64k", "-ms=off", "-mhc=off"],
  "encoded-lzma1": ["-m0=LZMA:d64k", "-ms=off", "-mhc=on"],
  lzma2: ["-m0=LZMA2", "-ms=off", "-mhc=off"],
  solid: ["-m0=LZMA2", "-ms=on", "-mhc=off"],
  encoded: ["-m0=Copy", "-ms=off", "-mhc=on"],
  encrypted: ["-m0=Copy", "-ms=off", "-mhc=off", "-pfixture-password", "-mhe=off"],
  "encrypted-header": ["-m0=Copy", "-ms=off", "-mhc=on", "-pfixture-password", "-mhe=on"],
};
const root = mkdtempSync(join(tmpdir(), "opfs-seven-"));
try {
  const inputs = join(root, "inputs");
  mkdirSync(join(inputs, "folder"), { recursive: true });
  const bodies: Record<string, Buffer> = {
    "folder/first.bin": Buffer.from(Array.from({ length: 73 }, (_, at) => at)),
    "large.bin": Buffer.from(Array.from({ length: 131072 }, (_, at) => (at * 31 + 17) % 251)),
    "last.bin": Buffer.concat([Buffer.from("late\0binary"), Buffer.from([255]), Buffer.from("payload")]),
    "café.txt": Buffer.from("Unicode name payload"),
    "🚀.txt": Buffer.from("Surrogate pair name"),
  };
  for (let at = 0; at < 10; at++) bodies[`empty-${String(at).padStart(2, "0")}`] = Buffer.alloc(0);
  for (const [name, body] of Object.entries(bodies)) {
    const path = join(inputs, name);
    writeFileSync(path, body);
    chmodSync(path, 0o644);
    utimesSync(path, 946684800, 946684800);
  }
  chmodSync(join(inputs, "folder"), 0o755);
  utimesSync(join(inputs, "folder"), 946684800, 946684800);
  const names = ["folder", ...Object.keys(bodies).filter((name) => !name.startsWith("folder/"))];
  const entries = [
    { name: "folder", kind: "directory", body: "" },
    ...Object.entries(bodies).map(([name, body]) => ({ name, kind: "file", body: body.toString("base64") })),
  ];
  const result: Record<string, unknown> = {};
  for (const [profile, flags] of Object.entries(profiles)) {
    const archive = join(root, `${profile}.7z`);
    run([args.seven, "a", "-t7z", ...flags, "-mtm=off", "-mtc=off", "-mta=off", archive, ...names], inputs);
    const wire = read(archive);
    if (wire.length < 32) throw new Error(`${profile}: native archive is shorter than its start header.`);
    const offset = wire.readBigUInt64LE(12);
    const headerSize = wire.readBigUInt64LE(20);
    const headerAt = 32n + offset;
    if (headerSize > 0n && (headerAt >= BigInt(wire.length) || headerSize > BigInt(wire.length) - headerAt)) {
      throw new Error(`${profile}: next-header extent exceeds native output.`);
    }
    const destination = join(root, `extract-${profile}`);
    mkdirSync(destination);
    const checked = inspect([args.bsdtar, "-xf", archive, "-C", destination]);
    const supportedConsumer = profile !== "encrypted" && profile !== "encrypted-header";
    if (supportedConsumer) {
      if (checked.status !== 0) throw new Error(JSON.stringify({ profile, consumerStderr: checked.stderr.toString() }));
      for (const [name, body] of Object.entries(bodies)) {
        if (!read(join(destination, name)).equals(body)) {
          throw new Error(`${profile}: payload differs: ${name}`);
        }
      }
    }
    result[profile] = {
      producer,
      consumer,
      command: [args.seven, "a", "-t7z", ...flags, "-mtm=off", "-mtc=off", "-mta=off", `${profile}.7z`, ...names],
      consumerExitCode: checked.status,
      consumerStderr: checked.stderr.toString(),
      independentPayloadVerified: supportedConsumer,
      nextHeaderTag: headerSize === 0n ? null : wire[Number(headerAt)],
      sha256: createHash("sha256").update(wire).digest("hex"),
      archive: wire.toString("base64"),
      entries,
    };
  }
  writeFileSync(resolve(args.output), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
} finally {
  rmSync(root, { recursive: true, force: true });
}
