/**
 * Produces genuine JLHA fixtures and compares original payloads with four native readers.
 *
 * Only authored ASCII names enter the extractors. The tool owns a disposable
 * directory; no untrusted archive, candidate import or downloaded code runs here.
 */
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** Refuses links and oversized files before materializing native output. */
function read(path: string): Buffer {
  const info = lstatSync(path);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) {
    throw new Error(`Fixture file exceeds the regular 16 MiB profile: ${path}`);
  }
  return readFileSync(path);
}

/** The original bytes determine both expected payloads and their digests. */
function encoded(data: Uint8Array): { base64: string; sha256: string } {
  return { base64: Buffer.from(data).toString("base64"), sha256: createHash("sha256").update(data).digest("hex") };
}

/** Bounds independent native work without invoking a command shell. */
function run(command: readonly string[], cwd?: string): Buffer {
  const child = spawnSync(command[0]!, command.slice(1), {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20_000,
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (child.error !== undefined || child.status !== 0) {
    throw new Error(
      JSON.stringify({
        command,
        status: child.status,
        signal: child.signal,
        stdout: child.stdout?.toString(),
        stderr: child.stderr?.toString(),
        error: child.error?.message,
      }),
    );
  }
  return child.stdout;
}

/** Rejects links and special files before reading extractor output. */
function filesBelow(root: string, directory = root): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Extractor created a symbolic link: ${path}`);
    if (stat.isDirectory()) Object.assign(files, filesBelow(root, path));
    else if (stat.isFile()) files[relative(root, path).split(sep).join("/")] = read(path);
    else throw new Error(`Extractor created a special file: ${path}`);
  }
  return files;
}

const { values: args } = parseArgs({
  options: {
    producer: { type: "string", default: "/usr/bin/jlha" },
    lhasa: { type: "string", default: "/usr/bin/lhasa" },
    seven: { type: "string", default: "/usr/bin/7zz" },
    bsdtar: { type: "string", default: "/usr/bin/bsdtar" },
    output: { type: "string" },
  },
});
if (args.output === undefined) throw new TypeError("--output requires a destination file.");
const packages = run([
  "dpkg-query",
  "-W",
  "-f=${Package}=${Version}\n",
  "jlha-utils",
  "libjlha-java",
  "lhasa",
  "7zip",
  "libarchive-tools",
  "default-jre-headless",
]).toString();
const payloads: Record<string, Buffer> = {
  "empty.bin": Buffer.alloc(0),
  "tiny.txt": Buffer.from("123456789"),
  "odd.bin": Buffer.from(Array.from({ length: 251 }, (_, at) => at)),
  "many.bin": Buffer.from(Array.from({ length: 230017 }, (_, at) => (at * 37 + Math.floor(at / 257)) % 256)),
  "sub/nested.txt": Buffer.from("owned native archive fixture\n"),
  [`sub/${"long-name-".repeat(9)}.txt`]: Buffer.from("long header extension name\n"),
};
const root = mkdtempSync(join(tmpdir(), "opfs-lha-"));
const fixtures: unknown[] = [];
try {
  for (const [name, body] of Object.entries(payloads)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), body);
  }
  for (const level of [0, 1, 2]) {
    const selected = { ...payloads };
    if (level === 0) {
      // This JLHA writer's 100-byte header budget is narrower than the format.
      const longName = `sub/${"long-name-".repeat(9)}.txt`;
      const shortName = `sub/${"long-name-".repeat(5)}.txt`;
      selected[shortName] = selected[longName]!;
      delete selected[longName];
      writeFileSync(join(root, shortName), selected[shortName]);
      if (Buffer.byteLength(shortName, "ascii") !== 58) throw new Error("Level-0 name budget changed.");
    }
    const archive = join(root, `level${level}.lzh`);
    const producerCommand = [args.producer, `az${level}`, archive, ...Object.keys(selected)];
    const receipt = run(producerCommand, root);
    const wire = read(archive);
    if (wire.subarray(2, 7).toString("ascii") !== "-lh0-" || wire[20] !== level || wire.at(-1) !== 0) {
      throw new Error(`Native writer did not emit the admitted stored level-${level} profile.`);
    }
    const consumers: unknown[] = [];
    const tools = [
      { name: "jlha", command: [args.producer, "xqw={destination}", archive] },
      { name: "lhasa", command: [args.lhasa, "xqw={destination}", archive] },
      { name: "7zip", command: [args.seven, "x", "-y", "-o{destination}", archive] },
      { name: "libarchive", command: [args.bsdtar, "-xf", archive, "-C", "{destination}"] },
    ];
    for (const tool of tools) {
      for (const name of Object.keys(selected)) {
        if (
          name.length === 0 || Array.from(name).some((unit) => unit.codePointAt(0)! > 0x7f) || name.startsWith("/") ||
          name.split("/").some((part) => part === "" || part === "." || part === "..")
        ) {
          throw new Error(`Unsafe authored extractor path: ${name}`);
        }
      }
      const destination = join(root, `extracted-${level}-${tool.name}`);
      mkdirSync(destination);
      const command = tool.command.map((part) => part.replace("{destination}", destination));
      const diagnostic = run(command, root);
      const files = filesBelow(destination);
      if (JSON.stringify(Object.keys(files).sort()) !== JSON.stringify(Object.keys(selected).sort())) {
        throw new Error(`${tool.name}: extracted name set differs.`);
      }
      for (const [name, expected] of Object.entries(selected)) {
        if (!files[name]!.equals(expected)) throw new Error(`${level}/${tool.name}: payload differs: ${name}`);
      }
      consumers.push({
        tool: tool.name,
        command,
        stdout: diagnostic.toString("utf8"),
        payloadSha256: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, encoded(body).sha256])),
      });
    }
    fixtures.push({
      level,
      command: producerCommand,
      producerOutput: receipt.toString("utf8"),
      consumers,
      archive: encoded(wire),
      payloads: Object.fromEntries(Object.entries(selected).map(([name, body]) => [name, encoded(body)])),
    });
  }
  writeFileSync(
    resolve(args.output),
    JSON.stringify({
      packages,
      producerScriptSha256: encoded(read(fileURLToPath(import.meta.url))).sha256,
      fixtures,
    }),
    { flag: "wx" },
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
