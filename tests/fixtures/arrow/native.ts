/** Compiles only authored native code against hash-admitted C++ artifacts. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verify } from "./admit.ts";
import { read, run, sha } from "./files.ts";
import type { CommandType } from "./files.ts";

export function prepare(
  artifacts: string,
  duckdb: boolean,
): {
  root: string;
  binary: string;
  artifacts: string;
  commands: CommandType[];
  sourceSha256: string;
  sources: Record<string, string>;
  close(): void;
} {
  const admitted = resolve(artifacts);
  verify(admitted, duckdb);
  const source = fileURLToPath(new URL("native.cpp", import.meta.url));
  const sourceSha256 = sha(read(source));
  const sources = Object.fromEntries(
    ["artifacts.ts", "files.ts", "admit.ts", "values.ts", "native.ts", "native.cpp", "runner.ts"].map((
      file,
    ) => [file, sha(read(fileURLToPath(new URL(file, import.meta.url))))]),
  );
  const root = mkdtempSync(join(tmpdir(), "opfs-arrow-native-")), binary = join(root, "native");
  const commands: CommandType[] = [];
  try {
    run([
      "c++",
      "-std=c++17",
      "-O1",
      "-Wall",
      "-Wextra",
      "-I",
      join(admitted, "include"),
      source,
      join(admitted, "libparquet.so.2000"),
      join(admitted, "libarrow.so.2000"),
      `-Wl,-rpath,${admitted}`,
      "-o",
      binary,
    ], commands);
    return {
      root,
      binary,
      artifacts: admitted,
      commands,
      sourceSha256,
      sources,
      close: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (reason) {
    rmSync(root, { recursive: true, force: true });
    throw reason;
  }
}
