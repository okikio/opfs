/**
 * Produces new native PAX/GNU TAR profiles with independent libarchive extraction.
 *
 * These profiles preserve long names, payloads and long symbolic links. They do
 * not reproduce Python tarfile's historical global-PAX-path override fixture.
 */
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

/** Bounds the native writer, listing and extractor while retaining diagnostics. */
function run(command: readonly string[], cwd?: string): Buffer {
  const child = spawnSync(command[0]!, command.slice(1), {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
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

const { values: args } = parseArgs({
  options: {
    tar: { type: "string" },
    bsdtar: { type: "string" },
    output: { type: "string" },
  },
});
if (args.tar === undefined || args.bsdtar === undefined || args.output === undefined) {
  throw new TypeError("--tar, --bsdtar and --output are required.");
}
const producer = run([args.tar, "--version"]).toString().trim();
const consumer = run([args.bsdtar, "--version"]).toString().trim();
const root = mkdtempSync(join(tmpdir(), "opfs-tar-"));
try {
  const result: Record<string, unknown> = {};
  for (const kind of ["pax", "gnu"]) {
    const input = join(root, `inputs-${kind}`);
    mkdirSync(input);
    const longName = `${kind === "pax" ? "café" : "gnu"}/${"p".repeat(120)}`;
    const payload = Buffer.concat([
      Buffer.from(Array.from({ length: 256 }, (_, at) => at)),
      Buffer.from("independent payload\0"),
      Buffer.from([255]),
    ]);
    const bodies: Record<string, Buffer> = { [longName]: payload, "short.txt": Buffer.from("second") };
    for (const [name, body] of Object.entries(bodies)) {
      const path = join(input, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
      chmodSync(path, 0o644);
      utimesSync(path, 0, 0);
    }
    const link = `target/${"q".repeat(140)}`;
    symlinkSync(link, join(input, "link"));
    const archive = join(root, `${kind}.tar`);
    const command = [
      args.tar,
      `--format=${kind}`,
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "-cf",
      archive,
      ...Object.keys(bodies),
      "link",
    ];
    run(command, input);
    if (statSync(archive).size > 1024 * 1024) {
      throw new Error("Native TAR archive exceeds the 1 MiB fixture budget.");
    }
    const destination = join(root, `extract-${kind}`);
    mkdirSync(destination);
    const listing = run([args.bsdtar, "-tf", archive]).toString();
    run([args.bsdtar, "-xf", archive, "-C", destination]);
    for (const [name, body] of Object.entries(bodies)) {
      if (!readFileSync(join(destination, name)).equals(body)) {
        throw new Error(`${kind}: native payload differs: ${name}`);
      }
    }
    const extractedLink = join(destination, "link");
    if (!lstatSync(extractedLink).isSymbolicLink() || readlinkSync(extractedLink) !== link) {
      throw new Error(`${kind}: native symbolic-link target differs.`);
    }
    const data = readFileSync(archive);
    result[kind] = {
      producer,
      consumer,
      profile: `native GNU tar ${kind}; no global path override`,
      command,
      listing,
      independentPayloadVerified: true,
      sha256: createHash("sha256").update(data).digest("hex"),
      archive: data.toString("base64"),
      entries: [
        ...Object.entries(bodies).map(([name, body]) => ({
          name,
          kind: "file",
          size: body.length,
          link: "",
          body: body.toString("base64"),
        })),
        { name: "link", kind: "symbolic-link", size: 0, link, body: "" },
      ],
    };
  }
  writeFileSync(resolve(args.output), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
} finally {
  rmSync(root, { recursive: true, force: true });
}
