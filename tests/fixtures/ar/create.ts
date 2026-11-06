/**
 * Produces independent GNU/BSD ar fixtures and checks them with the other writer's reader.
 *
 * Native bsdtar supplies the nested USTAR image; built-in gzip wraps it. Neither
 * archive creation nor extraction imports the candidate OPFS implementation.
 */
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

/** Refuses links and oversized files before materializing native output. */
function read(path: string): Buffer {
  const info = lstatSync(path);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) {
    throw new Error(`Fixture file exceeds the regular 16 MiB profile: ${path}`);
  }
  return readFileSync(path);
}

/** Every native command has a deadline and bounded captured output. */
function inspect(command: readonly string[], cwd?: string): SpawnSyncReturns<Buffer> {
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20_000,
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error !== undefined || result.signal !== null || result.status === null) {
    throw new Error(JSON.stringify({ command, signal: result.signal, error: result.error?.message }));
  }
  return result;
}

/** Required producer and cross-reader operations must complete successfully. */
function run(command: readonly string[], cwd?: string): Buffer {
  const result = inspect(command, cwd);
  if (result.status !== 0) {
    throw new Error(
      JSON.stringify({
        command,
        exitCode: result.status,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      }),
    );
  }
  return result.stdout;
}

const { values: args } = parseArgs({
  options: {
    gnu: { type: "string", default: "ar" },
    llvm: { type: "string", default: "llvm-ar" },
    bsdtar: { type: "string", default: "bsdtar" },
    output: { type: "string" },
  },
});
if (args.output === undefined) throw new TypeError("--output requires a new destination file.");
const root = mkdtempSync(join(tmpdir(), "opfs-ar-"));
try {
  const nestedBody = Buffer.from("Package: fixture\nVersion: 1.0\nArchitecture: all\n");
  const control = join(root, "control");
  writeFileSync(control, nestedBody);
  chmodSync(control, 0o644);
  utimesSync(control, 0, 0);
  run([args.bsdtar, "--format=ustar", "-cf", "control.tar", "control"], root);
  const bodies: Record<string, Buffer> = {
    "first.bin": Buffer.from(Array.from({ length: 73 }, (_, at) => at)),
    "large.bin": Buffer.from(Array.from({ length: 131072 }, (_, at) => (at * 31 + 17) % 251)),
    "last.bin": Buffer.concat([Buffer.from("late\0binary"), Buffer.from([255]), Buffer.from("payload")]),
    empty: Buffer.alloc(0),
    "1234567890123456": Buffer.from("sixteen-byte name"),
    "a long filename with spaces.bin": Buffer.from("long name payload"),
    "café storage.bin": Buffer.from("Unicode payload"),
    "control.tar.gz": gzipSync(read(join(root, "control.tar"))),
  };
  for (const [name, body] of Object.entries(bodies)) {
    const path = join(root, name);
    writeFileSync(path, body);
    chmodSync(path, 0o644);
    utimesSync(path, 946684800, 946684800);
  }
  const profiles = [
    { name: "gnu", tool: args.gnu, flags: [], consumer: args.llvm },
    { name: "bsd", tool: args.llvm, flags: ["--format=bsd"], consumer: args.gnu },
  ];
  const result: Record<string, unknown> = {};
  for (const profile of profiles) {
    const archive = join(root, `${profile.name}.a`);
    run([profile.tool, ...profile.flags, "qcD", archive, ...Object.keys(bodies)], root);
    const destination = join(root, `extract-${profile.name}`);
    const diagnosticDestination = join(root, `libarchive-${profile.name}`);
    mkdirSync(destination);
    mkdirSync(diagnosticDestination);
    // GNU's // metadata member can fail native libarchive extraction. Keep that
    // diagnostic distinct from the separate successful cross-ar byte comparison.
    const diagnostic = inspect([args.bsdtar, "-xf", archive, "-C", diagnosticDestination]);
    run([profile.consumer, "x", archive], destination);
    for (const [name, expected] of Object.entries(bodies)) {
      if (!read(join(destination, name)).equals(expected)) {
        throw new Error(`${profile.name}: payload differs: ${name}`);
      }
    }
    const data = read(archive);
    result[profile.name] = {
      producer: run([profile.tool, "--version"]).toString().split(/\r?\n/).slice(0, 3),
      consumer: run([profile.consumer, "--version"]).toString().split(/\r?\n/).slice(0, 3),
      consumerCommand: [profile.consumer, "x", `${profile.name}.a`],
      libarchiveExtraction: {
        version: run([args.bsdtar, "--version"]).toString().trim(),
        exitCode: diagnostic.status,
        stdout: diagnostic.stdout.toString(),
        stderr: diagnostic.stderr.toString(),
      },
      command: [profile.tool, ...profile.flags, "qcD", `${profile.name}.a`, ...Object.keys(bodies)],
      independentPayloadVerified: true,
      sha256: createHash("sha256").update(data).digest("hex"),
      archive: data.toString("base64"),
      entries: Object.entries(bodies).map(([name, body]) => ({ name, body: body.toString("base64") })),
      nestedControl: nestedBody.toString("base64"),
    };
  }
  writeFileSync(resolve(args.output), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
} finally {
  rmSync(root, { recursive: true, force: true });
}
