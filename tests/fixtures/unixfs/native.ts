/** Bounded, candidate-free acquisition and native commands for pinned Kubo fixtures. */
import { equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { gunzipSync } from "node:zlib";
export const ASSET_SHA256 = "e09237abadd9578d7a73dd2e2b718848b78437cb56e48cc9742b23ce9ebac829";
export const COMMIT = "acc53c093810a8fe9a4bc2f023f0b1e0c1d629b5";
export function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function read(path: string | URL, maximum = 32 * 1024 * 1024): Buffer {
  const info = lstatSync(path);
  ok(info.isFile() && info.size <= maximum, "Fixture input is not regular or exceeds its bound.");
  const bytes = readFileSync(path);
  ok(bytes.length <= maximum, "Fixture input grew past its admitted bound.");
  return bytes;
}
export function save(output: string, value: unknown): void {
  const bytes = JSON.stringify(value) + "\n";
  ok(Buffer.byteLength(bytes) <= 32 * 1024 * 1024, "Fixture receipt exceeds 32 MiB.");
  writeFileSync(output, bytes, { flag: "wx" });
}

/** Admit tar bytes before selecting one fixed ordinary member; never extract archive paths. */
function extract(archive: string, root: string): { executable: string; binarySha256: string } {
  equal(process.arch, "arm64", "Pinned Kubo binary requires ARM64.");
  equal(process.platform, "linux", "Pinned Kubo binary requires Linux.");
  const compressed = read(archive, 40 * 1024 * 1024);
  equal(compressed.length, 39040966);
  equal(sha(compressed), ASSET_SHA256);
  const tar = gunzipSync(compressed, { maxOutputLength: 220 * 1024 * 1024 });
  let selected: Buffer | undefined, offset = 0, count = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    ok(++count <= 256, "Pinned archive member count exceeds policy.");
    const text = (start: number, length: number): string =>
      header.subarray(start, start + length).toString("ascii").replace(/\0.*$/su, "");
    const octal = (start: number, length: number): number => {
      const token = text(start, length).trim();
      ok(/^[0-7]+$/u.test(token));
      const value = Number.parseInt(token, 8);
      ok(Number.isSafeInteger(value));
      return value;
    };
    let checksum = 0;
    for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index] ?? 0;
    equal(checksum, octal(148, 8), "Pinned tar header checksum mismatch.");
    const size = octal(124, 12), prefix = text(345, 155), name = (prefix ? prefix + "/" : "") + text(0, 100);
    ok(size <= 200 * 1024 * 1024 && offset + 512 + size <= tar.length, "Pinned tar member exceeds its bound.");
    if (name === "kubo/ipfs") {
      ok(!selected && (header[156] === 0 || header[156] === 48), "Pinned executable is duplicate or not ordinary.");
      selected = tar.subarray(offset + 512, offset + 512 + size);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  ok(
    selected && selected.length > 0 && selected.length < 200 * 1024 * 1024,
    "Pinned Kubo executable is missing or oversized.",
  );
  const executable = join(root, "ipfs");
  writeFileSync(executable, selected, { flag: "wx", mode: 0o700 });
  chmodSync(executable, 0o700);
  const binarySha256 = sha(selected);
  equal(
    binarySha256,
    "49f878c64edfaaf9915aa710b22b12703c05a3cc1e8f916752d76df5913f5422",
    "Pinned Kubo executable differs.",
  );
  return { executable, binarySha256 };
}

export type CommandType = { arguments: string[]; exitCode: number; stderr: string };
/** Each instance owns only its binary/repository under the caller-owned fresh root. */
export function kubo(archive: string, root: string) {
  const { executable, binarySha256 } = extract(archive, root),
    commands: CommandType[] = [],
    deadline = Date.now() + 30 * 60_000;
  let diagnosticBytes = 0;
  const environment = { ...process.env, IPFS_PATH: join(root, "repo"), IPFS_LOGGING: "error" };
  const run = (args: string[], options: { data?: Buffer; optional?: boolean } = {}) => {
    ok(commands.length < 10000 && Date.now() < deadline, "Native Kubo whole-run command/deadline bound exceeded.");
    const result = spawnSync(executable, ["--offline", ...args], {
      env: environment,
      stdio: [options.data ? "pipe" : "ignore", "pipe", "pipe"],
      ...(options.data === undefined ? {} : { input: options.data }),
      timeout: Math.min(90_000, deadline - Date.now()),
      killSignal: "SIGKILL",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.error || result.signal || result.status === null) {
      throw new Error("Kubo failed before a native format verdict.", {
        cause: { error: result.error, signal: result.signal, status: result.status },
      });
    }
    diagnosticBytes += result.stderr.length;
    ok(diagnosticBytes <= 8 * 1024 * 1024, "Native command diagnostics exceed 8 MiB.");
    commands.push({ arguments: args, exitCode: result.status, stderr: result.stderr.toString("utf8") });
    if (!options.optional) equal(result.status, 0, result.stderr.toString("utf8"));
    return result;
  };
  run(["init", "--profile=test"]);
  return { executable, binarySha256, commands, run, version: run(["version", "--all"]).stdout.toString("utf8") };
}
