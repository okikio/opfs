/** Execute the pinned original MurmurHash C++ source through a bounded CLI wrapper.
 * This avoids Python FFI without replacing the independent algorithm. @module
 */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { read, save, sha } from "../native.ts";
const COMMIT = "07bb4de10a63e8cc2e1724865454eba635742383";
const SOURCES = {
  "MurmurHash3.cpp": "30f121ed155ebf336af398aabb7d8d157afdfafc8d981e7b48d2a1ceb4b63e4e",
  "MurmurHash3.h": "9af2003e3885c841fa0ac08cb5d5f31541ee9d793f8a9c4a4f771f43fb0d6f41",
};
// The owned wrapper serializes the first uint64 word in the same big-endian
// byte order as the old ctypes wrapper. Original source bytes remain unchanged.
const WRAPPER = `#include "MurmurHash3.h"
#include <stdint.h>
#include <fstream>
#include <iostream>
#include <iomanip>
#include <vector>
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  std::ifstream input(argv[1], std::ios::binary | std::ios::ate);
  if (!input) return 3;
  auto length = input.tellg();
  if (length < 0 || length > 4096) return 4;
  std::vector<char> bytes(length ? size_t(length) : 1);
  input.seekg(0); input.read(bytes.data(), length);
  if (!input && length) return 5;
  uint64_t words[2];
  MurmurHash3_x64_128(bytes.data(), int(length), 0, words);
  for (int i = 0; i < 8; i++) std::cout << std::hex << std::setfill('0') << std::setw(2) << unsigned(uint8_t(words[0] >> (56 - i * 8)));
  std::cout << "\\n";
}
`;
const { values } = parseArgs({
  options: {
    source: { type: "string" },
    output: { type: "string" },
    compiler: { type: "string", default: "/usr/bin/clang++" },
  },
});
ok(
  values.source && values.output && values.compiler,
  "Supply --source PINNED_CPP_DIRECTORY --output NEW_JSON [--compiler CXX].",
);
const commands: { arguments: string[]; stdout: string; stderr: string }[] = [], deadline = Date.now() + 120_000;
const run = (file: string, args: string[]): string => {
  const remaining = deadline - Date.now();
  ok(remaining > 0);
  const result = spawnSync(file, args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: Math.min(60_000, remaining),
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("Native hash reference command failed.", {
      cause: {
        error: result.error,
        signal: result.signal,
        status: result.status,
        stderr: result.stderr?.toString("utf8"),
      },
    });
  }
  commands.push({
    arguments: [file, ...args],
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
  });
  return result.stdout.toString("utf8");
};
const version = run(values.compiler, ["--version"]),
  root = mkdtempSync(join(tmpdir(), "opfs-hamt-reference-")),
  failures: unknown[] = [];
try {
  for (const [name, digest] of Object.entries(SOURCES)) {
    const bytes = read(join(values.source, name), 1024 * 1024);
    equal(sha(bytes), digest, name);
    writeFileSync(join(root, name), bytes, { flag: "wx" });
  }
  writeFileSync(join(root, "wrapper.cpp"), WRAPPER, { flag: "wx" });
  const executable = join(root, "reference");
  run(values.compiler, [
    "-std=c++11",
    "-O2",
    join(root, "MurmurHash3.cpp"),
    join(root, "wrapper.cpp"),
    "-o",
    executable,
  ]);
  const inputs = Array.from({ length: 130 }, (_, length) => Buffer.from(Array.from({ length }, (_, index) => index)));
  inputs.push(
    ...["file-000.txt", "café.txt", "space name.txt", "%2F.txt", "a".repeat(4096)].map((name) => Buffer.from(name)),
  );
  const historicalBytes = read(new URL("./hash-reference.json", import.meta.url), 1024 * 1024);
  const historical: { vectors: { input: string; digest: string }[] } = JSON.parse(historicalBytes.toString("utf8"));
  const vectors = inputs.map((bytes, index) => {
    const file = join(root, "input-" + index);
    writeFileSync(file, bytes, { flag: "wx" });
    const digest = run(executable, [file]).trim();
    ok(/^[0-9a-f]{16}$/u.test(digest));
    return { input: bytes.toString("base64"), digest };
  });
  deepStrictEqual(vectors, historical.vectors, "Native reference digests differ from retained original vectors.");
  save(values.output, {
    evidenceProfile:
      "Executed unmodified original public-domain x64-128 reference; seed zero; first word serialized big-endian by new explicit executable wrapper",
    sourceCommit: COMMIT,
    sources: SOURCES,
    wrapper: WRAPPER,
    wrapperSha256: sha(Buffer.from(WRAPPER)),
    compiler: version,
    architecture: process.arch,
    historicalFixtureSha256: sha(historicalBytes),
    commands,
    vectors,
  });
} catch (reason) {
  failures.push(reason);
} finally {
  try {
    rmSync(root, { recursive: true });
  } catch (reason) {
    failures.push(reason);
  }
}
if (failures.length === 1) throw failures[0];
if (failures.length) throw new AggregateError(failures, "Native hash reference and cleanup failed.");
