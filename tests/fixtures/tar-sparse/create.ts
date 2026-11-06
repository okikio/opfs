/**
 * Produces genuine GNU sparse TAR profiles from independently authored sparse files.
 *
 * GNU tar and libarchive must reconstruct every original logical byte. Separate
 * 7zz diagnostics remain observations and cannot establish sparse support alone.
 */
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

/** Retains finite diagnostics even when an optional consumer returns nonzero. */
function inspect(command: readonly string[], cwd?: string): SpawnSyncReturns<Buffer> {
  const child = spawnSync(command[0]!, command.slice(1), {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (child.error !== undefined || child.status === null || child.signal !== null) {
    throw new Error(JSON.stringify({ command, signal: child.signal, error: child.error?.message }));
  }
  return child;
}

/** Required native creation and full-byte consumers must exit zero. */
function run(command: readonly string[], cwd?: string): Buffer {
  const child = inspect(command, cwd);
  if (child.status !== 0) {
    throw new Error(
      JSON.stringify({
        command,
        status: child.status,
        stdout: child.stdout.toString(),
        stderr: child.stderr.toString(),
      }),
    );
  }
  return child.stdout;
}

/** Encodes exact fixture bytes without asking the candidate reader for expectations. */
function encoded(data: Uint8Array): { base64: string; sha256: string } {
  return { base64: Buffer.from(data).toString("base64"), sha256: createHash("sha256").update(data).digest("hex") };
}

const { values: args } = parseArgs({
  options: {
    tar: { type: "string" },
    bsdtar: { type: "string" },
    seven: { type: "string" },
    output: { type: "string" },
  },
});
if (args.tar === undefined || args.bsdtar === undefined || args.seven === undefined || args.output === undefined) {
  throw new TypeError("--tar, --bsdtar, --seven and --output are required.");
}
const tools = {
  tar: run([args.tar, "--version"]).toString(),
  bsdtar: run([args.bsdtar, "--version"]).toString(),
  seven: run([args.seven, "i"]).toString(),
};
const authored: Record<string, { size: number; extents: readonly (readonly [number, Buffer])[] }> = {
  "all-hole.bin": { size: 1048576, extents: [] },
  "leading.bin": { size: 262144, extents: [[131072, Buffer.from("late extent".repeat(80))]] },
  "trailing.bin": { size: 262144, extents: [[0, Buffer.from("first extent".repeat(80))]] },
  "many.bin": {
    size: 1048576,
    extents: Array.from({ length: 60 }, (_, at) => [at * 16384, Buffer.alloc(513, at % 251 + 1)] as const),
  },
  "empty.bin": { size: 0, extents: [] },
  "plain.txt": { size: 21, extents: [[0, Buffer.from("ordinary TAR payload\n")]] },
};
const root = mkdtempSync(join(tmpdir(), "opfs-tar-sparse-"));
const fixtures: unknown[] = [];
try {
  const originals: Record<string, Buffer> = {};
  for (const [name, input] of Object.entries(authored)) {
    const path = join(root, name);
    const file = openSync(path, "wx");
    try {
      ftruncateSync(file, input.size);
      for (const [offset, body] of input.extents) {
        let written = 0;
        while (written < body.length) {
          const count = writeSync(file, body, written, body.length - written, offset + written);
          if (count === 0) throw new Error(`Sparse input write made no progress: ${name}`);
          written += count;
        }
      }
    } finally {
      closeSync(file);
    }
    // Capture the physical API's logical result before any archive is created.
    originals[name] = readFileSync(path);
  }
  for (const version of ["1.0", "0.1", "0.0"]) {
    const archive = join(root, `sparse-${version}.tar`);
    const command = [
      args.tar,
      "--format=pax",
      `--sparse-version=${version}`,
      "--sparse",
      "-cf",
      archive,
      ...Object.keys(authored),
    ];
    run(command, root);
    if (statSync(archive).size > 16 * 1024 * 1024) {
      throw new Error("Native sparse archive exceeds the 16 MiB fixture budget.");
    }
    const destination = join(root, `extract-${version}`);
    mkdirSync(destination);
    run([args.bsdtar, "-xf", archive, "-C", destination], root);
    const payloads: Record<string, unknown> = {};
    for (const [name, original] of Object.entries(originals)) {
      const gnu = run([args.tar, "-xOf", archive, name], root);
      if (!gnu.equals(original) || !readFileSync(join(destination, name)).equals(original)) {
        throw new Error(`${version}: native logical payload differs: ${name}`);
      }
      const probe = inspect([args.seven, "x", "-tTar", "-so", "-spd", archive, name], root);
      payloads[name] = {
        ...encoded(original),
        seven: {
          status: probe.status,
          matches: probe.status === 0 && probe.stdout.equals(original),
          outputSha256: encoded(probe.stdout).sha256,
          stderr: probe.stderr.toString(),
        },
      };
    }
    fixtures.push({ profile: version, archive: encoded(readFileSync(archive)), command: command.slice(1), payloads });
  }
  writeFileSync(
    resolve(args.output),
    `${
      JSON.stringify(
        { tools, consumers: "GNU tar and libarchive full logical bytes; 7zz diagnostic only", fixtures },
        null,
        2,
      )
    }\n`,
    { flag: "wx" },
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
