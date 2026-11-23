/**
 * Run one CI lane: the same mise tasks a contributor runs locally, in the order the lane needs them.
 *
 * `node tools/ci/lane.ts <lane> [--runtime deno|node|bun] [--shard <index>/<total>] [--kind providers|browser]`
 *
 * Each GitHub job that `tools/ci/plan.ts` selected calls this with its lane name, so a workflow never lists tasks of
 * its own. The source lane runs every check even after one fails and reports all failures together, so three
 * problems show up in one run instead of one per push. Every other lane stops at its first failure, because a
 * later step depends on an earlier one (browsers must be installed before browser tests run).
 *
 * @module
 */
import { existsSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { lanes, type LaneType } from "./plan.ts";
import { spawn } from "../spawn.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** One mise task and the arguments it receives after `--`. */
export interface StepType {
  readonly task: string;
  readonly args: readonly string[];
}

/** Lane inputs that come from the job's matrix. */
export interface LaneOptionsType {
  /** The runtime a `runtimes` or `platforms` job tests. Required for those lanes. */
  readonly runtime?: string | undefined;
  /** `<index>/<total>` for a sharded job; the task splits its discovered files the same way. */
  readonly shard?: string | undefined;
  /** For `bench`: `providers` and `browser` start their own containers or browsers, so they run alone. */
  readonly kind?: string | undefined;
}

const step = (task: string, ...args: string[]): StepType => ({ task, args });

/** The checks the source lane runs, in order. `check:planning` exists only once the storage plan is tracked. */
function getChecks(): StepType[] {
  return [
    "check:types",
    "check:format",
    "check:lint",
    "check:docs",
    "check:examples",
    "check:schema",
    "check:fixtures",
    "check:jsr",
    "check:exports",
    "check:versions",
    "check:tasks",
    "check:shell",
    "check:actions",
    "check:secrets",
    ...(existsSync(`${root}/planning/storage/research/validate.ts`) ? ["check:planning"] : []),
  ].map((task) => step(task));
}

/** The tasks one lane runs, in order. */
export function getSteps(lane: LaneType, options: LaneOptionsType = {}): StepType[] {
  const shard = options.shard ? ["--shard", options.shard] : [];
  switch (lane) {
    case "source":
      return getChecks();
    case "runtimes":
    case "platforms":
      if (!options.runtime) throw new TypeError(`The ${lane} lane needs --runtime deno|node|bun.`);
      // The source-retention regressions need GNU tar, so they run once, on the Linux Deno job.
      if (lane === "runtimes" && options.runtime === "deno" && !options.shard) {
        return [step("test:deno"), step("test:validation")];
      }
      return [step(`test:${options.runtime}`, ...shard)];
    case "browser":
      return [step("prepare:browser"), step("test:browser", ...shard)];
    case "providers":
      return [step("test:providers", ...shard)];
    case "interop":
      return [step("test:interop")];
    case "netlify":
      return [step("test:netlify")];
    case "package":
      return [step("check:package"), step("test:ecosystems")];
    case "bench":
      if (options.kind === "providers") return [step("bench:providers")];
      // CI benchmarks Chromium only, inside the job's 10-minute budget. Installing WebKit's system packages alone
      // can use most of it. `mise run bench:browser` with no arguments still runs every engine in the config.
      if (options.kind === "browser") {
        return [step("prepare:browser", "chromium"), step("bench:browser", "--project", "chromium")];
      }
      return [step("bench:local", ...shard)];
    case "stress":
      return [step("test:stress", ...shard), step("test:coverage")];
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { runtime: { type: "string" }, shard: { type: "string" }, kind: { type: "string" } },
  });
  const lane = positionals[0] as LaneType;
  if (!lanes.includes(lane)) throw new TypeError(`Name one lane: ${lanes.join(", ")}.`);
  const failed: string[] = [];
  for (const { task, args } of getSteps(lane, values)) {
    try {
      spawn("mise", ["run", task, ...(args.length ? ["--", ...args] : [])]);
    } catch (reason) {
      console.error((reason as Error).message);
      failed.push(task);
      if (lane !== "source") break;
    }
  }
  if (failed.length) {
    console.error(`Failed: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
}
