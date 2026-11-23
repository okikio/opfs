/**
 * Native macutils and Perl independently encode and decode both original forks.
 * The nested STORED ZIP is authored input framing, not an independent ZIP oracle.
 */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execPath, version as nodeVersion } from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const CAP = 2 * 1024 * 1024;
interface BlobType {
  readonly base64: string;
  readonly bytes: number;
  readonly sha256: string;
}
interface CommandType {
  readonly argv: readonly string[];
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
interface FixtureType {
  readonly case: string;
  readonly producer: string;
  readonly name: string;
  readonly archive: BlobType;
  readonly data: BlobType;
  readonly resource: BlobType;
  readonly metadata: string;
}
const { values: args } = parseArgs({
  options: {
    harness: { type: "string" },
    output: { type: "string" },
    binhex: { type: "string", default: "/usr/bin/binhex" },
    hexbin: { type: "string", default: "/usr/bin/hexbin" },
    perl: { type: "string", default: "/usr/bin/perl" },
    prlimit: { type: "string", default: "/usr/bin/prlimit" },
  },
});
if (args.harness === undefined || args.output === undefined) {
  throw new TypeError("--harness and a new --output destination are required.");
}
const harness = resolve(args.harness);
const records: CommandType[] = [];

/** The native process retains the old per-file limit, as well as bounded diagnostics. */
function run(argv: readonly string[], cwd: string): Buffer {
  const command = [args.prlimit, `--fsize=${CAP}:${CAP}`, "--", ...argv];
  const child = spawnSync(command[0]!, command.slice(1), {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    killSignal: "SIGKILL",
    maxBuffer: CAP,
  });
  if (child.error !== undefined || child.status === null || child.signal !== null) {
    throw new Error(JSON.stringify({ argv, error: child.error?.message, signal: child.signal }));
  }
  const record = { argv, code: child.status, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
  records.push(record);
  if (child.status !== 0) throw new Error(JSON.stringify(record));
  return child.stdout;
}

/** Reads only regular, bounded output files before comparing original fork bytes. */
function read(path: string): Buffer {
  const info = lstatSync(path);
  ok(info.isFile() && info.size <= CAP, "Native output must be a regular file within 2 MiB.");
  return readFileSync(path);
}
function blob(value: Buffer): BlobType {
  return {
    base64: value.toString("base64"),
    bytes: value.length,
    sha256: createHash("sha256").update(value).digest("hex"),
  };
}

/** IEEE CRC32 supplies authored STORED ZIP metadata, with a fixed independent check vector. */
function crc32(body: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** One fixed, unencrypted STORED member; this does not generalize to a ZIP writer. */
function nestedZip(body: Buffer): Buffer {
  const name = Buffer.from("inside.txt");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(33, 12); // DOS date: 1980-01-01.
  local.writeUInt32LE(crc32(body), 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(33, 14);
  central.writeUInt32LE(crc32(body), 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + body.length, 16);
  return Buffer.concat([local, name, body, central, name, end]);
}

equal(crc32(Buffer.from("123456789")), 0xcbf43926);
const root = mkdtempSync(join(tmpdir(), "opfs-binhex-"));
try {
  const packages = run([
    "/usr/bin/dpkg-query",
    "-W",
    "-f=${Package}=${Version} ${Architecture}\n",
    "macutils",
    "libconvert-binhex-perl",
    "perl",
    "util-linux",
  ], root).toString();
  for (const tool of [args.binhex, args.hexbin]) {
    run([tool, "-V"], root);
    run([tool, "-H"], root);
  }
  const perlModuleVersion = run([args.perl, "-MConvert::BinHex", "-e", 'print "$Convert::BinHex::VERSION\\n"'], root)
    .toString();
  const range = (length: number): Buffer => Buffer.from(Array.from({ length }, (_, index) => index % 256));
  const payloads: [string, Buffer, Buffer][] = [
    ["empty", Buffer.alloc(0), Buffer.alloc(0)],
    ["data", Buffer.from("123456789"), Buffer.alloc(0)],
    ["rsrc", Buffer.alloc(0), Buffer.from("123456789")],
    ["forks", Buffer.concat([range(256), range(256), range(256)]), Buffer.from("resource".repeat(13))],
    ["runs", Buffer.concat([Buffer.alloc(257, 0x90), Buffer.alloc(511, 0x51)]), Buffer.alloc(513)],
    [
      "many",
      Buffer.from(Array.from({ length: 65537 }, (_, index) => (index * 17 + Math.floor(index / 257)) & 255)),
      Buffer.concat(Array.from({ length: 33 }, () => Buffer.from([0x90, 0, 0x90]))),
    ],
  ];
  for (let n = 1; n < 10; n++) payloads.push([`tail${n}`, range(n), Buffer.alloc(n % 5, 0x5a)]);
  const nestedOriginal = Buffer.from("Original nested ZIP member bytes.");
  payloads.push(["nested", nestedZip(nestedOriginal), Buffer.from("Preserved nested resource fork.")]);
  const fixtures: FixtureType[] = [];
  for (const [nameCase, data, resource] of payloads) {
    const folder = join(root, nameCase);
    mkdirSync(folder);
    const name = `${nameCase}.bin`;
    const d = join(folder, "seed.data"), r = join(folder, "seed.rsrc"), info = join(folder, "seed.info");
    writeFileSync(d, data);
    writeFileSync(r, resource);
    const header = Buffer.alloc(128);
    const encodedName = Buffer.from(name, "ascii");
    header[1] = encodedName.length;
    encodedName.copy(header, 2);
    header.write("TEST", 65, "ascii");
    header.write("OPFS", 69, "ascii");
    header.writeUInt16BE(0x8000, 73);
    header.writeUInt32BE(data.length, 83);
    header.writeUInt32BE(resource.length, 87);
    writeFileSync(info, header);
    const cFile = join(folder, "native.hqx"), pFile = join(folder, "perl.hqx");
    writeFileSync(cFile, run([args.binhex, info], folder));
    run([args.perl, harness, "encode", pFile, d, r, name], folder);
    for (const [producer, file] of [["macutils", cFile], ["perl", pFile]] as const) {
      const output = join(folder, `${producer}-c`);
      mkdirSync(output);
      run([args.hexbin, "-3", file], output);
      deepStrictEqual(readdirSync(output).sort(), [`${name}.info`, `${name}.data`, `${name}.rsrc`].sort());
      deepStrictEqual(read(join(output, `${name}.data`)), data);
      deepStrictEqual(read(join(output, `${name}.rsrc`)), resource);
      const pd = join(folder, `${producer}.data`), pr = join(folder, `${producer}.rsrc`);
      const metadata = run([args.perl, harness, "decode", file, pd, pr], folder).toString().trim();
      equal(metadata, `${name}:TEST:OPFS:32768`);
      deepStrictEqual(read(pd), data);
      deepStrictEqual(read(pr), resource);
      fixtures.push({
        case: nameCase,
        producer,
        name,
        archive: blob(read(file)),
        data: blob(data),
        resource: blob(resource),
        metadata,
      });
    }
  }
  const source = fileURLToPath(import.meta.url);
  ok(statSync(execPath).isFile());
  const result = {
    node: {
      version: nodeVersion,
      executable: execPath,
      sha256: createHash("sha256").update(readFileSync(execPath)).digest("hex"),
    },
    nestedOriginal: blob(nestedOriginal),
    nestedProfile: "authored single-member STORED ZIP framing, not Python zipfile output",
    packages,
    perlModuleVersion,
    fixtures,
    commands: records,
    limits: { fileBytes: CAP, stdoutBytes: CAP, deadlineMs: 60_000, wrapper: args.prlimit },
    scripts: { "create.ts": blob(read(source)).sha256, "native.pl": blob(read(harness)).sha256 },
  };
  writeFileSync(resolve(args.output), `${JSON.stringify(result)}\n`, { flag: "wx" });
} finally {
  rmSync(root, { recursive: true, force: true });
}
