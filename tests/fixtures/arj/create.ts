/**
 * Produces genuine ARJ archives and compares original bytes with ARJ and 7zip.
 *
 * This explicit native fixture root imports no candidate reader. Only authored
 * inert paths reach extractors, and Linux prlimit preserves the old per-file cap.
 */
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** Refuses links and oversized files before materializing native output. */
function read(path: string): Buffer {
  const info = lstatSync(path);
  if (!info.isFile() || info.size > 1024 * 1024) {
    throw new Error(`Fixture file exceeds the regular 1 MiB profile: ${path}`);
  }
  return readFileSync(path);
}

/** Native completion and diagnostic evidence, including the exact limit wrapper. */
interface ReceiptType {
  command: readonly string[];
  launcher: readonly string[];
  exit: number;
  stdout: string;
  stderr: string;
}

/** Pins the original payload or archive, independently of candidate output. */
function encoded(body: Uint8Array): { base64: string; sha256: string } {
  return { base64: Buffer.from(body).toString("base64"), sha256: createHash("sha256").update(body).digest("hex") };
}

const { values: args } = parseArgs({
  options: {
    arj: { type: "string", default: "/usr/bin/arj" },
    seven: { type: "string", default: "/usr/bin/7zz" },
    prlimit: { type: "string", default: "/usr/bin/prlimit" },
    output: { type: "string" },
  },
});
if (args.output === undefined) throw new TypeError("--output requires a destination file.");

/**
 * Uses an explicit Linux utility because Node cannot set RLIMIT_FSIZE directly.
 * Captured diagnostics have a separate 1 MiB cap and native work has a deadline.
 */
