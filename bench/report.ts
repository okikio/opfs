import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { env, versions } from "node:process";
import { validateLifecycle, validateMitata } from "./validate.ts";
import { finish } from "./result.ts";
import { runProgram } from "./process.ts";
import { inputs as identity, verifyInputs } from "./input.ts";

/** Each invocation retains progress and failures in its own report directory. */
const root = join(".tmp", "reports", "bench", new Date().toISOString().replaceAll(":", "-"));
await mkdir(root, { recursive: true });
/** Node/Deno expose manual GC consistently; each workload deliberately selects once or inner collection. */
const programs = [
  ["memory", "node", ["--expose-gc", "bench/memory.bench.ts"]],
  ["node", "node", ["--expose-gc", "bench/node.bench.ts"]],
  ["deno", "deno", ["run", "--v8-flags=--expose-gc", "-A", "bench/deno.bench.ts"]],
  ["kv", "deno", ["run", "--v8-flags=--expose-gc", "--unstable-kv", "-A", "bench/deno-kv.bench.ts"]],
  ["sqlite", "node", ["--expose-gc", "bench/sqlite.bench.ts"]],
  ["bun", "bun", ["run", "bench/bun.bench.ts"]],
  ["lanes", "node", ["--expose-gc", "bench/lanes.bench.ts"]],
  ["lifecycle", "node", ["--expose-gc", "bench/lifecycle.bench.ts"]],
  ["providers", "node", ["--expose-gc", "bench/providers.ts"]],
] as const;
const selected = env.OPFS_BENCH_ONLY?.split(",");
if (selected?.some((name) => !programs.some(([known]) => known === name))) {
  throw new Error("OPFS_BENCH_ONLY contains an unknown benchmark name.");
}
/** Progress status never promotes partial or changed-source measurements to a completed result. */
const metadata = {
  version: 2,
  status: "running" as "running" | "pass" | "fail" | "invalid",
  createdAt: new Date().toISOString(),
  versions,
  gc: "manual collector exposed; default once after warmup, natural GC remains in timed work",
  os: {
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    cpus: cpus().length,
    memoryBytes: totalmem(),
  },
  inputs: {} as Record<string, string>,
  inputsAfter: undefined as Record<string, string> | undefined,
  failure: undefined as string | undefined,
  runs: [] as Array<
    {
      name: string;
      command: string;
      args: readonly string[];
      elapsedMs: number;
      report: string;
      stderr: string;
      status: "running" | "pass" | "fail";
      failure?: string | undefined;
    }
  >,
};
await save();
let failed = false;
let primary: unknown;
try {
  try {
    metadata.inputs = await identity();
    await save();
  } catch (error) {
    metadata.status = "invalid";
    throw error;
  }
  for (const [name, command, args] of programs) {
    if (selected !== undefined && !selected.includes(name)) continue;
    const report = join(root, `${name}.json`), stderrPath = join(root, `${name}.stderr`);
    const row = {
      name,
      command,
      args,
      elapsedMs: 0,
      report,
      stderr: stderrPath,
      status: "running" as "running" | "pass" | "fail",
      failure: undefined as string | undefined,
    };
    metadata.runs.push(row);
    await save();
    const start = performance.now();
    let rowFailed = false;
    let rowPrimary: unknown;
    try {
      const releases: Array<() => Promise<void>> = [];
      let failed = false;
      let primary: unknown;
      try {
        const stdout = await open(report, "wx");
        releases.push(() => stdout.close());
        const stderr = await open(stderrPath, "wx");
        releases.push(() => stderr.close());
        await runProgram(command, args, {
          env: { ...env, BENCH_JSON: "1", OPFS_BENCH_REPORT_DIR: root },
          stdio: ["inherit", stdout.fd, stderr.fd],
          // Providers owns two twenty-minute children and bounded service setup.
          timeoutMs: name === "providers" ? 60 * 60_000 : 20 * 60_000,
        });
      } catch (error) {
        failed = true;
        primary = error;
        throw error;
      } finally {
        await finish(releases, failed ? [primary] : []);
      }
      if (name === "providers") {
        // This orchestration program redirects child stdout. Its own empty file is intentional.
        for (const file of ["provider-node.json", "provider-bun.json"]) {
          validateMitata(JSON.parse(await readFile(join(root, file), "utf8")));
        }
      } else if (name === "lifecycle") {
        validateLifecycle(JSON.parse(await readFile(report, "utf8")));
      } else validateMitata(JSON.parse(await readFile(report, "utf8")));
      row.status = "pass";
      console.log(`Recorded ${name} in ${root}.`);
    } catch (error) {
      rowFailed = true;
      rowPrimary = error;
      row.status = "fail";
      row.failure = String(error);
      throw error;
    } finally {
      row.elapsedMs = performance.now() - start;
      await finish([save], rowFailed ? [rowPrimary] : []);
    }
  }
  try {
    metadata.inputsAfter = await identity();
    verifyInputs(metadata.inputs, metadata.inputsAfter);
  } catch (error) {
    metadata.status = "invalid";
    throw error;
  }
  metadata.status = "pass";
} catch (error) {
  failed = true;
  primary = error;
  if (metadata.status !== "invalid") metadata.status = "fail";
  metadata.failure = error instanceof Error ? error.stack ?? error.message : String(error);
  throw error;
} finally {
  await finish([saveFinal], failed ? [primary] : []);
}

/** A failed final evidence write never leaves an in-memory completed result. */
async function saveFinal(): Promise<void> {
  try {
    await save();
  } catch (error) {
    if (metadata.status !== "invalid") metadata.status = "fail";
    throw error;
  }
}
/** Persists progress before launch and after each completed or failed program. */
async function save(): Promise<void> {
  await writeFile(join(root, "meta.json"), JSON.stringify(metadata, null, 2) + "\n");
}
