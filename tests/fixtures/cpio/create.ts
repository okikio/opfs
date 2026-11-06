/**
 * Produces CPIO fixtures through an independently installed native writer.
 *
 * Original input bytes, rather than an OPFS reader, supply the payload oracle.
 * The temporary tree is owned here and removed even if the native writer fails.
 */
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import process from "node:process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Refuses links and oversized files before materializing native output. */
function read(path: string): Buffer {
  const info = lstatSync(path);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) {
    throw new Error(`Fixture file exceeds the regular 16 MiB profile: ${path}`);
  }
  return readFileSync(path);
}

/** Parsed command policy; formats remain limited to the two admitted profiles. */
interface OptionsType {
  cpio: string;
  formats: string[];
  output: string;
}

/** Keeps executable arguments separate from names and refuses unknown options. */
function options(input: readonly string[]): OptionsType {
  const result: OptionsType = {
    cpio: "cpio",
    formats: ["newc", "crc"],
    output: "",
  };
  for (let at = 0; at < input.length; at++) {
    const flag = input[at];
    if (flag === "--formats") {
      result.formats = [];
      while (at + 1 < input.length && !input[at + 1]!.startsWith("--")) result.formats.push(input[++at]!);
      if (!result.formats.length || result.formats.some((format) => format !== "newc" && format !== "crc")) {
        throw new TypeError("--formats requires newc, crc, or both.");
      }
    } else if (flag === "--cpio" || flag === "--output") {
      const value = input[++at];
      if (value === undefined || value.startsWith("--")) throw new TypeError(`${flag} requires a value.`);
      if (flag === "--cpio") result.cpio = value;
      else result.output = value;
    } else throw new TypeError(`Unknown argument: ${flag}`);
  }
  if (result.output.length === 0) throw new TypeError("--output requires a new destination file.");
  return result;
}

/** Bounds the native process and retains its diagnostic on failure. */
function run(command: readonly string[], cwd?: string, input?: Uint8Array): Buffer {
  const child = spawnSync(command[0]!, command.slice(1), {
    cwd,
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout: 10_000,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (child.error !== undefined || child.status !== 0) {
    throw new Error(
      JSON.stringify({
        command,
        status: child.status,
        signal: child.signal,
        stderr: child.stderr?.toString(),
        error: child.error?.message,
      }),
    );
  }
  return child.stdout;
}

const args = options(process.argv.slice(2));
const version = run([args.cpio, "--version"]).toString().trim();
const root = mkdtempSync(join(tmpdir(), "opfs-cpio-"));
try {
  mkdirSync(join(root, "folder"));
  const alphabet = Uint8Array.from({ length: 256 }, (_, at) => at);
  const payload = Buffer.concat([alphabet, Buffer.from("independent CPIO payload\0", "utf8"), Buffer.from([255])]);
  const large = Buffer.concat(Array.from({ length: 512 }, () => alphabet));
  writeFileSync(join(root, "folder/data.bin"), payload);
  writeFileSync(join(root, "large.bin"), large);
  writeFileSync(join(root, "alias-first"), payload);
  linkSync(join(root, "alias-first"), join(root, "alias-last"));
  writeFileSync(join(root, "empty"), new Uint8Array());
  symlinkSync("folder/data.bin", join(root, "symbolic"));
  const names = ["folder", "folder/data.bin", "large.bin", "alias-first", "alias-last", "empty", "symbolic"];
  const entries = names.map((name) => {
    const kind = name === "symbolic" ? "symbolic-link" : name === "folder" ? "directory" : "file";
    const path = join(root, name);
    const body = kind === "symbolic-link"
      ? Buffer.from("folder/data.bin")
      : kind === "directory"
      ? Buffer.alloc(0)
      : read(path);
    if (kind !== "symbolic-link") {
      chmodSync(path, kind === "directory" ? 0o755 : 0o644);
      utimesSync(path, 0, 0);
    }
    return { name, kind, body: body.toString("base64") };
  });
  const result: Record<string, unknown> = {};
  for (const profile of args.formats) {
    const command = [args.cpio, "-o", "-H", profile];
    const produced = run(command, root, Buffer.from(`${names.join("\n")}\n`));
    result[profile] = {
      producer: version,
      command,
      sha256: createHash("sha256").update(produced).digest("hex"),
      archive: produced.toString("base64"),
      entries,
    };
  }
  writeFileSync(resolve(args.output), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
} finally {
  rmSync(root, { recursive: true, force: true });
}
