/**
 * Run discovered benchmarks once each, as a correctness and smoke check.
 *
 * `node tools/bench/local.ts [--shard i/n] [--list] [bench/name.bench.ts ...]`
 *
 * Every `bench/*.bench.ts` file is a benchmark. Each one checks its result bytes before timing (see
 * `bench/result.ts`), so a run that finishes proves the measured code produced the expected output on that
 * runtime. With `BENCH_JSON=1` (set here) each file writes Mitata's JSON report to stdout, which this tool saves
 * under `.tmp/reports/bench/<name>.json`. CI keeps those reports; it does not compare timings, because shared
 * runners are too noisy for a pass/fail threshold.
 *
 * The runtime follows the file name: `deno*` and `memory` run on Deno, `bun*` on Bun, everything else on Node.js
 * with `--expose-gc`. Provider benchmarks need containers and run through `bench/providers.ts` instead.
 *
 * @module
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { shard } from "../test/discover.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Benchmarks that start provider or FUSE containers. `bench/providers.ts` owns them. */
const containers = new Set(["provider.bench.ts", "filesystem-provider.bench.ts", "bun-provider.bench.ts"]);

/** A discovered benchmark and the command that runs it once. */
export interface BenchType {
  readonly path: string;
  readonly command: readonly string[];
}

/** The command for one benchmark file, chosen by its name. */
export function createCommand(path: string): string[] {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name.startsWith("deno") || name === "memory.bench.ts") {
    return [
      "deno",
      "run",
      "--frozen",
      "--v8-flags=--expose-gc",
      ...(name.startsWith("deno-kv") ? ["--unstable-kv"] : []),
      "-A",
      path,
    ];
  }
  if (name.startsWith("bun")) return ["bun", "run", path];
  return ["node", "--expose-gc", path];
}

/** Every container-free benchmark under `bench/`, sorted. */
export function discover(base = root): BenchType[] {
  return readdirSync(`${base}/bench`)
    .filter((name) => name.endsWith(".bench.ts") && !containers.has(name))
    .sort()
    .map((name) => ({ path: `bench/${name}`, command: createCommand(`bench/${name}`) }));
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { shard: { type: "string" }, list: { type: "boolean" } },
  });
  let benches = discover();
  if (positionals.length) {
    const unknown = positionals.filter((path) => !benches.some((bench) => bench.path === path));
    if (unknown.length) throw new TypeError(`Not a discovered benchmark: ${unknown.join(", ")}`);
    benches = benches.filter((bench) => positionals.includes(bench.path));
  }
  if (values.shard) {
    const match = /^(\d+)\/(\d+)$/u.exec(values.shard);
    if (!match) throw new TypeError("Pass --shard as <index>/<total>, for example 2/3.");
    benches = shard(benches, Number(match[1]), Number(match[2]));
  }
  if (values.list) {
    for (const bench of benches) console.log(bench.command.join(" "));
  } else {
    const reports = `${root}/.tmp/reports/bench`;
    mkdirSync(reports, { recursive: true });
    const failed: string[] = [];
    for (const bench of benches) {
      const started = performance.now();
      const [program, ...args] = bench.command;
      const result = spawnSync(program!, args, {
        cwd: root,
        env: { ...process.env, BENCH_JSON: "1" },
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "inherit"],
      });
      const name = bench.path.slice("bench/".length, -".bench.ts".length);
      writeFileSync(`${reports}/${name}.json`, result.stdout ?? "");
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      console.log(`${result.status === 0 ? "ok    " : "FAILED"} ${bench.path} (${seconds} s)`);
      if (result.status !== 0) failed.push(bench.path);
    }
    if (failed.length) {
      console.error(`${failed.length} benchmark(s) failed:\n${failed.join("\n")}`);
      process.exitCode = 1;
    }
  }
}