function run(command: readonly string[], cwd?: string, expected: readonly number[] = [0]): ReceiptType {
  const launcher = [args.prlimit, "--fsize=1048576:1048576", "--", ...command];
  const child = spawnSync(launcher[0]!, launcher.slice(1), {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  if (child.error !== undefined || child.status === null || child.signal !== null) {
    throw new Error(JSON.stringify({ command, launcher, signal: child.signal, error: child.error?.message }));
  }
  const receipt = {
    command,
    launcher,
    exit: child.status,
    stdout: child.stdout.toString("utf8"),
    stderr: child.stderr.toString("utf8"),
  };
  if (!expected.includes(child.status)) throw new Error(JSON.stringify(receipt));
  return receipt;
}

/** The extractor can return only directories and bounded regular files. */
function inspectFiles(root: string, directory = root): { files: Record<string, Buffer>; directories: string[] } {
  const files: Record<string, Buffer> = {};
  const directories: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    const key = relative(root, path).split(sep).join("/");
    if (stat.isSymbolicLink()) throw new Error(`Native extraction created a symbolic link: ${key}`);
    if (stat.isFile()) {
      if (stat.size > 1024 * 1024) throw new Error(`Native extraction exceeded its file budget: ${key}`);
      files[key] = read(path);
    } else if (stat.isDirectory()) {
      directories.push(key);
      const nested = inspectFiles(root, path);
      Object.assign(files, nested.files);
      directories.push(...nested.directories);
    } else throw new Error(`Native extraction created a special file: ${key}`);
  }
  return { files, directories };
}

const packages = run(["dpkg-query", "-W", "-f=${Package}=${Version}\n", "arj", "7zip", "util-linux"]);
const help = [run([args.arj], undefined, [0, 1]), run([args.seven])];
const limitTool = run([args.prlimit, "--version"]);
const payloads: Record<string, Buffer> = {
  "empty.bin": Buffer.alloc(0),
  "tiny.txt": Buffer.from("123456789"),
  "odd.bin": Buffer.from(Array.from({ length: 251 }, (_, at) => at)),
  "many.bin": Buffer.from(Array.from({ length: 65537 }, (_, at) => (at * 37 + Math.floor(at / 257)) % 256)),
  "sub/nested.txt": Buffer.concat([Buffer.from("ARJ selected bytes remain exact.\r\n\0"), Buffer.from([255])]),
};
const fixtures: unknown[] = [];
const root = mkdtempSync(join(tmpdir(), "opfs-arj-"));
try {
  const inputs = join(root, "inputs");
  mkdirSync(inputs);
  for (const [name, body] of Object.entries(payloads)) {
    if (
      name.length === 0 || Array.from(name).some((unit) => unit.codePointAt(0)! > 0x7f) || name.startsWith("/") ||
      name.split("/").some((part) => part === "" || part === "." || part === "..")
    ) throw new Error(`Unsafe authored path: ${name}`);
    const path = join(inputs, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  mkdirSync(join(inputs, "emptydir"));
  const archiveComment = join(root, "archive-comment.txt");
  const fileComment = join(root, "file-comment.txt");
  writeFileSync(archiveComment, "Authored archive comment.\r\n");
  writeFileSync(fileComment, "Authored member comment.\r\n");
  const profiles = [{ id: "stored", method: 0, extra: false }, { id: "compressed", method: 1, extra: false }, {
    id: "comments-directories",
    method: 0,
    extra: true,
  }];
  for (const profile of profiles) {
    const archive = join(root, `${profile.id}.arj`);
    const switches = profile.extra ? ["-a1", `-z${archiveComment}`] : [];
    // ARJ expands a literal directory to contents. This literal argv wildcard
    // selects its directory record instead; no shell expands the pattern.
    const selected = [...Object.keys(payloads), ...(profile.extra ? ["emptydi?"] : [])];
    const producer = run([args.arj, "a", `-m${profile.method}`, "-y", ...switches, archive, ...selected], inputs);
    const commentReceipt = profile.extra
      ? run([args.arj, "c", "-y", `-jz${fileComment}`, archive, "tiny.txt"], inputs)
      : null;
    const wire = read(archive);
    if (wire.length >= 1024 * 1024 || wire[0] !== 0x60 || wire[1] !== 0xea) {
      throw new Error(`${profile.id}: native output is not the admitted bounded ARJ image.`);
    }
    const test = run([args.arj, "t", archive]);
    const consumers: unknown[] = [];
    for (const tool of ["arj", "7zip"]) {
      const destination = join(root, `extract-${profile.id}-${tool}`);
      mkdirSync(destination);
      const command = tool === "arj"
        ? [args.arj, "x", "-y", archive, `${destination}/`]
        : [args.seven, "x", "-y", `-o${destination}`, archive];
      const extraction = run(command, root);
      const found = inspectFiles(destination);
      if (profile.extra && !found.directories.includes("emptydir")) {
        throw new Error(`${tool}: missing native empty directory.`);
      }
      if (JSON.stringify(Object.keys(found.files).sort()) !== JSON.stringify(Object.keys(payloads).sort())) {
        throw new Error(`${tool}: extracted file set differs.`);
      }
      for (const [name, original] of Object.entries(payloads)) {
        if (!found.files[name]!.equals(original)) throw new Error(`${profile.id}/${tool}: payload differs: ${name}`);
      }
      consumers.push({
        tool,
        receipt: extraction,
        payloadSha256: Object.fromEntries(
          Object.entries(found.files).map(([name, body]) => [name, encoded(body).sha256]),
        ),
      });
    }
    fixtures.push({
      id: profile.id,
      method: profile.method,
      directories: profile.extra ? ["emptydir"] : [],
      archiveComment: profile.extra ? "Authored archive comment.\r\n" : "",
      fileComments: profile.extra ? { "tiny.txt": "Authored member comment.\r\n" } : {},
      commentReceipt,
      archive: encoded(wire),
      producer,
      test,
      consumers,
      payloads: Object.fromEntries(Object.entries(payloads).map(([name, body]) => [name, encoded(body)])),
    });
  }
  writeFileSync(
    resolve(args.output),
    JSON.stringify({
      packages,
      help,
      limitTool,
      producerScriptSha256: encoded(read(fileURLToPath(import.meta.url))).sha256,
      fixtures,
    }),
    { flag: "wx" },
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
