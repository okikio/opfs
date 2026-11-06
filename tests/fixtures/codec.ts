/** Test-only native codec acquisition and byte evidence. No candidate codec is imported. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import process from "node:process";

export interface ObservationType {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: Buffer<ArrayBuffer>;
  readonly stderr: Buffer<ArrayBuffer>;
}

/**
 * The admitted Linux tool image supplies C.UTF-8; macOS supplies en_US.UTF-8.
 * Libarchive uses this locale when converting UTF-8 archive names. Inheriting C
 * can reject valid Unicode before the full-byte comparison, so set both values
 * explicitly. A tool environment without the selected locale must fail instead
 * of replacing names or dropping the Unicode cases.
 */
export function nativeEnvironment(): Readonly<Record<string, string | undefined>> {
  const locale = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
  return { ...process.env, LANG: locale, LC_ALL: locale };
}

/** Every child has a finite execution deadline and independent stdout/stderr capture ceilings. */
export function observe(
  executable: string,
  arguments_: readonly string[],
  input?: Uint8Array,
  cwd?: string,
): ObservationType {
  const result = spawnSync(executable, [...arguments_], {
    input,
    cwd,
    env: nativeEnvironment(),
    timeout: 90_000,
    maxBuffer: 16 * 1024 * 1024,
    killSignal: "SIGKILL",
    windowsHide: true,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.error) throw new Error("Native codec did not complete: " + executable, { cause: result.error });
  return { exitCode: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
}

/** A nonzero native answer is evidence, never a usable partial compressed file. */
export function command(
  executable: string,
  arguments_: readonly string[],
  input?: Uint8Array,
  cwd?: string,
): Buffer<ArrayBuffer> {
  const result = observe(executable, arguments_, input, cwd);
  if (result.exitCode !== 0 || result.signal !== null) {
    throw new Error(
      JSON.stringify({
        executable,
        arguments: arguments_,
        exitCode: result.exitCode,
        signal: result.signal,
        stderr: result.stderr.toString("utf8").slice(0, 8192),
      }),
    );
  }
  return result.stdout;
}

/** Require an explicit destination so a review run cannot silently replace retained historical evidence. */
export function options(names: readonly string[]): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  const arguments_ = process.argv.slice(2);
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !key?.startsWith("--") || !names.includes(key.slice(2)) || !value || value.startsWith("--") ||
      key.slice(2) in values
    ) {
      throw new Error("Expected unique named options: " + names.map((name) => "--" + name).join(", "));
    }
    values[key.slice(2)] = value;
  }
  if (!values.output) throw new Error("Explicit --output path required; retain the historical fixture unchanged.");
  return values;
}

export function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function encoded(bytes: Uint8Array): { readonly base64: string; readonly sha256: string } {
  return { base64: Buffer.from(bytes).toString("base64"), sha256: hash(bytes) };
}

/** Inputs are authored before compression and compared as complete byte arrays by each native consumer. */
export function equal(actual: Uint8Array, expected: Uint8Array, name: string): void {
  if (!Buffer.from(actual).equals(expected)) throw new Error("Native full-byte mismatch: " + name);
}

/** New deterministic byte recipe; it does not impersonate the historical Python random.Random sequence. */
export function randomBytes(size: number, seed: number): Buffer<ArrayBuffer> {
  const bytes = Buffer.alloc(size);
  let state = seed >>> 0;
  for (let index = 0; index < size; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 255;
  }
  return bytes;
}

/** Independent bitwise IEEE CRC32 for authored framing, never the candidate's table implementation. */
export function crc32(bytes: Uint8Array): number {
  let state = 0xffffffff;
  for (const byte of bytes) {
    state ^= byte;
    for (let bit = 0; bit < 8; bit++) state = (state >>> 1) ^ ((state & 1) ? 0xedb88320 : 0);
  }
  return (state ^ 0xffffffff) >>> 0;
}

/** Publish a complete record after all reciprocal comparisons succeed. Existing output files are replaced deliberately. */
export function publish(path: string, value: unknown): void {
  const temporary = path + ".next";
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}

/** Report the source actually run, separately from immutable historical producer receipts. */
export function producer(
  url: string,
): { readonly runtime: string; readonly producerSha256: string; readonly codecHarnessSha256: string } {
  return {
    runtime: process.version,
    producerSha256: hash(readFileSync(new URL(url))),
    codecHarnessSha256: hash(readFileSync(new URL(import.meta.url))),
  };
}
