/** Bounded native fixture commands and file admission. Imports start no work. */
import { ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { nativeEnvironment } from "../codec.ts";

/** A signal or spawn failure is not a native format refusal. */
export function command(
  file: string,
  args: string[],
  options: { cwd?: string; allowFailure?: boolean; timeout?: number } = {},
) {
  const result = spawnSync(file, args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 45_000,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
    env: nativeEnvironment(),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  if (result.error || result.signal || result.status === null || !options.allowFailure && result.status !== 0) {
    throw new Error(`Native fixture command failed: ${file}`, {
      cause: {
        args,
        code: result.status,
        signal: result.signal,
        error: result.error,
        stderr: result.stderr?.toString("utf8"),
      },
    });
  }
  return result;
}

/** Admit only an ordinary file before allocating its contents. */
export function read(path: string | URL, maximum = 16 * 1024 * 1024): Buffer {
  const info = lstatSync(path);
  ok(info.isFile() && info.size <= maximum, "Fixture file is not regular or exceeds its byte bound.");
  const bytes = readFileSync(path);
  ok(bytes.length <= maximum, "Fixture changed beyond its admitted byte bound.");
  return bytes;
}

export function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
