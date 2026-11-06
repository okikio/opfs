/** Compile/run only SHA-admitted native MCAP C++ sources; preserve old Python receipts separately. */
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { check, digest, gitBlob, integer, json, output, record, safe, snapshot, text } from "../acquire.ts";
import { group } from "../group.ts";
import { verify } from "./crc.ts";
const { values } = parseArgs({
  options: {
    acquired: { type: "string" },
    output: { type: "string" },
    compiler: { type: "string", default: "/usr/bin/g++" },
  },
});
check(
  values.acquired && values.output && values.compiler && process.platform === "linux",
  "Usage: produce.ts --acquired INERT_DIRECTORY --output FRESH_DIRECTORY [--compiler /usr/bin/g++]",
);
function read(path: string, maximum: number): Buffer<ArrayBuffer> {
  check(statSync(path).size <= maximum, "Native input/output byte ceiling.");
  const bytes = readFileSync(path);
  check(bytes.length <= maximum, "Native file changed beyond cap.");
  return bytes;
}
const here = dirname(fileURLToPath(import.meta.url)),
  pin = record(JSON.parse(read(join(here, "upstream-cpp.json"), 65536).toString()));
check(
  pin.commit === "23d6c627a27ac089d418d9e7f8cdcef9ed86dac1" && Array.isArray(pin.files) && pin.files.length === 14,
  "Reviewed native source inventory.",
);
const acquired = resolve(values.acquired), compiler = resolve(values.compiler);
const files = pin.files;
check(Array.isArray(files), "Native source inventory must be an array.");
await output(values.output, async (root) => {
  const inputs: unknown[] = [], seen = new Set<string>(), include = join(root, "sdk/include");
  mkdirSync(include, { recursive: true });
  for (const value of files) {
    const item = record(value), path = safe(text(item.path)), expected = integer(item.bytes, 128 * 1024);
    check(!seen.has(path), "Duplicate native source pin.");
    seen.add(path);
    const bytes = read(join(acquired, "source", path + ".snapshot"), expected);
    check(bytes.length === expected && gitBlob(bytes) === item.gitBlob, "Native source byte/Git identity changed.");
    if (path === "LICENSE") snapshot(root, "licenses/MCAP-LICENSE.snapshot", bytes);
    else {
      check(path.startsWith("cpp/mcap/include/mcap/"), "Native include root changed.");
      snapshot(root, "sdk/include/" + path.slice("cpp/mcap/include/".length), bytes);
    }
    inputs.push({ path, bytes: bytes.length, gitBlob: item.gitBlob, sha256: digest(bytes) });
  }
  const work = join(root, "native-output");
  mkdirSync(work);
  const binary = join(root, "native-mcap"), source = join(here, "native.cpp");
  const compilerVersion = await group({
    command: compiler,
    args: ["--version"],
    log: join(root, "compiler-version.log"),
    seconds: 10,
    bytes: 65536,
  });
  json(root, "compiler-version.json", compilerVersion);
  check(
    compilerVersion.exit === 0 && compilerVersion.reason === null && compilerVersion.cleanupFaults.length === 0,
    "Compiler version receipt failed.",
  );
  const compilerResult = await group({
    command: "/bin/dash",
    args: [
      "-c",
      'ulimit -f 131072 || exit; exec "$@"',
      "opfs-mcap-compile",
      compiler,
      "-std=c++17",
      "-O2",
      "-Wall",
      "-Wextra",
      "-I",
      include,
      source,
      "-o",
      binary,
    ],
    log: join(root, "compile.log"),
    seconds: 60,
    bytes: 1024 * 1024,
  });
  json(root, "compile.json", compilerResult);
  check(
    compilerResult.exit === 0 && compilerResult.reason === null && compilerResult.cleanupFaults.length === 0 &&
      existsSync(binary),
    "Native MCAP compile failed.",
  );
  const execution = await group({
    command: "/bin/dash",
    args: ["-c", 'ulimit -f 512 || exit; exec "$@"', "opfs-mcap-native", binary, work],
    log: join(root, "producer.log"),
    seconds: 30,
    bytes: 1024 * 1024,
  });
  json(root, "producer-run.json", execution);
  check(
    execution.exit === 0 && execution.reason === null && execution.cleanupFaults.length === 0,
    "Native MCAP original-byte verification failed.",
  );
  const fixtures = ["chunked", "unchunked", "zero-summary", "empty"].map((name) => {
    const raw = read(join(work, name + ".mcap"), 256 * 1024), checked = verify(raw), empty = name === "empty";
    check(
      checked.scopes.filter((scope) => scope.kind === "attachment").length === (empty ? 0 : 1),
      "Enabled attachment checksum inventory.",
    );
    check(
      name === "chunked"
        ? checked.scopes.some((scope) => scope.kind === "chunk")
        : !checked.scopes.some((scope) => scope.kind === "chunk"),
      "Enabled chunk checksum inventory.",
    );
    const messages = empty ? [] : Array.from({ length: 7 }, (_, index) => {
      const data = Buffer.alloc(17 + index * 29);
      for (let j = 0; j < data.length; j++) data[j] = (j * 31 + index * 17) % 251;
      const timestamp = (1n << 63n) + BigInt(index) * 1001n;
      return {
        sequence: index % 3,
        logTime: timestamp.toString(),
        publishTime: (timestamp + 1n).toString(),
        data: data.toString("base64"),
      };
    });
    return {
      name,
      bytes: raw.length,
      sha256: digest(raw),
      data: raw.toString("base64"),
      messages,
      sequentialFullBytes: true,
      seekingFullBytes: true,
      seekingMode: name === "chunked"
        ? "native indexed log-time iteration"
        : "native file-order iteration; native summary fallback when absent",
      schemaFullBytes: !empty,
      attachmentFullBytes: !empty,
      metadataExact: !empty,
      nativeReaderValidatesCrc: false,
      independentZlibChecks: checked,
    };
  });
  const sources: Record<string, string> = {};
  for (const name of ["native.cpp", "produce.ts", "crc.ts", "../acquire.ts", "../group.ts"]) {
    sources[name] = digest(read(join(here, name), 65536));
  }
  const result = {
    producer: "MCAP C++2.2.0 at " + pin.commit,
    node: process.version,
    inputs,
    sources,
    nativeBinarySha256: digest(read(binary, 64 * 1024 * 1024)),
    fixtures,
    scope:
      "Native C++ writer and same-project sequential/seeking full-byte proof; authored framing with independent Node/zlib CRC checks and controls. Historical Python proof remains unchanged.",
  };
  const serialized = Buffer.from(JSON.stringify(result, null, 2) + "\n");
  check(serialized.length <= 4 * 1024 * 1024, "Native fixture JSON output ceiling.");
  snapshot(root, "independent.json", serialized);
});
