/**
 * Produces inert RAR5 fixtures with an explicitly supplied vendor executable.
 *
 * The tool never downloads or redistributes binaries. Only stored/quick-open
 * payloads receive native full-byte checks; other profiles remain refusal data.
 */
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

/** Refuses links and oversized files before materializing native output. */
function read(path: string): Buffer {
  const info = lstatSync(path);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) {
    throw new Error(`Fixture file exceeds the regular 16 MiB profile: ${path}`);
  }
  return readFileSync(path);
}

/** Capture native diagnostics with finite time and memory budgets. */
function inspect(command: readonly string[], cwd?: string, timeout = 60_000): SpawnSyncReturns<Buffer> {
  const child = spawnSync(command[0]!, command.slice(1), {
    cwd,
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.error !== undefined || child.status === null || child.signal !== null) {
    throw new Error(JSON.stringify({ command, signal: child.signal, error: child.error?.message }));
  }
  return child;
}

/** Required native operations must succeed, unlike the diagnostic help probe. */
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

/** Pins exact bytes independently of any candidate parser. */
function record(data: Uint8Array): { base64: string; sha256: string } {
  return { base64: Buffer.from(data).toString("base64"), sha256: createHash("sha256").update(data).digest("hex") };
}

/** Retains physical extracted names while matching Unicode names in NFC. */
function extractedFiles(root: string, directory = root, found: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) extractedFiles(root, path, found);
    else if (stat.isFile()) {
      const key = relative(root, path).split(sep).join("/").normalize("NFC");
      if (Object.hasOwn(found, key)) throw new Error(`Native extraction aliases one normalized name: ${key}`);
      found[key] = path;
    } else throw new Error(`Native extraction created a link or special file: ${path}`);
  }
  return found;
}

const { values: args } = parseArgs({
  options: {
    rar: { type: "string" },
    seven: { type: "string" },
    tar: { type: "string" },
    output: { type: "string" },
  },
});
if (args.rar === undefined || args.seven === undefined || args.tar === undefined || args.output === undefined) {
  throw new TypeError("--rar, --seven, --tar and --output are required.");
}
const probe = inspect([args.rar, "-?"], undefined, 10_000);
const tools = {
  rar: {
    status: probe.status,
    stdout: probe.stdout.toString(),
    stderr: probe.stderr.toString(),
    binarySha256: record(read(args.rar)).sha256,
  },
  seven: run([args.seven, "i"]).toString(),
  tar: run([args.tar, "--version"]).toString(),
};
const root = mkdtempSync(join(tmpdir(), "opfs-rar-"));
const fixtures: unknown[] = [];
try {
  const files: Record<string, Buffer> = {
    empty: Buffer.alloc(0),
    "hello.txt": Buffer.from("RAR5 original stored member\n"),
    "dir/café.txt": Buffer.from("UTF-8 inert name\n"),
    "large.bin": Buffer.from(Array.from({ length: 150123 }, (_, at) => (at * 17 + Math.floor(at / 251)) % 256)),
    "unrelated.bin": Buffer.from(
      Array.from({ length: 1024 * 1024 }, (_, at) => (at * 23 + Math.floor(at / 127)) % 256),
    ),
  };
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), body);
  }
  writeFileSync(join(root, "comment.txt"), "Authored preview fixture comment, never a metadata authority.\n");
  const profiles: Record<string, string[]> = {
    stored: ["-m0", "-qo-"],
    "quick-open": ["-m0", "-qo+", "-zcomment.txt"],
    compressed: ["-m3", "-qo-"],
    solid: ["-m3", "-s", "-qo-"],
    encrypted: ["-m0", "-pfixture-password", "-qo-"],
    "header-encrypted": ["-m0", "-hpfixture-password", "-qo-"],
    volume: ["-m0", "-v64k", "-qo-"],
  };
  for (const [profile, switches] of Object.entries(profiles)) {
    const archive = join(root, `${profile}.rar`);
    const command = [args.rar, "a", "-ma5", "-idq", "-y", ...switches, archive, ...Object.keys(files)];
    run(command, root);
    const actual = profile === "volume" ? join(root, "volume.part01.rar") : archive;
    const fixture: {
      profile: string;
      archive: ReturnType<typeof record>;
      command: string[];
      payloads: Record<string, ReturnType<typeof record>>;
      listing?: string;
      tarListing?: ReturnType<typeof record>;
      tarNames?: Record<string, string>;
    } = {
      profile,
      archive: record(read(actual)),
      command: command.slice(1),
      payloads: {},
    };
    if (profile === "stored" || profile === "quick-open") {
      fixture.listing = run([args.seven, "l", "-tRar5", "-slt", actual], root).toString();
      const target = join(root, `extract-${profile}`);
      mkdirSync(target);
      fixture.tarListing = record(run([args.tar, "-tf", actual], root));
      run([args.tar, "-xf", actual, "-C", target], root);
      const extracted = extractedFiles(target);
      if (Object.keys(extracted).length !== Object.keys(files).length) {
        throw new Error(`${profile}: native file count differs.`);
      }
      fixture.tarNames = Object.fromEntries(
        Object.entries(extracted).map(([name, path]) => [name, relative(target, path).split(sep).join("/")]),
      );
      for (const [name, body] of Object.entries(files)) {
        const path = extracted[name];
        if (path === undefined) throw new Error(`${profile}: missing native member: ${name}`);
        const seven = run([args.seven, "x", "-tRar5", "-so", "-spd", actual, name], root);
        if (!seven.equals(body) || !read(path).equals(body)) {
          throw new Error(`${profile}: native payload differs: ${name}`);
        }
        fixture.payloads[name] = record(body);
      }
    }
    fixtures.push(fixture);
  }
  // Genuine redirection is retained only as an inert refusal/listing control.
  symlinkSync("hello.txt", join(root, "alias"));
  const archive = join(root, "link.rar");
  run([args.rar, "a", "-ma5", "-m0", "-ol", "-qo-", "-idq", archive, "alias"], root);
  fixtures.push({ profile: "link", archive: record(read(archive)), payloads: {} });
  writeFileSync(resolve(args.output), `${JSON.stringify({ tools, fixtures }, null, 2)}\n`, { flag: "wx" });
} finally {
  rmSync(root, { recursive: true, force: true });
}
