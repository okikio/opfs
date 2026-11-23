/**
 * Select the CI lanes a change needs.
 *
 * `node tools/ci/plan.ts [--base <sha> --head <sha> | --full]`
 *
 * OPFS is one package, so selection is coarse on purpose. A change to source, tests, tooling, dependencies or
 * workflows selects every lane whose tests exist at that revision; a change limited to Markdown and planning
 * records selects only the source checks, which lint documentation.
 *
 * ```text
 *   git diff base...head ─► plan() ─► lane booleans ─► GitHub job `if:` conditions
 *                                                    └► tools/ci/lane.ts in each job ─► mise tasks
 * ```
 *
 * Lanes are also the unit of the CI result cache (`.github/actions/result-cache`): a lane whose exact inputs
 * already passed on a trusted run skips its steps. That cache never decides which lanes are selected.
 *
 * @module
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { discover } from "../test/discover.ts";

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
 * revision, so a lane is never selected for tests that are not there yet. `full` selects every lane whose tests
 * exist, whatever changed; manual and release runs use it.
 */
export function plan(
  paths: readonly string[],
  families: ReadonlySet<string>,
  { full = false }: { readonly full?: boolean } = {},
): PlanType {
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

/** Write `key=value` step outputs for later jobs, or print them when run outside Actions. */
function writeOutput(values: Record<string, string>): void {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  else console.log(lines.join("\n"));
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { base: { type: "string" }, head: { type: "string" }, full: { type: "boolean", default: false } },
  });
  let paths: string[] = [];
  if (!values.full) {
    if (!values.base || !values.head) throw new TypeError("Pass --base and --head, or --full.");
    paths = execFileSync("git", ["diff", "--name-only", "-z", `${values.base}...${values.head}`], {
      cwd: root,
      encoding: "utf8",
    }).split("\0").filter(Boolean);
  }
  const families = new Set((await discover(root)).map((file) => file.family));
  const result = plan(paths, families, { full: values.full });
  console.log(JSON.stringify(result, null, 2));
  writeOutput(Object.fromEntries(Object.entries(result).map(([lane, value]) => [lane, String(value)])));
}
