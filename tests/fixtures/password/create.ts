/**
 * Produces genuine ZipCrypto archives with reciprocal native payload consumers.
 *
 * InfoZIP unzip consumes 7-Zip output; 7-Zip consumes the InfoZIP stdin profile.
 * Original bytes remain the oracle. Passwords below are public fixture data.
 */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

/** Native refusal stays diagnostic; failed required commands do not become fixtures. */
function inspect(command: readonly string[], cwd?: string, input?: Uint8Array): SpawnSyncReturns<Buffer> {
  const child = spawnSync(command[0]!, command.slice(1), {
    cwd,
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout: 20_000,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (child.error !== undefined || child.status === null || child.signal !== null) {
    throw new Error(JSON.stringify({ command, signal: child.signal, error: child.error?.message }));
  }
  return child;
}

/** Runs an independently installed native producer or consumer to successful completion. */
function run(command: readonly string[], cwd?: string, input?: Uint8Array): Buffer {
  const child = inspect(command, cwd, input);
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

/** Checks the native archive budget before materializing its bytes. */
function readArchive(path: string): Buffer {
  ok(statSync(path).size <= 1024 * 1024, "Native ZipCrypto archive exceeds the 1 MiB fixture budget.");
  return readFileSync(path);
}

/**
 * Reads only central flags from this small fixture profile.
 * Native consumers, rather than this authored metadata check, own ZIP acceptance.
 */
function flags(bytes: Buffer, names: readonly string[]): Record<string, number> {
  ok(bytes.length >= 22 && bytes.length <= 1024 * 1024);
  const end = bytes.length - 22;
  equal(bytes.readUInt32LE(end), 0x06054b50);
  equal(bytes.readUInt16LE(end + 20), 0);
  equal(bytes.readUInt16LE(end + 10), names.length);
  let at = bytes.readUInt32LE(end + 16);
  const result: Record<string, number> = {};
  for (let index = 0; index < names.length; index++) {
    ok(at >= 0 && at + 46 <= end);
    equal(bytes.readUInt32LE(at), 0x02014b50);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const next = at + 46 + nameLength + extraLength + commentLength;
    ok(next <= end);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(at + 46, at + 46 + nameLength));
    ok(names.includes(name) && !Object.hasOwn(result, name));
    result[name] = bytes.readUInt16LE(at + 8);
    ok((result[name]! & 1) !== 0, "Native ZipCrypto fixture must be encrypted.");
    at = next;
  }
  equal(at, bytes.readUInt32LE(end + 16) + bytes.readUInt32LE(end + 12));
  deepStrictEqual(Object.keys(result).sort(), [...names].sort());
  return result;
}

const { values: args } = parseArgs({
  options: {
    seven: { type: "string", default: "7zz" },
    zip: { type: "string", default: "zip" },
    unzip: { type: "string", default: "unzip" },
    output: { type: "string" },
  },
});
if (args.output === undefined) throw new TypeError("--output requires a separate fixture destination.");
const password = "fixture-password";
const root = mkdtempSync(join(tmpdir(), "opfs-password-"));
try {
  const bodies: Record<string, Buffer> = {
    "first.bin": Buffer.from(Array.from({ length: 73 }, (_, at) => at)),
    "large.bin": Buffer.from(Array.from({ length: 131072 }, (_, at) => (at * 31 + 17) % 251)),
    "last.bin": Buffer.concat([Buffer.from("late\0binary"), Buffer.from([255]), Buffer.from("payload")]),
    empty: Buffer.alloc(0),
  };
  for (const [name, body] of Object.entries(bodies)) writeFileSync(join(root, name), body);
  const producer = run([args.seven]).toString().split(/\r?\n/u).slice(0, 5);
  const unzipVersion = run([args.unzip, "-v"]).toString();
  const result: Record<string, unknown> = {};
  for (const [profile, method] of [["stored", "Copy"], ["deflate", "Deflate"]] as const) {
    const archive = join(root, `${profile}.zip`);
    const command = [
      args.seven,
      "a",
      "-tzip",
      `-mm=${method}`,
      "-mem=ZipCrypto",
      `-p${password}`,
      archive,
      ...Object.keys(bodies),
    ];
    run(command, root);
    for (const [name, body] of Object.entries(bodies)) {
      deepStrictEqual(
        run([args.unzip, "-P", password, "-p", archive, name], root),
        body,
        `${profile}: native payload differs: ${name}`,
      );
    }
    const wire = readArchive(archive);
    result[profile] = {
      producer,
      consumer: "InfoZIP unzip; full original payload comparisons",
      consumerVersion: unzipVersion,
      command,
      password: Buffer.from(password).toString("base64"),
      independentPayloadVerified: true,
      flags: flags(wire, Object.keys(bodies)),
      flagsSource: "authored central-directory inspection",
      sha256: createHash("sha256").update(wire).digest("hex"),
      archive: wire.toString("base64"),
      entries: Object.entries(bodies).map(([name, body]) => ({ name, body: body.toString("base64") })),
    };
  }
  const archive = join(root, "descriptor.zip");
  const body = Buffer.concat([
    Buffer.from("stdin payload\0"),
    Buffer.from([255]),
    Buffer.from(Array.from({ length: 91 }, (_, at) => at)),
  ]);
  const attemptedCommand = [
    args.seven,
    "a",
    "-tzip",
    "-mm=Copy",
    "-mem=ZipCrypto",
    `-p${password}`,
    "-sidescriptor.bin",
    archive,
  ];
  const attempted = inspect(attemptedCommand, root, body);
  const sevenStdinDiagnostic = {
    command: attemptedCommand,
    exitCode: attempted.status,
    stderr: attempted.stderr.toString(),
    stdout: attempted.stdout.toString(),
  };
  if (existsSync(archive)) unlinkSync(archive);
  const command = [args.zip, "-P", password, "-0", archive, "-"];
  run(command, root, body);
  deepStrictEqual(
    run([args.seven, "x", "-tzip", `-p${password}`, "-so", "-spd", archive, "--", "-"], root),
    body,
    "Native descriptor payload differs.",
  );
  const wire = readArchive(archive);
  const descriptorFlags = flags(wire, ["-"]);
  ok((descriptorFlags["-"]! & 8) !== 0, "InfoZIP stdin fixture must retain its data descriptor flag.");
  result.descriptor = {
    producer: run([args.zip, "-v"]).toString().split(/\r?\n/u).slice(0, 5),
    consumer: "7-Zip; full original descriptor payload comparison",
    consumerVersion: producer,
    command,
    sevenStdinDiagnostic,
    password: Buffer.from(password).toString("base64"),
    independentPayloadVerified: true,
    flags: descriptorFlags,
    flagsSource: "authored central-directory inspection",
    sha256: createHash("sha256").update(wire).digest("hex"),
    archive: wire.toString("base64"),
    entries: [{ name: "-", body: body.toString("base64") }],
  };
  writeFileSync(resolve(args.output), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
} finally {
  rmSync(root, { recursive: true, force: true });
}
