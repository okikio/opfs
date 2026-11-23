/**
 * Select CI lanes from a Git diff, and run one lane with the same tasks a contributor runs locally.
 *
 * `node tools/workspace/ci.ts plan [--base sha --head sha | --full]`
 * `node tools/workspace/ci.ts run --lane <name> [--runtime deno|node|bun] [--shard i/n] [--kind name]`
 *
 * OPFS is one package, so selection is coarse on purpose. A change to source, tests, tooling, dependencies or
 * workflows selects every lane whose tests exist at that revision; a change limited to Markdown and planning
 * records selects only the source checks, which lint documentation. An unknown path selects everything.
 *
 * ```text
 *   git diff base..head ─► plan() ─► lane booleans ─► GitHub job `if:` conditions
 *                                                    └► `run --lane` inside each job ─► mise tasks
 * ```
 *
 * Lanes are deliberately the unit of the CI result cache (`.github/actions/result-cache`): a lane whose exact
 * inputs already passed on a trusted run skips its steps. That cache never decides which lanes are selected.
 *
 * @module
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { discover } from "../testing/discover.ts";
import { spawn } from "./spawn.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Every lane the Quality workflow can run. The workflow has one job (or matrix) per lane. */
export const lanes = [
  "source",
  "runtimes",
  "platforms",
  "browser",
  "providers",
  "interop",
  "netlify",
  "package",
  "bench",
  "stress",
] as const;
/** One lane name, such as `"source"` or `"browser"`. */
export type LaneType = (typeof lanes)[number];

/** A plan: which lanes run. CI reads it from step outputs. */
export type PlanType = Readonly<Record<LaneType, boolean>>;

/** Paths whose change never affects runtime behavior: prose and planning records. */
const isProse = (path: string) => path.endsWith(".md") || path.startsWith("planning/");

/**
 * Select lanes for a set of changed paths. `families` says which optional test families exist at the head
 * revision, so a lane is never selected for tests that are not there yet.
 */
export function plan(paths: readonly string[], families: ReadonlySet<string>, full = false): PlanType {
  const code = full || paths.some((path) => !isProse(path));
  const selected = (lane: LaneType) => lane === "source" || code;
  return {
    source: true,
    runtimes: selected("runtimes"),
    platforms: selected("platforms"),
    browser: selected("browser"),
    providers: selected("providers") && families.has("provider"),
    interop: selected("interop") && families.has("interop"),
    netlify: selected("netlify") && families.has("netlify"),
    package: selected("package"),
    bench: selected("bench"),
    stress: selected("stress"),
  };
}

/**
 * Run one mise task; `args` go after `--` to the task's program. A failure also sets the exit code, so the CI step
 * fails even when {@link spawnChecks} catches the error to keep running the remaining checks.
 */
function spawnTask(name: string, ...args: string[]): void {
  try {
    spawn("mise", ["run", name, ...(args.length ? ["--", ...args] : [])]);
  } catch (reason) {
    process.exitCode = 1;
    throw reason;
  }
}

/**
 * Run every check in a lane, then report all failures together. A source lane with three problems shows all
 * three in one run instead of one per push.
 */
function spawnChecks(names: readonly string[]): void {
  const failed: string[] = [];
  for (const name of names) {
    try {
      spawnTask(name);
    } catch {
      failed.push(name);
    }
  }
  if (failed.length) throw new Error(`Failed checks: ${failed.join(", ")}`);
}

/** The commands for one lane. Exported for tests; `run()` executes them. */
export function createSteps(
  lane: LaneType,
  options: { runtime?: string; shard?: string; kind?: string },
): (() => void)[] {
  const shard = options.shard ? ["--shard", options.shard] : [];
  switch (lane) {
    case "source":
      return [() =>
        spawnChecks([
          "check:types",
          "check:format",
          "check:lint",
          "check:docs",
          "check:examples",
          "check:schema",
          "check:fixtures",
          "check:jsr",
          "check:versions",
          "check:tasks",
          "check:shell",
          "check:actions",
          "check:secrets",
          ...(existsSync(`${root}/planning/storage/research/validate.ts`) ? ["check:planning"] : []),
        ])];
    case "runtimes":
    case "platforms":
      if (!options.runtime) throw new TypeError(`The ${lane} lane needs --runtime deno|node|bun.`);
      // The source-retention regressions need GNU tar, so they run once, on the Linux Deno job.
      if (lane === "runtimes" && options.runtime === "deno" && !options.shard) {
        return [() => spawnTask("test:deno"), () => spawnTask("test:validation")];
      }
      return [() => spawnTask(`test:${options.runtime}`, ...shard)];
    case "browser":
      return [() => spawnTask("prepare:browser"), () => spawnTask("test:browser", ...shard)];
    case "providers":
      return [() => spawnTask("test:providers", ...shard)];
    case "interop":
      return [() => spawnTask("test:interop")];
    case "netlify":
      return [() => spawnTask("test:netlify")];
    case "package":
      return [() => spawnTask("check:package"), () => spawnTask("test:ecosystems")];
    case "bench":
      // Provider and browser benchmarks start their own containers or browsers; the rest share one runner.
      if (options.kind === "providers") return [() => spawnTask("bench:providers")];
      if (options.kind === "browser") {
        return [() => spawnTask("prepare:browser", "chromium"), () => spawnTask("bench:browser")];
      }
      return [() => spawnTask("bench:run", ...shard)];
    case "stress":
      return [() => spawnTask("test:stress", ...shard), () => spawnTask("test:coverage")];
  }
}

/** Write `key=value` step outputs, or print them when run outside Actions. */
function writeOutput(values: Record<string, string>): void {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  else console.log(lines.join("\n"));
}

if (import.meta.main) {
  const [command] = process.argv.slice(2);
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      base: { type: "string" },
      head: { type: "string" },
      full: { type: "boolean" },
      lane: { type: "string" },
      runtime: { type: "string" },
      shard: { type: "string" },
      kind: { type: "string" },
    },
  });
  if (command === "plan") {
    let paths: string[] = [];
    if (!values.full) {
      if (!values.base || !values.head) throw new TypeError("Pass --base and --head, or --full.");
      paths = execFileSync("git", ["diff", "--name-only", "-z", `${values.base}...${values.head}`], {
        cwd: root,
        encoding: "utf8",
      }).split("\0").filter(Boolean);
    }
    const families = new Set((await discover(root)).map((file) => file.family));
    const result = plan(paths, families, values.full ?? false);
    console.log(JSON.stringify(result, null, 2));
    writeOutput(Object.fromEntries(Object.entries(result).map(([lane, value]) => [lane, String(value)])));
  } else if (command === "run") {
    const lane = values.lane as LaneType;
    if (!lanes.includes(lane)) throw new TypeError(`Select one --lane: ${lanes.join(", ")}.`);
    for (const step of createSteps(lane, values)) step();
  } else {
    throw new TypeError("Usage: ci.ts plan [--base sha --head sha | --full] | run --lane <name>");
  }
}
